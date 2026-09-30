//! Fixed owner-only contribution review transport. Gateway owns authority;
//! Harness owns immutable candidates. This native view never talks to Host,
//! creates a grant, signs a message, or carries a runtime credential.
use super::{
    community::Configuration, enabled, invalidate_connection_view, native_scope, oauth, SpacesAuth,
    SpacesCommunity,
};
use crate::app_state::AppState;
use reqwest::{Client, RequestBuilder};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::Duration;
use zeroize::Zeroizing;

const WORK_RELEASE_ENABLED: bool = false;
const LIMIT: usize = 1_048_576;
const CONTENT_LIMIT: usize = 32_000;
const RECORD_LIMIT: usize = 100;
const ACCESS_LOST: &str = "Your access changed. Reopen the thread to check your contribution.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    AccessLost,
    Unavailable,
    Conflict,
    Invalid,
    Uncertain,
}
impl Failure {
    fn public(self) -> CommandResult {
        match self {
            Self::AccessLost => CommandResult::AccessLost,
            Self::Conflict => CommandResult::Conflict,
            Self::Uncertain => CommandResult::Uncertain,
            _ => CommandResult::Unavailable,
        }
    }
}
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum CommandResult {
    Unsupported,
    AccessLost,
    Unavailable,
    Conflict,
    Uncertain,
    Ready {
        #[serde(flatten)]
        identity: Identity,
        #[serde(skip_serializing_if = "Option::is_none")]
        lookup: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        release: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        preview: Option<Value>,
    },
    Confirmed {
        #[serde(flatten)]
        identity: Identity,
        result: Value,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Identity {
    scope_token: String,
    principal_id: String,
    organisation_id: String,
    pending_decisions: std::collections::BTreeMap<String, DecisionInput>,
    previews: std::collections::BTreeMap<String, Value>,
}

async fn response<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, Failure> {
    let mut response = request
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| Failure::Unavailable)?;
    match response.status().as_u16() {
        401 | 403 | 404 => return Err(Failure::AccessLost),
        409 => return Err(Failure::Conflict),
        200..=299 => (),
        _ => return Err(Failure::Unavailable),
    }
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(Failure::Invalid);
    }
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Unavailable)? {
        if body.len().saturating_add(chunk.len()) > LIMIT {
            return Err(Failure::Invalid);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| Failure::Invalid)
}

// Native PKCE session, current relay configuration and signer are independent
// checks. No renderer actor ID or identity inside a release is trusted here.
async fn verify_session(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    current: &impl Fn() -> Result<(), Failure>,
) -> Result<(), Failure> {
    current()?;
    session.validate().map_err(|_| Failure::AccessLost)?;
    expected
        .config
        .validate(session)
        .map_err(|_| Failure::AccessLost)?;
    let me: Value = response(
        client
            .get(format!("{gateway}/v1/me"))
            .bearer_auth(&session.access_token),
    )
    .await?;
    current()?;
    if me["identity"]["id"] != session.identity_id
        || me["identity"]["org_id"] != session.org_id
        || me["identity"]["type"] != "user"
        || me["identity"]["email_verified"] != true
    {
        return Err(Failure::AccessLost);
    }
    let value: Value = response(
        client
            .get(format!("{gateway}/v1/space/buzz/config"))
            .header("X-Axis-Buzz-Environment", "alpha")
            .bearer_auth(&session.access_token),
    )
    .await?;
    current()?;
    if value["enabled"] != true || value["pubkey"] != expected.keys.public_key().to_hex() {
        return Err(Failure::AccessLost);
    }
    let config: Configuration = serde_json::from_value(value).map_err(|_| Failure::Invalid)?;
    config.validate(session).map_err(|_| Failure::AccessLost)?;
    if config != expected.config {
        return Err(Failure::AccessLost);
    }
    Ok(())
}
async fn capability(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
) -> Result<bool, Failure> {
    let v: Value = response(
        client
            .get(format!("{gateway}/v1/space/work-releases/capabilities"))
            .bearer_auth(&session.access_token),
    )
    .await?;
    if v["schemaVersion"] != 1 || !v["publicationEnabled"].is_boolean() {
        return Err(Failure::Invalid);
    }
    v["enabled"].as_bool().ok_or(Failure::Invalid)
}
fn identifier(v: &str) -> bool {
    !v.is_empty()
        && v != "."
        && v != ".."
        && v.len() <= 256
        && v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b':' | b'.'))
}
fn digest(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str, Failure> {
    v.get(key).and_then(Value::as_str).ok_or(Failure::Invalid)
}
fn number(v: &Value, key: &str) -> Result<u64, Failure> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n < 9_007_199_254_740_990)
        .ok_or(Failure::Invalid)
}
fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn scope_token(expected: &native_scope::Scope) -> String {
    hash(
        json!([
            expected.generation,
            expected.config.org_id,
            expected.config.identity_id,
            expected.config.tenant_id,
            expected.config.relay_url,
            expected.config.relay_pubkey,
            expected.keys.public_key().to_hex()
        ])
        .to_string()
        .as_bytes(),
    )
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadInput {
    client_id: String,
    channel_id: String,
    root_event_id: String,
    admission_request_id: Option<String>,
    expected_scope_token: Option<String>,
    expected_relay_url: String,
    expected_signer_pubkey: String,
}
impl ThreadInput {
    fn validate(&self, expected: &native_scope::Scope) -> Result<(), Failure> {
        if !identifier(&self.client_id)
            || !identifier(&self.channel_id)
            || !digest(&self.root_event_id)
            || self
                .admission_request_id
                .as_deref()
                .is_some_and(|v| !identifier(v))
            || self
                .expected_scope_token
                .as_deref()
                .is_some_and(|v| v != scope_token(expected))
            || self.expected_relay_url
                != expected.config.relay_url.replacen("https://", "wss://", 1)
            || self.expected_signer_pubkey != expected.keys.public_key().to_hex()
        {
            return Err(Failure::AccessLost);
        }
        Ok(())
    }
    fn origin(&self, expected: &native_scope::Scope) -> Value {
        json!({"orgId":expected.config.org_id,"tenantId":expected.config.tenant_id,"relayUrl":expected.config.relay_url,"relayPubkey":expected.config.relay_pubkey,"channelId":self.channel_id,"rootEventId":self.root_event_id})
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadInput {
    #[serde(flatten)]
    thread: ThreadInput,
    release_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DecisionInput {
    operation_id: String,
    expected_version: u64,
    terms_digest: String,
    payload_digest: String,
    decision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecideInput {
    #[serde(flatten)]
    read: ReadInput,
    #[serde(flatten)]
    decision: DecisionInput,
}
enum Action<'a> {
    Query(&'a ThreadInput),
    Read(&'a ReadInput),
    Preview(&'a ReadInput),
    Decide(&'a DecideInput),
}
impl Action<'_> {
    fn thread(&self) -> &ThreadInput {
        match self {
            Self::Query(v) => v,
            Self::Read(v) | Self::Preview(v) => &v.thread,
            Self::Decide(v) => &v.read.thread,
        }
    }
    fn id(&self) -> Option<&str> {
        match self {
            Self::Query(_) => None,
            Self::Read(v) | Self::Preview(v) => Some(&v.release_id),
            Self::Decide(v) => Some(&v.read.release_id),
        }
    }
    fn validate(&self, expected: &native_scope::Scope) -> Result<(), Failure> {
        self.thread().validate(expected)?;
        if self.id().is_some_and(|id| !identifier(id))
            || (self.id().is_some() && self.thread().expected_scope_token.is_none())
        {
            return Err(Failure::AccessLost);
        }
        if let Self::Decide(v) = self {
            if !identifier(&v.decision.operation_id)
                || !digest(&v.decision.terms_digest)
                || !digest(&v.decision.payload_digest)
                || v.decision.expected_version == 0
                || !matches!(
                    v.decision.decision.as_str(),
                    "approve" | "decline" | "revoke"
                )
            {
                return Err(Failure::Invalid);
            }
        }
        Ok(())
    }
}
fn expiry(record: &Value) -> Result<chrono::DateTime<chrono::FixedOffset>, Failure> {
    chrono::DateTime::parse_from_rfc3339(string(&record["terms"], "expiresAt")?)
        .map_err(|_| Failure::Invalid)
}
fn active(record: &Value) -> bool {
    matches!(record["state"].as_str(), Some("pending" | "approved"))
        && expiry(record).is_ok_and(|at| at > chrono::Utc::now())
}
fn validate_record(
    v: &Value,
    expected: &native_scope::Scope,
    thread: &ThreadInput,
    work_id: &str,
) -> Result<(), Failure> {
    let t = &v["terms"];
    let c = &t["candidate"];
    let task = &c["task"];
    if t["ownerId"] != expected.config.identity_id
        || t["orgId"] != expected.config.org_id
        || t["destination"] != thread.origin(expected)
        || task["workId"] != work_id
    {
        return Err(Failure::AccessLost);
    }
    if !identifier(string(v, "id")?)
        || !digest(string(v, "termsDigest")?)
        || t["schemaVersion"] != 1
        || !v["publicationEnabled"].is_boolean()
        || !matches!(
            v["state"].as_str(),
            Some(
                "pending"
                    | "approved"
                    | "declined"
                    | "revoked"
                    | "expired"
                    | "stale"
                    | "publishing"
                    | "unknown"
                    | "delivered"
            )
        )
        || c["mediaType"] != "text/markdown"
        || number(c, "byteLength")? > CONTENT_LIMIT as u64
        || task["requesterId"] != t["initiatorId"]
        || !digest(string(&t["originalSource"], "eventId")?)
        || !digest(string(&t["originalSource"], "pubkey")?)
        || !digest(string(t, "payloadDigest")?)
        || !digest(string(t, "publicationMaterialDigest")?)
        || !digest(string(t, "agentPubkey")?)
        || !digest(string(c, "contentDigest")?)
    {
        return Err(Failure::Invalid);
    }
    number(v, "version")?;
    number(c, "version")?;
    number(t, "accountVersion")?;
    for key in [
        "orgId",
        "ownerId",
        "initiatorId",
        "applicationId",
        "workloadIdentityId",
        "accountId",
        "connectionId",
        "publicationOperationId",
    ] {
        if !identifier(string(t, key)?) {
            return Err(Failure::Invalid);
        }
    }
    if !identifier(string(c, "candidateId")?) {
        return Err(Failure::Invalid);
    }
    for key in [
        "workId",
        "requestId",
        "requesterId",
        "agentId",
        "conversationId",
        "sessionId",
    ] {
        if !identifier(string(task, key)?) {
            return Err(Failure::Invalid);
        }
    }
    number(task, "authorizationEpoch")?;
    if task["bindingVersion"] != 1
        || task["audienceVersion"] != 1
        || !digest(string(task, "audienceDigest")?)
    {
        return Err(Failure::Invalid);
    }
    let e = &c["execution"];
    if !identifier(string(e, "id")?)
        || !identifier(string(e, "consentId")?)
        || !digest(string(e, "termsDigest")?)
    {
        return Err(Failure::Invalid);
    }
    number(e, "consentVersion")?;
    let disclosure = &t["disclosure"];
    let material = &t["publicationMaterial"];
    if disclosure["predicate"] != "buzz-native-public-realm-v1"
        || disclosure["tenantId"] != expected.config.tenant_id
        || disclosure["relayOrigin"] != expected.config.relay_url
        || disclosure["relayPubkey"] != expected.config.relay_pubkey
        || disclosure["channelId"] != thread.channel_id
        || disclosure["threadRootId"] != thread.root_event_id
        || disclosure["sourceEventId"] != t["originalSource"]["eventId"]
        || material["origin"] != expected.config.relay_url
        || material["relay_pubkey"] != expected.config.relay_pubkey
        || material["channel_id"] != thread.channel_id
        || material["root_event_id"] != thread.root_event_id
        || material["publisher_pubkey"] != t["agentPubkey"]
        || material["reader_policy"]["http_auth"] != true
        || material["reader_policy"]["websocket_auth"] != true
        || material["reader_policy"]["realm_membership"] != true
        || material["reader_policy"]["mesh"] != false
        || !material["reader_policy"]["owner_delegation"].is_boolean()
        || disclosure["readers"]
            != if material["reader_policy"]["owner_delegation"] == true {
                "admitted-realm-members-and-owner-delegated-agents"
            } else {
                "admitted-realm-members"
            }
        || t["payloadTags"]
            != json!([
                ["h", thread.channel_id],
                ["e", thread.root_event_id, "", "root"],
                ["e", thread.root_event_id, "", "reply"],
                ["axis-reviewed", "1"]
            ])
    {
        return Err(Failure::Invalid);
    }
    let created = chrono::DateTime::parse_from_rfc3339(string(v, "createdAt")?)
        .map_err(|_| Failure::Invalid)?;
    let expires = expiry(v)?;
    if expires <= created || expires - created > chrono::Duration::hours(24) {
        return Err(Failure::Invalid);
    }
    Ok(())
}
fn payload_digest(record: &Value, content: &str) -> Result<String, Failure> {
    let tags = record["terms"]["payloadTags"]
        .as_array()
        .ok_or(Failure::Invalid)?;
    let mut framed = Vec::new();
    let mut append = |s: &str| {
        framed.extend_from_slice(s.len().to_string().as_bytes());
        framed.push(b':');
        framed.extend_from_slice(s.as_bytes());
    };
    for s in [
        "axis.buzz.selected-output.v1",
        "9",
        string(&record["terms"], "agentPubkey")?,
        content,
        &tags.len().to_string(),
    ] {
        append(s);
    }
    for tag in tags {
        let tag = tag.as_array().ok_or(Failure::Invalid)?;
        append(&tag.len().to_string());
        for field in tag {
            append(field.as_str().ok_or(Failure::Invalid)?);
        }
    }
    Ok(hash(&framed))
}
fn validate_preview(v: &Value, record: &Value) -> Result<(), Failure> {
    let body = string(v, "markdown")?;
    if v["release"] != *record
        || v["candidate"] != record["terms"]["candidate"]
        || !active(record)
        || body.is_empty()
        || body.len() > CONTENT_LIMIT
        || body.len() as u64 != number(&v["candidate"], "byteLength")?
        || hash(body.as_bytes()) != string(&v["candidate"], "contentDigest")?
        || payload_digest(record, body)? != string(&record["terms"], "payloadDigest")?
    {
        return Err(Failure::Invalid);
    }
    Ok(())
}

// This first native review does not visualize hidden direction/control marks.
// Preserve the immutable bytes for a truthful unavailable state, but never let
// them satisfy the native approval prerequisite. Ordinary RTL text is supported.
fn reviewable_text(body: &str) -> bool {
    !body.chars().any(|c| {
        (c.is_control() && c != '\n' && c != '\t')
            || matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    })
}

#[path = "work_release_operations.rs"]
mod operations;
pub(crate) use operations::SpacesWorkRelease;
#[path = "work_release_commands.rs"]
pub(crate) mod commands;

async fn perform(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    action: &Action<'_>,
    operations: &SpacesWorkRelease,
    current: &impl Fn() -> Result<(), Failure>,
) -> Result<CommandResult, Failure> {
    let cache_revision = operations.revision(expected)?;
    verify_session(client, session, gateway, expected, current).await?;
    if !capability(client, session, gateway).await? {
        return Ok(CommandResult::Unsupported);
    }
    current()?;
    let thread = action.thread();
    let mut query = json!({"origin":thread.origin(expected)});
    if let Some(id) = &thread.admission_request_id {
        query["admissionRequestId"] = json!(id);
    }
    let lookup: Value = response(
        client
            .post(format!("{gateway}/v1/space/work-releases/query"))
            .bearer_auth(&session.access_token)
            .json(&query),
    )
    .await?;
    current()?;
    let work = string(&lookup, "workId")?;
    if !identifier(work) || !lookup["truncated"].is_boolean() {
        return Err(Failure::Invalid);
    }
    let records = lookup["releases"]
        .as_array()
        .filter(|v| v.len() <= RECORD_LIMIT)
        .ok_or(Failure::Invalid)?;
    let mut ids = std::collections::BTreeSet::new();
    for record in records {
        validate_record(record, expected, thread, work)?;
        if !ids.insert(string(record, "id")?) {
            return Err(Failure::Invalid);
        }
    }
    // A fresh owner lookup precedes returning any cached selected bytes.
    verify_session(client, session, gateway, expected, current).await?;
    current()?;
    operations.observe(expected, thread, records, lookup["truncated"] == false)?;
    if matches!(action, Action::Query(_)) {
        return Ok(CommandResult::Ready {
            identity: operations.identity(expected, records)?,
            lookup: Some(lookup),
            release: None,
            preview: None,
        });
    }
    let id = action.id().ok_or(Failure::Invalid)?;
    let found = records
        .iter()
        .find(|r| r["id"] == id)
        .ok_or(Failure::AccessLost)?;
    let route = format!("{gateway}/v1/space/work-releases/{id}");
    let record: Value = response(client.get(&route).bearer_auth(&session.access_token)).await?;
    current()?;
    validate_record(&record, expected, thread, work)?;
    if record["id"] != id
        || record["termsDigest"] != found["termsDigest"]
        || record["version"] != found["version"]
    {
        return Err(Failure::Conflict);
    }
    operations.observe(expected, thread, std::slice::from_ref(&record), false)?;
    let mut preview = None;
    let mut result = None;
    match action {
        Action::Preview(_) => {
            if !active(&record) {
                return Err(Failure::AccessLost);
            }
            let value: Value = response(
                client
                    .get(format!("{route}/preview"))
                    .bearer_auth(&session.access_token),
            )
            .await?;
            current()?;
            validate_preview(&value, &record)?;
            preview = Some(value);
        }
        Action::Decide(input) => {
            let intent = &input.decision;
            if record["version"] != intent.expected_version
                || record["termsDigest"] != intent.terms_digest
                || record["terms"]["payloadDigest"] != intent.payload_digest
            {
                return Err(Failure::Conflict);
            }
            let stopping_expired = intent.decision == "revoke"
                && matches!(record["state"].as_str(), Some("expired" | "stale"));
            if (!active(&record) && !stopping_expired)
                || (intent.decision == "approve"
                    && (record["publicationEnabled"] != true
                        || record["state"] != "pending"
                        || !operations.reviewed(expected, &record)?))
            {
                return Err(Failure::Conflict);
            }
            // Native journal is the original exact intent after lost replies.
            let intent = operations.reserve(expected, id, intent)?;
            current()?;
            let write: Result<Value, Failure> = response(
                client
                    .post(format!("{route}/decisions"))
                    .bearer_auth(&session.access_token)
                    .json(&intent),
            )
            .await;
            let value = match write {
                Ok(value) => value,
                Err(Failure::AccessLost) => return Err(Failure::AccessLost),
                Err(Failure::Conflict) => {
                    operations.rejected(expected, id, &intent.operation_id)?;
                    return Err(Failure::Conflict);
                }
                Err(_) => return Err(Failure::Uncertain),
            };
            current()?;
            validate_record(&value["release"], expected, thread, work)?;
            let receipt = &value["receipt"];
            if value["release"]["id"] != id
                || value["release"]["termsDigest"] != intent.terms_digest
                || receipt["actorId"] != expected.config.identity_id
                || receipt["releaseId"] != id
                || receipt["operationId"] != intent.operation_id
                || receipt["termsDigest"] != intent.terms_digest
                || receipt["payloadDigest"] != intent.payload_digest
                || receipt["decision"] != intent.decision
                || number(receipt, "version")? > number(&value["release"], "version")?
                || !identifier(string(receipt, "receiptId")?)
            {
                return Err(Failure::Uncertain);
            }
            result = Some(value);
        }
        _ => (),
    }
    verify_session(client, session, gateway, expected, current).await?;
    current()?;
    if let Some(value) = result {
        operations.observe(
            expected,
            thread,
            std::slice::from_ref(&value["release"]),
            false,
        )?;
        operations.rejected(expected, id, string(&value["receipt"], "operationId")?)?;
        return Ok(CommandResult::Confirmed {
            identity: operations.identity(expected, std::slice::from_ref(&value["release"]))?,
            result: value,
        });
    }
    if let Some(value) = &preview {
        operations.cache(expected, value, cache_revision)?;
    }
    Ok(CommandResult::Ready {
        identity: operations.identity(expected, std::slice::from_ref(&record))?,
        lookup: None,
        release: Some(record),
        preview,
    })
}

#[cfg(test)]
#[path = "work_release_tests.rs"]
mod tests;
