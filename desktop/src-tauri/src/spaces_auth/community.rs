//! Alpha enrollment: Gateway selects the community, native Keychain owns its key.
use super::oauth::{self, Account, Session};
use nostr::{Event, EventBuilder, JsonUtil, Keys, Kind, PublicKey, Tag};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::Zeroizing;

const CONFIG_PATH: &str = "/v1/space/buzz/config";
const IDENTITY_PATH: &str = "/v1/space/buzz/identity";
const ENVIRONMENT_HEADER: &str = "X-Axis-Buzz-Environment";
const INVALID: &str = "Gateway could not verify the Alpha messaging connection. Try again.";
const RECOVERY: &str = "This account already has a Buzz identity. Restore its Alpha key on this Mac before connecting.";
const STORAGE: &str = "Spaces Alpha could not access its messaging key in macOS Keychain.";
const CAPABILITIES: &[&str] = &[
    "axis-immutable-dm-audiences-v1",
    "axis-buzz-membership-revocation-v1",
    "axis-self-dms-v1",
];

#[derive(Clone, Deserialize, PartialEq)]
pub(super) struct Configuration {
    pub(super) org_id: String,
    pub(super) identity_id: String,
    pub(super) tenant_id: String,
    pub(super) relay_url: String,
    pub(super) relay_pubkey: String,
    environment: String,
    #[serde(default)]
    pubkey: Option<String>,
}

fn valid_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && PublicKey::from_hex(value).is_ok()
}

impl Configuration {
    pub(super) fn validate(&self, session: &Session) -> Result<(), String> {
        let url = Url::parse(&self.relay_url).map_err(|_| INVALID.to_string())?;
        let secure = url.scheme() == "https"
            || cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
        if self.environment != "alpha"
            || self.org_id != session.org_id
            || self.identity_id != session.identity_id
            || self.tenant_id.is_empty()
            || self.tenant_id.len() > 128
            || !self
                .tenant_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !secure
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.origin().ascii_serialization() != self.relay_url
            || !valid_key(&self.relay_pubkey)
            || self.pubkey.as_ref().is_some_and(|key| !valid_key(key))
        {
            return Err(INVALID.into());
        }
        Ok(())
    }

    fn scope(&self, gateway: &str) -> String {
        serde_json::json!([gateway, self.org_id, self.identity_id, self.tenant_id]).to_string()
    }
}

pub(super) async fn configuration(
    client: &Client,
    session: &Session,
    gateway: &str,
) -> Result<Option<Configuration>, String> {
    let value: serde_json::Value = oauth::json_for(
        client
            .get(format!("{gateway}{CONFIG_PATH}"))
            .bearer_auth(&session.access_token)
            .header(ENVIRONMENT_HEADER, "alpha"),
        "Alpha configuration",
    )
    .await?;
    match value.get("enabled").and_then(|v| v.as_bool()) {
        Some(false) => Ok(None),
        Some(true) => {
            // An old Gateway may ignore the header. Never enroll unless it
            // explicitly returns Alpha, even if its default is otherwise valid.
            let config: Configuration =
                serde_json::from_value(value).map_err(|_| INVALID.to_string())?;
            config.validate(session)?;
            Ok(Some(config))
        }
        None => Err(INVALID.into()),
    }
}

pub(super) fn key_for_scope(config: &Configuration, gateway: &str) -> Result<Keys, String> {
    #[cfg(all(target_os = "macos", feature = "system-keyring"))]
    {
        super::enabled()?;
        let scope = config.scope(gateway);
        let name = format!(
            "buzz-identity-{}",
            hex::encode(Sha256::digest(scope.as_bytes()))
        );
        let entry = keyring::Entry::new("ai.symmitri.spaces.alpha", &name)
            .map_err(|_| STORAGE.to_string())?;
        let saved = match entry.get_password() {
            Ok(value) => Some(Zeroizing::new(value)),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => return Err(STORAGE.into()),
        };
        let keys = restore_key(
            saved.as_deref().map(|s| s.as_str()),
            &scope,
            config.pubkey.as_deref(),
        )?;
        if saved.is_none() {
            let record = Zeroizing::new(
                serde_json::json!({"scope": scope, "secret": keys.secret_key().to_secret_hex()})
                    .to_string(),
            );
            // Commit the recoverable identity before Gateway can bind it.
            entry
                .set_password(&record)
                .map_err(|_| STORAGE.to_string())?;
        }
        Ok(keys)
    }
    #[cfg(not(all(target_os = "macos", feature = "system-keyring")))]
    {
        let _ = (config, gateway);
        Err(STORAGE.into())
    }
}

fn restore_key(saved: Option<&str>, scope: &str, bound: Option<&str>) -> Result<Keys, String> {
    let keys = match saved {
        Some(value) if value.len() <= 4096 => {
            #[derive(Deserialize)]
            struct Record {
                scope: String,
                secret: String,
            }
            let record: Record = serde_json::from_str(value).map_err(|_| STORAGE.to_string())?;
            let secret = Zeroizing::new(record.secret);
            if record.scope != scope {
                return Err(STORAGE.into());
            }
            Keys::parse(secret.as_str()).map_err(|_| STORAGE.to_string())?
        }
        Some(_) => return Err(STORAGE.into()),
        None if bound.is_some() => return Err(RECOVERY.into()),
        None => Keys::generate(),
    };
    if bound.is_some_and(|bound| bound != keys.public_key().to_hex()) {
        return Err(RECOVERY.into());
    }
    Ok(keys)
}

// Never Serialize this object: the renderer gets public CommunityInfo only.
pub(super) struct PreparedCommunity {
    pub(super) config: Configuration,
    pub(super) keys: Keys,
}

#[derive(Clone, Serialize)]
pub(crate) struct CommunityInfo {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) relay_url: String,
    pub(super) pubkey: String,
}

impl PreparedCommunity {
    pub(super) fn public_info(&self) -> CommunityInfo {
        CommunityInfo {
            id: format!("alpha-{}", self.config.tenant_id),
            name: "Spaces Alpha".into(),
            relay_url: self.config.relay_url.replacen("https://", "wss://", 1),
            pubkey: self.keys.public_key().to_hex(),
        }
    }
}

pub(super) async fn prepare(
    client: &Client,
    session: &Session,
    account: &Account,
    gateway: &str,
    load_key: impl AsyncFnOnce(Configuration) -> Result<Keys, String>,
) -> Result<Option<PreparedCommunity>, String> {
    let Some(before) = configuration(client, session, gateway).await? else {
        return Ok(None);
    };
    let keys = load_key(before.clone()).await?;
    let endpoint = format!("{gateway}{IDENTITY_PATH}");
    let proof = EventBuilder::new(Kind::HttpAuth, "")
        .tags(
            [
                Tag::parse(["u", endpoint.as_str()]),
                Tag::parse(["method", "POST"]),
                Tag::parse(["org", before.org_id.as_str()]),
                Tag::parse(["tenant", before.tenant_id.as_str()]),
                Tag::parse(["identity", before.identity_id.as_str()]),
            ]
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| INVALID.to_string())?,
        )
        .sign_with_keys(&keys)
        .map_err(|_| INVALID.to_string())?;
    let _: serde_json::Value = oauth::json_for(
        client
            .post(endpoint)
            .bearer_auth(&session.access_token)
            .header(ENVIRONMENT_HEADER, "alpha")
            .json(&serde_json::json!({"event": proof})),
        "Alpha messaging enrollment",
    )
    .await?;
    let after = configuration(client, session, gateway)
        .await?
        .ok_or(INVALID)?;
    let mut expected = before;
    expected.pubkey = Some(keys.public_key().to_hex());
    if after != expected {
        return Err(INVALID.into());
    }

    #[derive(Deserialize)]
    struct RelayInfo {
        #[serde(rename = "self")]
        key: String,
        #[serde(default, rename = "supported_extensions")]
        extensions: Vec<String>,
    }
    let info: RelayInfo = oauth::json_for(
        client
            .get(&after.relay_url)
            .header("Accept", "application/nostr+json"),
        "Alpha messaging server",
    )
    .await?;
    if info.key != after.relay_pubkey
        || CAPABILITIES
            .iter()
            .any(|cap| !info.extensions.iter().any(|ext| ext == cap))
    {
        return Err("The Alpha messaging server does not match its verified configuration.".into());
    }
    let url = format!("{}/query", after.relay_url);
    let body = serde_json::to_vec(
        &serde_json::json!([{"kinds": [0], "authors": [keys.public_key().to_hex()], "limit": 1}]),
    )
    .map_err(|_| INVALID.to_string())?;
    let auth = crate::relay::build_nip98_auth_header_for_keys(&keys, &Method::POST, &url, &body)?;
    let profiles: Vec<Event> = oauth::json_for(
        client
            .post(url)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .body(body),
        "Alpha profile lookup",
    )
    .await?;
    if profiles.len() > 1
        || profiles.iter().any(|event| {
            event.kind != Kind::Metadata
                || event.pubkey != keys.public_key()
                || event.verify().is_err()
        })
    {
        return Err("The Alpha messaging profile could not be verified.".into());
    }
    if profiles.is_empty() {
        let event = EventBuilder::new(
            Kind::Metadata,
            serde_json::json!({"name": account.name, "display_name": account.name}).to_string(),
        )
        .sign_with_keys(&keys)
        .map_err(|_| INVALID.to_string())?;
        let url = format!("{}/events", after.relay_url);
        let body = event.as_json().into_bytes();
        let auth =
            crate::relay::build_nip98_auth_header_for_keys(&keys, &Method::POST, &url, &body)?;
        #[derive(Deserialize)]
        struct Accepted {
            accepted: bool,
        }
        let result: Accepted = oauth::json_for(
            client
                .post(url)
                .header("Authorization", auth)
                .header("Content-Type", "application/json")
                .body(body),
            "Alpha profile setup",
        )
        .await?;
        if !result.accepted {
            return Err("The Alpha messaging profile could not be saved. Try again.".into());
        }
    }
    Ok(Some(PreparedCommunity {
        config: after,
        keys,
    }))
}

#[cfg(test)]
#[path = "community_tests.rs"]
mod tests;
