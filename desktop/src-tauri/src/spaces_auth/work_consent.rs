//! Owner-private, bounded work-consent requests. These fixed Gateway routes do
//! not send chat, call Host, create grants directly or infer task execution.
use super::{
    community::Configuration, enabled, invalidate_connection_view, native_scope, oauth, SpacesAuth,
    SpacesCommunity,
};
use crate::app_state::AppState;
use reqwest::{Client, RequestBuilder};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;
use zeroize::Zeroizing;

const LIMIT: usize = 1_048_576;
const REQUEST_LIMIT: usize = 100;
const PARTICIPANT_LIMIT: usize = 128;
const ACCESS_LOST: &str = "Your account access changed. Reconnect to review this request.";
const UNAVAILABLE: &str = "This request could not be checked. Try again.";
const UNCERTAIN: &str =
    "Your decision could not be confirmed. Check its status before deciding again.";
const CHANGED: &str = "This request changed. Review the current details before deciding.";
// Default-off source candidate. Alpha identity and current Gateway capability
// remain mandatory; this feature never enables contribution release.
const WORK_CONSENT_ENABLED: bool = cfg!(feature = "spaces-work-consent-candidate");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    AccessLost,
    Unavailable,
    Conflict,
    Invalid,
    Uncertain,
    NotReady,
}

async fn response<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, Failure> {
    let mut response = request
        .header("Cache-Control", "no-store")
        .header("X-Axis-Buzz-Environment", "alpha")
        .send()
        .await
        .map_err(|_| Failure::Unavailable)?;
    let not_ready = response.status().as_u16() == 424;
    match response.status().as_u16() {
        401 | 403 | 404 => return Err(Failure::AccessLost),
        409 => return Err(Failure::Conflict),
        424 => (),
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
    if not_ready {
        let value: serde_json::Value = serde_json::from_slice(&body).map_err(|_| Failure::Unavailable)?;
        return Err(if value == serde_json::json!({"error":"work_consent_execution_unavailable"}) { Failure::NotReady } else { Failure::Unavailable });
    }
    serde_json::from_slice(&body).map_err(|_| Failure::Invalid)
}

#[derive(Deserialize)]
struct Me {
    identity: Person,
}
#[derive(Deserialize)]
struct Person {
    id: String,
    org_id: String,
    #[serde(rename = "type")]
    kind: String,
    email_verified: bool,
}

// Current config/key and human are checked independently of any renderer claim.
// No catalog or private account inventory is fetched here.
async fn verify_session(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    current: &impl Fn() -> Result<(), Failure>,
) -> Result<display::Directory, Failure> {
    current()?;
    session.validate().map_err(|_| Failure::AccessLost)?;
    expected
        .config
        .validate(session)
        .map_err(|_| Failure::AccessLost)?;
    let me: Me = response(
        client
            .get(format!("{gateway}/v1/me"))
            .bearer_auth(&session.access_token),
    )
    .await?;
    current()?;
    if me.identity.id != session.identity_id
        || me.identity.org_id != session.org_id
        || me.identity.kind != "user"
        || !me.identity.email_verified
    {
        return Err(Failure::AccessLost);
    }
    let value: serde_json::Value = response(
        client
            .get(format!("{gateway}/v1/space/buzz/config"))
            .bearer_auth(&session.access_token),
    )
    .await?;
    current()?;
    if value.get("enabled").and_then(|value| value.as_bool()) != Some(true)
        || value.get("pubkey").and_then(|value| value.as_str())
            != Some(expected.keys.public_key().to_hex().as_str())
    {
        return Err(Failure::AccessLost);
    }
    let config: Configuration =
        serde_json::from_value(value.clone()).map_err(|_| Failure::Invalid)?;
    config.validate(session).map_err(|_| Failure::AccessLost)?;
    if config != expected.config {
        return Err(Failure::AccessLost);
    }
    serde_json::from_value(value).map_err(|_| Failure::Invalid)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadInput {
    client_id: String,
    channel_id: String,
    root_event_id: String,
    admission_request_id: Option<String>,
    before: Option<Cursor>,
    expected_scope_token: Option<String>,
    expected_relay_url: String,
    expected_signer_pubkey: String,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b':' | b'.'))
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
impl ThreadInput {
    fn validate(&self, expected: &native_scope::Scope) -> Result<(), Failure> {
        let relay = expected.config.relay_url.replacen("https://", "wss://", 1);
        if !identifier(&self.channel_id)
            || !digest(&self.root_event_id)
            || !identifier(&self.client_id)
            || self
                .admission_request_id
                .as_deref()
                .is_some_and(|id| !identifier(id))
            || self
                .before
                .as_ref()
                .is_some_and(|cursor| !timestamp(&cursor.created_at) || !identifier(&cursor.id))
            || self
                .expected_scope_token
                .as_ref()
                .is_some_and(|token| *token != scope_token(expected))
            || (self.before.is_some() && self.expected_scope_token.is_none())
            || self.expected_relay_url != relay
            || self.expected_signer_pubkey != expected.keys.public_key().to_hex()
        {
            return Err(Failure::AccessLost);
        }
        Ok(())
    }
}

#[path = "work_consent_contract.rs"]
mod contract;
use contract::*;
#[path = "work_consent_display.rs"]
mod display;

#[path = "work_consent_intent_contract.rs"]
mod intent_contract;
use intent_contract::*;
#[path = "work_consent_intent.rs"]
mod intent;
#[path = "work_consent_task_status.rs"]
pub(crate) mod task_status;

fn version(value: u64) -> bool {
    value > 0 && value < 9_007_199_254_740_990
}
fn timestamp(value: &str) -> bool {
    value.ends_with('Z') && chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
fn validate_task(task: &Task, audience: &Audience) -> Result<(), Failure> {
    if [
        &task.work_id,
        &task.request_id,
        &task.requester_id,
        &task.agent_id,
        &task.conversation_id,
        &task.session_id,
    ]
    .iter()
    .any(|v| !identifier(v))
        || task.binding_version != 1
        || !version(task.authorization_epoch)
        || audience.version != 1
        || !digest(&audience.digest)
        || !digest(&audience.revision)
        || task.audience_version != audience.version
        || task.audience_digest != audience.digest
    {
        return Err(Failure::Invalid);
    }
    Ok(())
}
fn validate_duration(created_at: &str, expires_at: &str) -> Result<(), Failure> {
    if !timestamp(created_at) || !timestamp(expires_at) {
        return Err(Failure::Invalid);
    }
    let created = chrono::DateTime::parse_from_rfc3339(created_at).map_err(|_| Failure::Invalid)?;
    let expires = chrono::DateTime::parse_from_rfc3339(expires_at).map_err(|_| Failure::Invalid)?;
    if expires <= created || expires - created > chrono::Duration::hours(24) {
        return Err(Failure::Invalid);
    }
    Ok(())
}
fn validate_scope(s: &AccountScope) -> Result<(), Failure> {
    let day = s.selection == "day_meetings";
    if !timestamp(&s.meeting_start)
        || !timestamp(&s.meeting_end)
        || s.mechanics_version != if day { 2 } else { 1 }
        || s.max_provider_calls == 0
        || s.max_provider_calls > 128
        || s.max_bytes == 0
        || s.max_bytes > 16_777_216
        || (s.allow_recording_time_probes
            && (s.max_probe_pages_per_note == 0 || s.max_probe_pages_per_note > 8))
        || (!s.allow_recording_time_probes && s.max_probe_pages_per_note != 0)
        || (s.include_transcript
            && (s.max_transcript_pages_per_note == 0 || s.max_transcript_pages_per_note > 32))
        || (!s.include_transcript && s.max_transcript_pages_per_note != 0)
        || ((s.selection == "latest_meetings" || day) && !s.allow_recording_time_probes)
        || s.time_zone.is_empty()
        || s.time_zone.len() > 128
        || !matches!(s.selection.as_str(), "latest_meetings" | "exact_notes" | "day_meetings")
        || s.max_notes == 0
        || s.max_notes > if day { 150 } else { 2 }
        || s.max_list_pages == 0
        || s.max_list_pages > 5
        || s.page_size == 0
        || s.page_size > 30
        || s.note_ids.len() > 100
        || s.note_ids.iter().any(|v| !identifier(v))
        || s.allowed_tools != ["list_notes", "get_note"]
        || ((s.selection == "latest_meetings" || day) && !s.note_ids.is_empty())
        || (s.selection == "exact_notes"
            && (s.note_ids.is_empty()
                || s.note_ids.len() > s.max_notes as usize
                || s.note_ids.windows(2).any(|pair| pair[0] >= pair[1])
                || s.note_ids.iter().any(|id| {
                    !id.strip_prefix("not_").is_some_and(|suffix| {
                        suffix.len() == 14 && suffix.bytes().all(|c| c.is_ascii_alphanumeric())
                    })
                })))
    {
        return Err(Failure::Invalid);
    }
    let start =
        chrono::DateTime::parse_from_rfc3339(&s.meeting_start).map_err(|_| Failure::Invalid)?;
    let end = chrono::DateTime::parse_from_rfc3339(&s.meeting_end).map_err(|_| Failure::Invalid)?;
    if end <= start || end - start > chrono::Duration::hours(if day { 25 } else { 24 }) {
        return Err(Failure::Invalid);
    }
    Ok(())
}
fn validate_record(value: &Record, expected: &native_scope::Scope) -> Result<(), Failure> {
    let t = &value.terms;
    if t.org_id != expected.config.org_id
        || t.grantor_id != expected.config.identity_id
        || t.output_audience.owner_id != expected.config.identity_id
    {
        return Err(Failure::AccessLost);
    }
    if !identifier(&value.id)
        || !digest(&value.terms_digest)
        || !version(value.version)
        || value.execution_enabled
        || t.output_audience.kind != "private_contribution"
        || t.sharing != "owner_review_required"
        || t.provider != "granola"
        || [
            &t.application_id,
            &t.workload_identity_id,
            &t.account_id,
            &t.connection_id,
        ]
        .iter()
        .any(|v| !identifier(v))
        || !version(t.account_version)
        || t.task_summary.is_empty()
        || t.task_summary.len() > 512
    {
        return Err(Failure::Invalid);
    }
    validate_task(&t.task, &t.audience)?;
    validate_scope(&t.scope)?;
    validate_duration(&value.created_at, &t.expires_at)
}

fn scope_token(expected: &native_scope::Scope) -> String {
    use sha2::{Digest, Sha256};
    let metadata = serde_json::json!([
        expected.generation,
        expected.config.org_id,
        expected.config.identity_id,
        expected.config.tenant_id,
        expected.config.relay_url,
        expected.config.relay_pubkey,
        expected.keys.public_key().to_hex(),
    ]);
    hex::encode(Sha256::digest(metadata.to_string().as_bytes()))
}

fn lookup_body(
    expected: &native_scope::Scope,
    input: &ThreadInput,
) -> Result<serde_json::Value, Failure> {
    let mut body = serde_json::json!({
        "origin": {"orgId":expected.config.org_id,"tenantId":expected.config.tenant_id,
            "relayUrl":expected.config.relay_url,"relayPubkey":expected.config.relay_pubkey,
            "channelId":input.channel_id,"rootEventId":input.root_event_id},
    });
    if let Some(id) = &input.admission_request_id {
        body["admissionRequestId"] = serde_json::json!(id);
    }
    if let Some(before) = &input.before {
        body["before"] = serde_json::to_value(before).map_err(|_| Failure::Invalid)?;
    }
    Ok(body)
}

async fn query(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    input: &ThreadInput,
) -> Result<Lookup, Failure> {
    let body = lookup_body(expected, input)?;
    let lookup: Lookup = response(
        client
            .post(format!("{gateway}/v1/space/work-consents/query"))
            .bearer_auth(&session.access_token)
            .json(&body),
    )
    .await?;
    if !identifier(&lookup.work_id)
        || lookup.requests.len() > REQUEST_LIMIT
        || lookup.participants.len() > PARTICIPANT_LIMIT
        || lookup
            .participants
            .iter()
            .any(|p| !identifier(&p.grantor_id) || p.grantor_id == expected.config.identity_id)
    {
        return Err(Failure::Invalid);
    }
    if let Some(next) = &lookup.next {
        if !timestamp(&next.created_at)
            || !identifier(&next.id)
            || !lookup
                .requests
                .last()
                .is_some_and(|record| record.id == next.id && record.created_at == next.created_at)
        {
            return Err(Failure::Invalid);
        }
    }
    let mut seen = std::collections::HashSet::new();
    for record in &lookup.requests {
        validate_record(record, expected)?;
        if record.terms.task.work_id != lookup.work_id || !seen.insert(&record.id) {
            return Err(Failure::Invalid);
        }
    }
    Ok(lookup)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadInput {
    #[serde(flatten)]
    thread: ThreadInput,
    consent_id: String,
    source_intent_id: Option<String>,
    source_intent_before: Option<Cursor>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecideInput {
    #[serde(flatten)]
    read: ReadInput,
    #[serde(flatten)]
    decision: DecisionInput,
}

// Calls this module's actual fixed HTTP adapter, surrounded by the same live
// owner/native fences used by commands. Tests inject only transport and current.
async fn read(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    input: &ReadInput,
    current: &impl Fn() -> Result<(), Failure>,
) -> Result<Record, Failure> {
    let (work_id, source) = if let Some(intent_id) = &input.source_intent_id {
        let mut thread = input.thread.clone();
        thread.before = input.source_intent_before.clone();
        let owner = intent::read(
            client,
            session,
            gateway,
            expected,
            &IntentReadInput {
                thread,
                intent_id: intent_id.clone(),
                expected_consent_id: Some(input.consent_id.clone()),
            },
            current,
        )
        .await?;
        (owner.intent.terms.task.work_id.clone(), Some(owner.intent))
    } else {
        let lookup = query(client, session, gateway, expected, &input.thread).await?;
        current()?;
        if !lookup.requests.iter().any(|v| v.id == input.consent_id) {
            return Err(Failure::AccessLost);
        }
        (lookup.work_id, None)
    };
    current()?;
    let record: Record = response(
        client
            .get(format!(
                "{gateway}/v1/space/work-consents/{}",
                input.consent_id
            ))
            .bearer_auth(&session.access_token),
    )
    .await?;
    current()?;
    validate_record(&record, expected)?;
    if record.id != input.consent_id || record.terms.task.work_id != work_id {
        return Err(Failure::AccessLost);
    }
    if let Some(intent) = source {
        intent::linked(&record, &intent, expected)?;
    }
    Ok(record)
}

async fn decide(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    input: &DecideInput,
    operations: &SpacesWorkConsent,
    current: &impl Fn() -> Result<(), Failure>,
) -> Result<DecisionResult, Failure> {
    let record = read(client, session, gateway, expected, &input.read, current).await?;
    current()?;
    // A current native generation alone cannot detect remote admission loss
    // during review. Recheck the human/config before this deliberate write.
    verify_session(client, session, gateway, expected, current).await?;
    operations.observe(expected, &[&record])?;
    let decision = operations.reserve(expected, &input.read.consent_id, &input.decision)?;
    current()?;
    // One explicit POST only. A failed response remains uncertain; explicit
    // reconciliation uses the same operationId and payload, never a new prompt.
    // Gateway checks reviewed version/digest atomically, including old-operation
    // replay after the authoritative record has changed or been revoked.
    let response: Result<DecisionResult, Failure> = response(
        client
            .post(format!(
                "{gateway}/v1/space/work-consents/{}/decisions",
                input.read.consent_id
            ))
            .bearer_auth(&session.access_token)
            .json(&decision),
    )
    .await
    .map_err(|failure| match failure {
        Failure::Unavailable | Failure::Invalid => Failure::Uncertain,
        value => value,
    });
    current()?;
    if matches!(response, Err(Failure::Conflict | Failure::NotReady)) {
        operations.rejected(expected, &input.read.consent_id, &decision.operation_id)?;
    }
    let result = response?;
    current()?;
    validate_record(&result.consent, expected).map_err(|error| {
        if error == Failure::AccessLost {
            error
        } else {
            Failure::Uncertain
        }
    })?;
    let receipt = &result.receipt;
    if result.consent.id != input.read.consent_id
        || result.consent.terms.task.work_id != record.terms.task.work_id
        || receipt.consent_id != input.read.consent_id
        || receipt.actor_id != expected.config.identity_id
        || receipt.operation_id != decision.operation_id
        || receipt.terms_digest != decision.terms_digest
        || receipt.decision != decision.decision
        || !identifier(&receipt.receipt_id)
        || !version(receipt.version)
        || receipt.version > result.consent.version
        || receipt.terms_digest != result.consent.terms_digest
        || !timestamp(&receipt.decided_at)
    {
        return Err(Failure::Uncertain);
    }
    // Current consent state is authoritative, even if an old receipt says approve.
    Ok(result)
}

#[path = "work_consent_operations.rs"]
mod operations;
pub(crate) use operations::SpacesWorkConsent;

#[derive(Serialize)]
#[serde(untagged)]
pub(crate) enum ReadyValue {
    Lookup {
        lookup: Lookup,
    },
    Consent {
        consent: Record,
    },
    IntentLookup {
        lookup: IntentLookup,
    },
    TaskStatus {
        lookup: task_status::TaskStatusLookup,
    },
    IntentOwner {
        #[serde(rename = "ownerResult")]
        owner_result: OwnerResult,
    },
}
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum CommandResult {
    Ready {
        #[serde(rename = "scopeToken")]
        scope_token: String,
        #[serde(rename = "principalId")]
        principal_id: String,
        #[serde(rename = "organisationId")]
        organisation_id: String,
        #[serde(flatten)]
        value: ReadyValue,
        displays: std::collections::BTreeMap<String, display::Display>,
        #[serde(rename = "pendingDecisions")]
        pending_decisions: std::collections::BTreeMap<String, DecisionInput>,
        #[serde(rename = "intentDisplays")]
        intent_displays: std::collections::BTreeMap<String, display::Display>,
        #[serde(rename = "pendingSelections")]
        pending_selections: std::collections::BTreeMap<String, SelectionInput>,
    },
    Confirmed {
        #[serde(rename = "scopeToken")]
        scope_token: String,
        #[serde(rename = "principalId")]
        principal_id: String,
        #[serde(rename = "organisationId")]
        organisation_id: String,
        result: DecisionResult,
        displays: std::collections::BTreeMap<String, display::Display>,
        #[serde(rename = "pendingDecisions")]
        pending_decisions: std::collections::BTreeMap<String, DecisionInput>,
    },
    #[serde(rename = "confirmed")]
    SelectionConfirmed {
        #[serde(rename = "scopeToken")]
        scope_token: String,
        #[serde(rename = "principalId")]
        principal_id: String,
        #[serde(rename = "organisationId")]
        organisation_id: String,
        consent: Record,
        displays: std::collections::BTreeMap<String, display::Display>,
    },
    AccessLost {
        message: &'static str,
    },
    Unavailable {
        message: &'static str,
    },
    Uncertain {
        message: &'static str,
    },
    Conflict {
        message: &'static str,
    },
    NotReady {
        message: &'static str,
    },
    Unsupported,
}
impl Failure {
    fn public(self) -> CommandResult {
        match self {
            Self::NotReady => CommandResult::NotReady { message: "Required execution access is unavailable. No approval was saved." },
            Self::AccessLost => CommandResult::AccessLost {
                message: ACCESS_LOST,
            },
            Self::Conflict => CommandResult::Conflict { message: CHANGED },
            Self::Uncertain => CommandResult::Uncertain { message: UNCERTAIN },
            Self::Unavailable | Self::Invalid => CommandResult::Unavailable {
                message: UNAVAILABLE,
            },
        }
    }
}

enum Action<'a> {
    Query(&'a ThreadInput),
    TaskStatus(&'a ThreadInput),
    Read(&'a ReadInput),
    Decide(&'a DecideInput),
    IntentQuery(&'a ThreadInput),
    IntentRead(&'a IntentReadInput),
    Select(&'a SelectInput),
}
impl Action<'_> {
    fn is_mutation(&self) -> bool {
        matches!(self, Self::Decide(_) | Self::Select(_))
    }
    fn thread(&self) -> &ThreadInput {
        match self {
            Self::Query(v) | Self::IntentQuery(v) | Self::TaskStatus(v) => v,
            Self::Read(v) => &v.thread,
            Self::Decide(v) => &v.read.thread,
            Self::IntentRead(v) => &v.thread,
            Self::Select(v) => &v.read.thread,
        }
    }
    fn validate(&self, scope: &native_scope::Scope) -> Result<(), Failure> {
        self.thread().validate(scope)?;
        if matches!(
            self,
            Self::Query(_) | Self::IntentQuery(_) | Self::TaskStatus(_)
        ) {
            return Ok(());
        }
        if self.thread().expected_scope_token.as_deref() != Some(scope_token(scope).as_str()) {
            return Err(Failure::AccessLost);
        }
        let read = match self {
            Self::Read(v) => Some(*v),
            Self::Decide(v) => Some(&v.read),
            _ => None,
        };
        if let Some(read) = read {
            if !identifier(&read.consent_id)
                || read
                    .source_intent_id
                    .as_ref()
                    .is_some_and(|v| !identifier(v))
                || (read.source_intent_before.is_some() && read.source_intent_id.is_none())
                || read
                    .source_intent_before
                    .as_ref()
                    .is_some_and(|v| !timestamp(&v.created_at) || !identifier(&v.id))
            {
                return Err(Failure::AccessLost);
            }
        }
        let intent_read = match self {
            Self::IntentRead(v) => Some(*v),
            Self::Select(v) => Some(&v.read),
            _ => None,
        };
        if intent_read.is_some_and(|v| {
            !identifier(&v.intent_id)
                || v.expected_consent_id
                    .as_ref()
                    .is_some_and(|id| !identifier(id))
        }) {
            return Err(Failure::AccessLost);
        }
        if let Self::Decide(input) = self {
            if !identifier(&input.decision.operation_id)
                || !version(input.decision.expected_version)
                || !digest(&input.decision.terms_digest)
            {
                return Err(Failure::Invalid);
            }
        }
        if let Self::Select(input) = self {
            let s = &input.selection;
            if !identifier(&s.operation_id)
                || !version(s.expected_version)
                || !digest(&s.intent_digest)
                || !identifier(&s.account_id)
                || !version(s.account_version)
            {
                return Err(Failure::Invalid);
            }
        }
        Ok(())
    }
}

async fn perform(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    action: &Action<'_>,
    operations: &SpacesWorkConsent,
    current: impl Fn() -> Result<(), Failure>,
) -> Result<CommandResult, Failure> {
    action.validate(expected)?;
    let directory = verify_session(client, session, gateway, expected, &current).await?;
    if !capability(client, session, gateway).await? {
        return Ok(CommandResult::Unsupported);
    }
    current()?;
    let token = scope_token(expected);
    let person = expected.config.identity_id.clone();
    let org = expected.config.org_id.clone();
    let mut result = match action {
        Action::Query(input) => {
            query(client, session, gateway, expected, input)
                .await
                .map(|lookup| CommandResult::Ready {
                    scope_token: token,
                    principal_id: person,
                    organisation_id: org,
                    value: ReadyValue::Lookup { lookup },
                    displays: Default::default(),
                    pending_decisions: Default::default(),
                    intent_displays: Default::default(),
                    pending_selections: Default::default(),
                })
        }
        Action::Read(input) => read(client, session, gateway, expected, input, &current)
            .await
            .map(|consent| CommandResult::Ready {
                scope_token: token,
                principal_id: person,
                organisation_id: org,
                value: ReadyValue::Consent { consent },
                displays: Default::default(),
                pending_decisions: Default::default(),
                intent_displays: Default::default(),
                pending_selections: Default::default(),
            }),
        Action::Decide(input) => decide(
            client, session, gateway, expected, input, operations, &current,
        )
        .await
        .map(|result| CommandResult::Confirmed {
            scope_token: token,
            principal_id: person,
            organisation_id: org,
            result,
            displays: Default::default(),
            pending_decisions: Default::default(),
        }),
        Action::TaskStatus(input) => {
            task_status::query(client, session, gateway, expected, input, &current)
                .await
                .map(|lookup| CommandResult::Ready {
                    scope_token: token,
                    principal_id: person,
                    organisation_id: org,
                    value: ReadyValue::TaskStatus { lookup },
                    displays: Default::default(),
                    pending_decisions: Default::default(),
                    intent_displays: Default::default(),
                    pending_selections: Default::default(),
                })
        }
        Action::IntentQuery(input) => intent::query(client, session, gateway, expected, input)
            .await
            .map(|lookup| CommandResult::Ready {
                scope_token: token,
                principal_id: person,
                organisation_id: org,
                value: ReadyValue::IntentLookup { lookup },
                displays: Default::default(),
                pending_decisions: Default::default(),
                intent_displays: Default::default(),
                pending_selections: Default::default(),
            }),
        Action::IntentRead(input) => {
            intent::read(client, session, gateway, expected, input, &current)
                .await
                .map(|owner_result| CommandResult::Ready {
                    scope_token: token,
                    principal_id: person,
                    organisation_id: org,
                    value: ReadyValue::IntentOwner { owner_result },
                    displays: Default::default(),
                    pending_decisions: Default::default(),
                    intent_displays: Default::default(),
                    pending_selections: Default::default(),
                })
        }
        Action::Select(input) => intent::select(
            client, session, gateway, expected, input, operations, &current,
        )
        .await
        .map(|consent| CommandResult::SelectionConfirmed {
            scope_token: token,
            principal_id: person,
            organisation_id: org,
            consent,
            displays: Default::default(),
        }),
    };
    current()?;
    if matches!(result, Err(Failure::AccessLost)) {
        return Err(Failure::AccessLost);
    }
    match &mut result {
        Ok(CommandResult::Ready {
            value,
            displays,
            pending_decisions,
            intent_displays,
            pending_selections,
            ..
        }) => match value {
            ReadyValue::Lookup { lookup } => {
                let records: Vec<_> = lookup.requests.iter().collect();
                *displays =
                    display::displays(client, session, gateway, &directory, &records).await?;
                *pending_decisions = operations.observe(expected, &records)?;
            }
            ReadyValue::Consent { consent } => {
                *displays =
                    display::displays(client, session, gateway, &directory, &[consent]).await?;
                *pending_decisions = operations.observe(expected, &[consent])?;
            }
            ReadyValue::TaskStatus { .. } => (),
            ReadyValue::IntentLookup { lookup } => {
                *intent_displays =
                    intent::intent_displays(&directory, &lookup.intents.iter().collect::<Vec<_>>());
                *pending_selections = operations.observe_selections(
                    expected,
                    action.thread(),
                    &lookup.work_id,
                    None,
                )?;
            }
            ReadyValue::IntentOwner { owner_result } => {
                *displays = intent::bound_display(&directory, owner_result);
                *intent_displays = intent::intent_displays(&directory, &[&owner_result.intent]);
                *pending_decisions = operations
                    .observe(expected, &owner_result.consent.iter().collect::<Vec<_>>())?;
            }
        },
        Ok(CommandResult::Confirmed {
            result,
            displays,
            pending_decisions,
            ..
        }) => {
            *displays =
                display::displays(client, session, gateway, &directory, &[&result.consent]).await?;
            *pending_decisions = operations.observe(expected, &[&result.consent])?;
        }
        Ok(CommandResult::SelectionConfirmed {
            consent, displays, ..
        }) => {
            displays.insert(
                consent.id.clone(),
                display::task_display(&directory, &consent.terms.task),
            );
            operations.observe(expected, &[consent])?;
        }
        _ => (),
    }
    current()?;
    // An otherwise valid response is discarded if the live human/key changed.
    if let Err(error) = verify_session(client, session, gateway, expected, &current).await {
        return Err(if error == Failure::AccessLost {
            error
        } else if action.is_mutation() {
            Failure::Uncertain
        } else {
            error
        });
    }
    current()?;
    // Do not settle an uncertain binding before the remote/native postflight.
    match &mut result {
        Ok(CommandResult::Ready {
            value: ReadyValue::TaskStatus { lookup },
            ..
        }) => lookup.expire_leases(),
        Ok(CommandResult::Ready {
            value: ReadyValue::IntentOwner { owner_result },
            pending_selections,
            ..
        }) => {
            *pending_selections = operations.observe_selections(
                expected,
                action.thread(),
                &owner_result.intent.terms.task.work_id,
                owner_result
                    .consent
                    .as_ref()
                    .map(|c| (owner_result.intent.id.as_str(), c)),
            )?;
        }
        Ok(CommandResult::SelectionConfirmed { consent, .. }) => {
            if let Action::Select(input) = action {
                operations.observe_selections(
                    expected,
                    action.thread(),
                    &consent.terms.task.work_id,
                    Some((&input.read.intent_id, consent)),
                )?;
            }
        }
        _ => (),
    }
    current()?;
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capability {
    enabled: bool,
    schema_version: u64,
    lookup: String,
}
async fn capability(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
) -> Result<bool, Failure> {
    let capability: Capability = response(
        client
            .get(format!("{gateway}/v1/space/work-consents/capabilities"))
            .bearer_auth(&session.access_token),
    )
    .await?;
    Ok(
        capability.enabled
            && capability.schema_version == 1
            && capability.lookup == "native_origin",
    )
}

#[path = "work_consent_commands.rs"]
pub(crate) mod commands;

#[path = "work_consent_intent_commands.rs"]
pub(crate) mod intent_commands;

#[cfg(test)]
#[path = "work_consent_tests.rs"]
mod tests;
