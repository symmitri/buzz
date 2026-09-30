//! Secret-free Gateway catalog projection and bounded reads.
use super::actions::provider_route;
use super::{oauth, ACCESS_LOST, ENTRY_LIMIT, INVALID, RESPONSE_LIMIT, UNAVAILABLE};
use reqwest::{Client, StatusCode};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum ConnectionsReadResult {
    Ready { snapshot: ConnectionsSnapshot },
    Unavailable { message: String },
    AccessLost { message: String },
    Invalid { message: String },
}

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum ConnectionsMutationResult {
    Confirmed {
        snapshot: ConnectionsSnapshot,
    },
    NotConfirmed {
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<ConnectionsSnapshot>,
        message: String,
    },
    Conflict {
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<ConnectionsSnapshot>,
        message: String,
    },
    Denied {
        #[serde(skip_serializing_if = "Option::is_none")]
        snapshot: Option<ConnectionsSnapshot>,
        message: String,
    },
    AccessLost {
        message: String,
    },
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Principal {
    pub(super) id: String,
    #[serde(rename = "type")]
    pub(super) kind: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Organisation {
    pub(super) id: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Activation {
    pub(super) enabled: bool,
    pub(super) source: String,
    pub(super) version: i64,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct Setup {
    pub(super) kind: String,
    pub(super) connector_id: String,
    #[serde(default, skip_deserializing)]
    pub(super) browser_supported: bool,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct RequestSummary {
    pub(super) id: String,
    pub(super) status: String,
    pub(super) version: i64,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct ConnectionEntry {
    pub(super) connection_id: String,
    pub(super) alias: String,
    pub(super) name: String,
    pub(super) provider: String,
    pub(super) credential_scope: String,
    pub(super) auth_mode: String,
    pub(super) visibility: String,
    pub(super) entitlement: String,
    pub(super) activation: Activation,
    pub(super) readiness: String,
    pub(super) setup: Setup,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) request: Option<RequestSummary>,
}

#[derive(Deserialize)]
pub(super) struct Catalog {
    pub(super) schema_version: u8,
    pub(super) principal: Principal,
    pub(super) organisation: Organisation,
    pub(super) entries: Vec<ConnectionEntry>,
}

#[derive(Deserialize)]
pub(super) struct Inventory {
    pub(super) accounts: Vec<RawAccount>,
}

#[derive(Deserialize)]
pub(super) struct RawAccount {
    pub(super) id: String,
    pub(super) connection_id: String,
    pub(super) connector_id: String,
    pub(super) connector_name: String,
    pub(super) provider: String,
    pub(super) credential_owner_type: String,
    #[serde(default)]
    pub(super) credential_owner_id: String,
    pub(super) credential_owner_name: String,
    #[serde(default)]
    pub(super) account_label: String,
    #[serde(default)]
    pub(super) account_email: String,
    pub(super) status: String,
    pub(super) connected_at: String,
    pub(super) updated_at: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct ConnectionAccount {
    pub(super) id: String,
    pub(super) connection_id: String,
    pub(super) connector_id: String,
    pub(super) connector_name: String,
    pub(super) provider: String,
    pub(super) owner_type: String,
    pub(super) owner_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(super) label: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(super) email: String,
    pub(super) status: String,
    pub(super) connected_at: String,
    pub(super) updated_at: String,
    pub(super) can_disconnect: bool,
}

#[derive(Clone, Serialize)]
pub(crate) struct ConnectionsSnapshot {
    pub(super) schema_version: u8,
    pub(super) principal: Principal,
    pub(super) organisation: Organisation,
    pub(super) entries: Vec<ConnectionEntry>,
    pub(super) accounts: Vec<ConnectionAccount>,
    pub(super) accounts_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) message: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ReadFailure {
    Unavailable,
    AccessLost,
    Invalid,
}

impl ReadFailure {
    pub(super) fn public(self) -> ConnectionsReadResult {
        match self {
            Self::Unavailable => ConnectionsReadResult::Unavailable {
                message: UNAVAILABLE.into(),
            },
            Self::AccessLost => ConnectionsReadResult::AccessLost {
                message: ACCESS_LOST.into(),
            },
            Self::Invalid => ConnectionsReadResult::Invalid {
                message: INVALID.into(),
            },
        }
    }
}

pub(super) async fn request_json<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, ReadFailure> {
    let (client, request) = request.header("Cache-Control", "no-store").build_split();
    let mut request = request.map_err(|_| ReadFailure::Invalid)?;
    if request.method() != reqwest::Method::GET {
        return Err(ReadFailure::Invalid);
    }
    let mut retries_left = 2;
    let mut response = loop {
        let retry = if retries_left > 0 {
            request.try_clone()
        } else {
            None
        };
        let result = client.execute(request).await;
        let transient = match &result {
            Ok(response) => matches!(response.status().as_u16(), 502 | 503 | 504),
            Err(error) => error.is_timeout() || error.is_connect() || error.is_request(),
        };
        if transient {
            if let Some(next) = retry {
                retries_left -= 1;
                tokio::time::sleep(Duration::from_millis(if retries_left == 1 {
                    250
                } else {
                    750
                }))
                .await;
                request = next;
                continue;
            }
        }
        break result.map_err(|_| ReadFailure::Unavailable)?;
    };
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Err(ReadFailure::AccessLost);
    }
    if !response.status().is_success() {
        return Err(ReadFailure::Unavailable);
    }
    if response
        .content_length()
        .is_some_and(|length| length > RESPONSE_LIMIT as u64)
    {
        return Err(ReadFailure::Invalid);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ReadFailure::Unavailable)?
    {
        if body.len().saturating_add(chunk.len()) > RESPONSE_LIMIT {
            return Err(ReadFailure::Invalid);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ReadFailure::Invalid)
}

pub(super) async fn read_connections(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
) -> Result<ConnectionsSnapshot, ReadFailure> {
    session.validate().map_err(|_| ReadFailure::AccessLost)?;
    let catalog = request_json::<Catalog>(
        client
            .get(format!("{gateway}/v1/me/connections"))
            .bearer_auth(&session.access_token),
    );
    let accounts = request_json::<Inventory>(
        client
            .get(format!("{gateway}/v1/connection-accounts"))
            .bearer_auth(&session.access_token),
    );
    // Reject either endpoint's authentication loss immediately, even when the
    // other endpoint is unavailable or stalled. Other inventory failures still
    // permit the catalog's explicitly partial result.
    let (catalog, accounts) = tokio::try_join!(
        async {
            match catalog.await {
                Err(ReadFailure::AccessLost) => Err(ReadFailure::AccessLost),
                value => Ok(value),
            }
        },
        async {
            match accounts.await {
                Err(ReadFailure::AccessLost) => Err(ReadFailure::AccessLost),
                value => Ok(value),
            }
        }
    )?;
    let mut catalog = catalog?;
    validate_catalog(&catalog, session)?;
    for entry in &mut catalog.entries {
        entry.setup.browser_supported = match entry.setup.kind.as_str() {
            "key" => connector_identifier(&entry.setup.connector_id),
            "oauth" | "google_oauth" => provider_route(&entry.setup.connector_id).is_some(),
            _ => false,
        };
    }
    let (accounts, accounts_state, message) = match accounts {
        Ok(value) => match validate_accounts(value, &catalog, session) {
            Ok(accounts) => (accounts, "ready".to_string(), None),
            Err(_) => (Vec::new(), "unavailable".to_string(), Some(
                "Saved account details could not be verified. Refresh to try again.".into(),
            )),
        },
        Err(ReadFailure::AccessLost) => return Err(ReadFailure::AccessLost),
        Err(_) => (
            Vec::new(),
            "unavailable".to_string(),
            Some(
                "Saved account details could not be checked. Catalog permissions are still current."
                    .into(),
            ),
        ),
    };
    Ok(ConnectionsSnapshot {
        schema_version: 1,
        principal: catalog.principal,
        organisation: catalog.organisation,
        entries: catalog.entries,
        accounts,
        accounts_state,
        message,
    })
}

pub(super) fn metadata(value: &str, max: usize, allow_empty: bool) -> bool {
    value.len() <= max
        && (allow_empty || !value.trim().is_empty())
        && !value.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
}

pub(super) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'.' | b':' | b'-'))
        })
}

pub(super) fn connector_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
}

pub(super) fn validate_catalog(
    catalog: &Catalog,
    session: &oauth::Session,
) -> Result<(), ReadFailure> {
    if catalog.schema_version != 1
        || catalog.principal.id != session.identity_id
        || catalog.principal.kind != "user"
        || catalog.organisation.id != session.org_id
        || catalog.entries.len() > ENTRY_LIMIT
    {
        return Err(ReadFailure::Invalid);
    }
    let mut ids = HashSet::new();
    for entry in &catalog.entries {
        let valid_request = entry.request.as_ref().is_none_or(|request| {
            identifier(&request.id)
                && matches!(request.status.as_str(), "pending" | "approved" | "rejected")
                && request.version >= 0
        });
        if !identifier(&entry.connection_id)
            || !ids.insert(&entry.connection_id)
            || !metadata(&entry.alias, 500, false)
            || !metadata(&entry.name, 500, false)
            || !metadata(&entry.provider, 500, false)
            || !matches!(
                entry.credential_scope.as_str(),
                "identity" | "organisation" | "none"
            )
            || entry.credential_scope == "none"
                && (entry.auth_mode != "anonymous" || entry.setup.kind != "none")
            || !metadata(&entry.auth_mode, 100, false)
            || !matches!(entry.visibility.as_str(), "discoverable" | "hidden")
            || !matches!(
                entry.entitlement.as_str(),
                "allowed" | "requestable" | "denied"
            )
            || !matches!(entry.activation.source.as_str(), "default" | "user")
            || entry.activation.version < 0
            || !matches!(
                entry.readiness.as_str(),
                "ready" | "account_required" | "unavailable"
            )
            || !matches!(
                entry.setup.kind.as_str(),
                "none" | "key" | "oauth" | "google_oauth"
            )
            || !metadata(&entry.setup.connector_id, 100, true)
            || !valid_request
        {
            return Err(ReadFailure::Invalid);
        }
    }
    Ok(())
}

pub(super) fn validate_accounts(
    inventory: Inventory,
    catalog: &Catalog,
    session: &oauth::Session,
) -> Result<Vec<ConnectionAccount>, ReadFailure> {
    if inventory.accounts.len() > ENTRY_LIMIT {
        return Err(ReadFailure::Invalid);
    }
    let entries = catalog
        .entries
        .iter()
        .filter(|entry| entry.visibility == "discoverable" || entry.entitlement == "allowed")
        .map(|entry| (entry.connection_id.as_str(), entry))
        .collect::<std::collections::HashMap<_, _>>();
    let mut ids = HashSet::new();
    let mut accounts = Vec::new();
    for raw in inventory.accounts {
        let Some(entry) = entries.get(raw.connection_id.as_str()) else {
            continue;
        };
        let own =
            raw.credential_owner_type == "human" && raw.credential_owner_id == session.identity_id;
        let company = raw.credential_owner_type == "organisation" && entry.entitlement == "allowed";
        if !own && !company {
            continue;
        }
        if !identifier(&raw.id)
            || !ids.insert(raw.id.clone())
            || !metadata(&raw.connector_id, 500, false)
            || !metadata(&raw.connector_name, 500, false)
            || !metadata(&raw.provider, 500, false)
            || !metadata(&raw.credential_owner_name, 500, false)
            || !metadata(&raw.account_label, 500, true)
            || !metadata(&raw.account_email, 254, true)
            || !metadata(&raw.status, 100, false)
            || !metadata(&raw.connected_at, 64, true)
            || !metadata(&raw.updated_at, 64, true)
        {
            return Err(ReadFailure::Invalid);
        }
        let can_disconnect = own
            && entry.credential_scope == "identity"
            && matches!(entry.setup.kind.as_str(), "key" | "oauth" | "google_oauth")
            && connector_identifier(&entry.setup.connector_id)
            && raw.connector_id == entry.setup.connector_id;
        accounts.push(ConnectionAccount {
            id: raw.id,
            connection_id: entry.connection_id.clone(),
            connector_id: raw.connector_id,
            connector_name: raw.connector_name,
            provider: entry.provider.clone(),
            owner_type: if own { "personal" } else { "company" }.into(),
            owner_name: raw.credential_owner_name,
            label: raw.account_label,
            email: raw.account_email,
            status: raw.status,
            connected_at: raw.connected_at,
            updated_at: raw.updated_at,
            can_disconnect,
        });
    }
    Ok(accounts)
}

#[cfg(test)]
#[path = "connections_tests.rs"]
mod tests;
