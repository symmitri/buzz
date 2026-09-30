//! Exact personal account actions and allowlisted provider authorization URLs.
use super::catalog::*;
use reqwest::StatusCode;
use serde::Deserialize;
use url::Url;
use zeroize::Zeroizing;

pub(super) fn available_entry<'a>(
    snapshot: &'a ConnectionsSnapshot,
    connection_id: &str,
) -> Result<&'a ConnectionEntry, String> {
    if !identifier(connection_id) {
        return Err("Refresh connections before continuing.".into());
    }
    snapshot
        .entries
        .iter()
        .find(|entry| {
            entry.connection_id == connection_id
                && (entry.visibility == "discoverable" || entry.entitlement == "allowed")
        })
        .ok_or_else(|| "This connection is no longer available. Refresh and try again.".into())
}

pub(super) fn personal_setup<'a>(
    snapshot: &'a ConnectionsSnapshot,
    connection_id: &str,
    kinds: &[&str],
    require_entitlement: bool,
) -> Result<&'a ConnectionEntry, String> {
    if snapshot.accounts_state != "ready" {
        return Err("Refresh saved accounts before changing account setup.".into());
    }
    let entry = available_entry(snapshot, connection_id)?;
    if entry.credential_scope != "identity"
        || !kinds.contains(&entry.setup.kind.as_str())
        || !connector_identifier(&entry.setup.connector_id)
    {
        return Err("This account uses a company-managed setup process.".into());
    }
    if require_entitlement && entry.entitlement != "allowed" {
        return Err("Your company needs to approve access before you connect this account.".into());
    }
    Ok(entry)
}

pub(super) enum Confirmation {
    Activation {
        connection_id: String,
        enabled: bool,
        previous_version: i64,
    },
    Request {
        connection_id: String,
        previous: Option<(String, i64, String)>,
    },
    Key {
        connection_id: String,
        connector_id: String,
        previous: Vec<(String, String, String)>,
    },
    Disconnect {
        account_id: String,
        connection_id: String,
        connector_id: String,
    },
}

impl Confirmation {
    pub(super) fn matches(&self, snapshot: &ConnectionsSnapshot, outcome: WriteOutcome) -> bool {
        if matches!(
            outcome,
            WriteOutcome::Denied | WriteOutcome::AccessLost | WriteOutcome::CleanupRequired
        ) {
            return false;
        }
        match self {
            Self::Activation {
                connection_id,
                enabled,
                previous_version,
            } => snapshot.entries.iter().any(|entry| {
                entry.connection_id == *connection_id
                    && entry.activation.enabled == *enabled
                    && entry.activation.version > *previous_version
            }),
            Self::Request {
                connection_id,
                previous,
            } => snapshot
                .entries
                .iter()
                .find(|entry| entry.connection_id == *connection_id)
                .and_then(|entry| entry.request.as_ref())
                .is_some_and(|request| {
                    matches!(request.status.as_str(), "pending" | "approved")
                        && previous.as_ref().is_none_or(|(id, version, status)| {
                            request.id != *id
                                || request.version > *version
                                || request.status != *status
                        })
                }),
            Self::Key {
                connection_id,
                connector_id,
                previous,
            } => {
                snapshot.accounts_state == "ready"
                    && snapshot.accounts.iter().any(|account| {
                        if account.connection_id != *connection_id
                            || account.connector_id != *connector_id
                            || account.owner_type != "personal"
                            || account.status != "active"
                        {
                            return false;
                        }
                        previous
                            .iter()
                            .find(|(id, _, _)| *id == account.id)
                            .is_none_or(|(_, updated_at, status)| {
                                account.updated_at != *updated_at || account.status != *status
                            })
                    })
            }
            Self::Disconnect {
                account_id,
                connection_id,
                connector_id,
            } => {
                // Gateway can remove the saved account, then fail to disable
                // its secret. Only an accepted DELETE confirms cleanup too.
                matches!(outcome, WriteOutcome::Accepted)
                    && snapshot.accounts_state == "ready"
                    // Account projection omits inaccessible catalog entries.
                    // Losing that visibility cannot confirm credential removal.
                    && snapshot.entries.iter().any(|entry| {
                        entry.connection_id == *connection_id
                            && entry.setup.connector_id == *connector_id
                            && entry.credential_scope == "identity"
                            && entry.readiness != "unavailable"
                            && (entry.visibility == "discoverable"
                                || entry.entitlement == "allowed")
                    })
                    && snapshot
                        .accounts
                        .iter()
                        .all(|account| account.id != *account_id)
            }
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum WriteOutcome {
    Accepted,
    Conflict,
    Denied,
    AccessLost,
    Uncertain,
    CleanupRequired,
}

impl WriteOutcome {
    pub(super) fn unconfirmed(
        self,
        snapshot: Option<ConnectionsSnapshot>,
    ) -> ConnectionsMutationResult {
        let message = match self {
            Self::CleanupRequired => "Gateway access was revoked. Ask a company administrator to complete provider secret cleanup.",
            _ => "The change may have been submitted, but Spaces could not confirm it. Refresh before retrying.",
        };
        ConnectionsMutationResult::NotConfirmed {
            snapshot,
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: ErrorCode,
}

#[derive(Deserialize)]
struct ErrorCode {
    code: String,
}

async fn cleanup_required(mut response: reqwest::Response) -> bool {
    const LIMIT: usize = 4 * 1024;
    if response
        .content_length()
        .is_some_and(|size| size > LIMIT as u64)
    {
        return false;
    }
    let mut body = Zeroizing::new(Vec::new());
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len().saturating_add(chunk.len()) > LIMIT {
                    return false;
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return false,
        }
    }
    // Recognize only this documented Gateway code; provider/native error text
    // is ignored and can never become a renderer message.
    serde_json::from_slice::<ErrorEnvelope>(&body)
        .is_ok_and(|value| value.error.code == "connector_secret_cleanup_failed")
}

pub(super) async fn send_write(request: reqwest::RequestBuilder) -> WriteOutcome {
    let (client, request) = request.header("Cache-Control", "no-store").build_split();
    let Ok(request) = request else {
        return WriteOutcome::Uncertain;
    };
    let disconnect = request.method() == reqwest::Method::DELETE;
    match client.execute(request).await {
        Ok(response) if response.status().is_success() => WriteOutcome::Accepted,
        Ok(response) if response.status() == StatusCode::CONFLICT => WriteOutcome::Conflict,
        Ok(response) if response.status() == StatusCode::UNAUTHORIZED => WriteOutcome::AccessLost,
        Ok(response)
            if matches!(
                response.status(),
                StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
            ) =>
        {
            WriteOutcome::Denied
        }
        Ok(response) if disconnect && response.status() == StatusCode::SERVICE_UNAVAILABLE => {
            if cleanup_required(response).await {
                WriteOutcome::CleanupRequired
            } else {
                WriteOutcome::Uncertain
            }
        }
        _ => WriteOutcome::Uncertain,
    }
}

pub(super) fn provider_authorization(
    value: &str,
    connector: &str,
    gateway: &str,
    native_token: &str,
) -> Result<String, String> {
    let (host, path) = provider_route(connector)
        .ok_or("This provider's authorization route is not supported yet.")?;
    if value.len() > 16_000 || value.contains(native_token) {
        return Err("Gateway returned an invalid authorization route.".into());
    }
    let url = Url::parse(value)
        .map_err(|_| "Gateway returned an invalid authorization route.".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some(host)
        || url.port().is_some()
        || url.path() != path
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Gateway returned an invalid authorization route.".into());
    }
    let pairs: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = pairs.iter().filter(|(key, _)| key == "state").collect();
    let redirects: Vec<_> = pairs
        .iter()
        .filter(|(key, _)| key == "redirect_uri")
        .collect();
    if states.len() != 1
        || states[0].1.is_empty()
        || states[0].1.len() > 1_024
        || redirects.len() != 1
        || pairs.iter().any(|(key, value)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "access_token" | "refresh_token" | "token" | "authorization" | "api_key" | "secret"
            ) || value.contains(native_token)
        })
    {
        return Err("Gateway returned an invalid authorization route.".into());
    }
    let redirect = Url::parse(&redirects[0].1)
        .map_err(|_| "Gateway returned an invalid authorization route.".to_string())?;
    let expected_callback = if connector == "google-workspace" {
        "/v1/auth/google/callback".to_string()
    } else {
        format!("/v1/connections/{connector}/callback")
    };
    if redirect.origin().ascii_serialization() != gateway
        || redirect.path() != expected_callback
        || !redirect.username().is_empty()
        || redirect.password().is_some()
        || redirect.query().is_some()
        || redirect.fragment().is_some()
    {
        return Err("Gateway returned an invalid authorization route.".into());
    }
    Ok(url.to_string())
}

pub(super) fn provider_route(connector: &str) -> Option<(&'static str, &'static str)> {
    Some(match connector {
        "google-workspace" => ("accounts.google.com", "/o/oauth2/v2/auth"),
        "slack" => ("slack.com", "/oauth/v2_user/authorize"),
        "granola-mcp" => ("mcp-auth.granola.ai", "/oauth2/authorize"),
        "ramp" => ("mcp.ramp.com", "/oauth/authorize"),
        _ => return None,
    })
}

#[cfg(test)]
#[path = "connections_actions_tests.rs"]
mod tests;
