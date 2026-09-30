//! Secret-free Gateway connection catalog and guarded management for the
//! current Alpha human. Reads and writes stay native, bounded, and independent
//! of startup and messaging.
use super::{enabled, invalidate_connection_view, oauth, read_session, SpacesAuth, CANCELLED};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;
use url::Url;
use zeroize::Zeroizing;

#[path = "connections_actions.rs"]
mod actions;
#[path = "connections_catalog.rs"]
mod catalog;
#[path = "connections_github.rs"]
pub(crate) mod github;
#[path = "connections_state.rs"]
mod state;
use actions::*;
use catalog::*;
pub(crate) use state::SpacesConnections;

const INVALID: &str =
    "Connections returned an invalid response. Refresh after checking your sign-in.";
const UNAVAILABLE: &str =
    "Connections could not be reached. Your messages are still available; try again.";
const ACCESS_LOST: &str =
    "Connection access could not be verified. Check your company sign-in and try again.";
const CONFLICT: &str = "This connection changed. Refresh before trying again.";
const DENIED: &str = "Gateway did not permit this connection change. Refresh to check your access.";
const RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const ENTRY_LIMIT: usize = 5_000;
const CALLBACK_PATH: &str = "/axis/connection-complete";

#[tauri::command]
pub(crate) async fn spaces_read_connections(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
) -> Result<ConnectionsReadResult, String> {
    enabled()?;
    let (auth_generation, auth_cancel) = auth_marker(&auth)?;
    let (read_generation, read_cancel) = connections.begin_read()?;
    let session = match load_session(&auth, auth_generation).await {
        Ok(session) => session,
        Err(error) => {
            let _ = connections.finish(read_generation, auth_generation, None);
            return Err(error);
        }
    };
    let client = match oauth::client() {
        Ok(client) => client,
        Err(error) => {
            let _ = connections.finish(read_generation, auth_generation, None);
            return Err(error);
        }
    };
    let result = tokio::select! {
        biased;
        _ = auth_cancel.cancelled() => return Err(CANCELLED.into()),
        _ = read_cancel.cancelled() => return Err(CANCELLED.into()),
        value = tokio::time::timeout(Duration::from_secs(45), read_connections(&client, &session, oauth::GATEWAY)) => {
            match value {
                Ok(Ok(snapshot)) => ConnectionsReadResult::Ready { snapshot },
                Ok(Err(error)) => error.public(),
                Err(_) => ReadFailure::Unavailable.public(),
            }
        },
    };
    let cache = match &result {
        ConnectionsReadResult::Ready { snapshot } => Some(snapshot.clone()),
        _ => None,
    };
    auth.current(auth_generation, || {
        connections.finish(read_generation, auth_generation, cache)
    })?;
    if matches!(result, ConnectionsReadResult::AccessLost { .. }) {
        connections.invalidate()?;
        invalidate_connection_view(&app)?;
    }
    Ok(result)
}

#[tauri::command]
pub(crate) fn spaces_cancel_connections(
    connections: tauri::State<'_, SpacesConnections>,
) -> Result<(), String> {
    enabled()?;
    connections.cancel()
}

fn auth_marker(auth: &SpacesAuth) -> Result<(u64, CancellationToken), String> {
    let current = auth.0.lock().map_err(|_| CANCELLED.to_string())?;
    if current.cancel.is_cancelled() {
        return Err(CANCELLED.into());
    }
    Ok((current.generation, current.cancel.clone()))
}

async fn load_session(auth: &SpacesAuth, auth_generation: u64) -> Result<oauth::Session, String> {
    let storage = SpacesAuth(auth.0.clone());
    tokio::task::spawn_blocking(move || storage.current(auth_generation, read_session))
        .await
        .map_err(|_| CANCELLED.to_string())??
        .ok_or_else(|| "Sign in with Google to view connections.".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetEnabledInput {
    connection_id: String,
    enabled: bool,
    expected_version: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RequestAccessInput {
    connection_id: String,
    idempotency_key: String,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectKeyInput {
    connection_id: String,
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartOauthInput {
    connection_id: String,
    access: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DisconnectAccountInput {
    account_id: String,
}

#[derive(Serialize)]
pub(crate) struct OAuthOpenResult {
    opened: bool,
}

struct ActionContext<'a> {
    connections: &'a SpacesConnections,
    auth_generation: u64,
    auth_cancel: CancellationToken,
    operation_generation: u64,
    operation_cancel: CancellationToken,
    session: oauth::Session,
    snapshot: ConnectionsSnapshot,
    finished: bool,
}

impl ActionContext<'_> {
    fn snapshot(&self) -> &ConnectionsSnapshot {
        &self.snapshot
    }

    fn complete(&mut self, snapshot: Option<ConnectionsSnapshot>) -> Result<(), String> {
        self.connections
            .finish(self.operation_generation, self.auth_generation, snapshot)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for ActionContext<'_> {
    fn drop(&mut self) {
        if !self.finished {
            // Pre-submit failures preserve the last verified same-person
            // snapshot. Cancellation or identity replacement increments the
            // operation generation, so this release cannot restore stale data.
            let _ = self.connections.finish(
                self.operation_generation,
                self.auth_generation,
                Some(self.snapshot.clone()),
            );
        }
    }
}

async fn action_context<'a>(
    app: &tauri::AppHandle,
    auth: &SpacesAuth,
    connections: &'a SpacesConnections,
) -> Result<ActionContext<'a>, String> {
    let (auth_generation, auth_cancel) = auth_marker(auth)?;
    let (operation_generation, operation_cancel, snapshot) =
        connections.begin_action(auth_generation)?;
    let session = match load_session(auth, auth_generation).await {
        Ok(session) => session,
        Err(error) => {
            let _ = connections.finish(operation_generation, auth_generation, None);
            return Err(error);
        }
    };
    if session.validate().is_err() {
        let _ = connections.finish(operation_generation, auth_generation, None);
        connections.invalidate()?;
        invalidate_connection_view(app)?;
        return Err(ACCESS_LOST.into());
    }
    if let Err(error) = auth.current(auth_generation, || {
        connections.current(operation_generation)
    }) {
        let _ = connections.finish(operation_generation, auth_generation, None);
        return Err(error);
    }
    Ok(ActionContext {
        connections,
        auth_generation,
        auth_cancel,
        operation_generation,
        operation_cancel,
        session,
        snapshot,
        finished: false,
    })
}

fn path_segment(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

async fn run_mutation(
    auth: &SpacesAuth,
    mut context: ActionContext<'_>,
    client: Client,
    request: reqwest::RequestBuilder,
    confirmation: Confirmation,
) -> Result<ConnectionsMutationResult, String> {
    let outcome = tokio::select! {
        biased;
        _ = context.auth_cancel.cancelled() => return Err(CANCELLED.into()),
        _ = context.operation_cancel.cancelled() => return Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(25), send_write(request)) => {
            result.unwrap_or(WriteOutcome::Uncertain)
        }
    };

    if matches!(outcome, WriteOutcome::AccessLost) {
        auth.current(context.auth_generation, || context.complete(None))?;
        return Ok(ConnectionsMutationResult::AccessLost {
            message: ACCESS_LOST.into(),
        });
    }

    // Every submitted write receives exactly one fresh catalog+inventory
    // reconciliation. The write itself is never replayed.
    let refreshed = tokio::select! {
        biased;
        _ = context.auth_cancel.cancelled() => return Err(CANCELLED.into()),
        _ = context.operation_cancel.cancelled() => return Err(CANCELLED.into()),
        result = tokio::time::timeout(
            Duration::from_secs(45),
            read_connections(&client, &context.session, oauth::GATEWAY),
        ) => result.unwrap_or(Err(ReadFailure::Unavailable))
    };

    let snapshot = match refreshed {
        Ok(snapshot) => {
            auth.current(context.auth_generation, || {
                context.complete(Some(snapshot.clone()))
            })?;
            Some(snapshot)
        }
        Err(ReadFailure::AccessLost) => {
            auth.current(context.auth_generation, || context.complete(None))?;
            return Ok(ConnectionsMutationResult::AccessLost {
                message: ACCESS_LOST.into(),
            });
        }
        Err(_) => {
            auth.current(context.auth_generation, || context.complete(None))?;
            None
        }
    };

    if let Some(confirmed) = snapshot
        .as_ref()
        .filter(|value| confirmation.matches(value, outcome))
    {
        return Ok(ConnectionsMutationResult::Confirmed {
            snapshot: confirmed.clone(),
        });
    }

    Ok(match outcome {
        WriteOutcome::Conflict => ConnectionsMutationResult::Conflict {
            snapshot,
            message: CONFLICT.into(),
        },
        WriteOutcome::Denied => ConnectionsMutationResult::Denied {
            snapshot,
            message: DENIED.into(),
        },
        WriteOutcome::AccessLost => ConnectionsMutationResult::AccessLost {
            message: ACCESS_LOST.into(),
        },
        WriteOutcome::Accepted | WriteOutcome::Uncertain | WriteOutcome::CleanupRequired => {
            outcome.unconfirmed(snapshot)
        }
    })
}

#[tauri::command]
pub(crate) async fn spaces_set_connection_enabled(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
    input: SetEnabledInput,
) -> Result<ConnectionsMutationResult, String> {
    enabled()?;
    let context = action_context(&app, &auth, &connections).await?;
    let entry = available_entry(context.snapshot(), &input.connection_id)?;
    if input.expected_version < 0
        || entry.entitlement != "allowed"
        || entry.activation.version != input.expected_version
        || entry.activation.enabled == input.enabled
    {
        return Err("Refresh this connection before changing it.".into());
    }
    let confirmation = Confirmation::Activation {
        connection_id: entry.connection_id.clone(),
        enabled: input.enabled,
        previous_version: input.expected_version,
    };
    let client = oauth::client()?;
    let request = client
        .post(format!(
            "{}/v1/me/connections/{}/activation",
            oauth::GATEWAY,
            path_segment(&entry.connection_id)
        ))
        .bearer_auth(&context.session.access_token)
        .json(&serde_json::json!({
            "enabled": input.enabled,
            "expected_version": input.expected_version,
        }));
    let result = run_mutation(&auth, context, client, request, confirmation).await?;
    if matches!(result, ConnectionsMutationResult::AccessLost { .. }) {
        connections.invalidate()?;
        invalidate_connection_view(&app)?;
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn spaces_request_connection_access(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
    input: RequestAccessInput,
) -> Result<ConnectionsMutationResult, String> {
    enabled()?;
    let context = action_context(&app, &auth, &connections).await?;
    let entry = available_entry(context.snapshot(), &input.connection_id)?;
    let reason = input.reason.unwrap_or_default();
    if entry.entitlement != "requestable"
        || entry
            .request
            .as_ref()
            .is_some_and(|request| request.status == "pending")
        || !identifier(&input.idempotency_key)
        || reason.len() > 1_000
        || reason.bytes().any(|byte| byte == 0)
    {
        return Err("This connection cannot be requested with those details.".into());
    }
    let confirmation = Confirmation::Request {
        connection_id: entry.connection_id.clone(),
        previous: entry
            .request
            .as_ref()
            .map(|request| (request.id.clone(), request.version, request.status.clone())),
    };
    let client = oauth::client()?;
    let idempotency_key = connections.request_key(
        context.auth_generation,
        entry,
        &input.idempotency_key,
        &reason,
    )?;
    let request = client
        .post(format!(
            "{}/v1/me/connections/{}/requests",
            oauth::GATEWAY,
            path_segment(&entry.connection_id)
        ))
        .bearer_auth(&context.session.access_token)
        .json(&serde_json::json!({
            "idempotency_key": idempotency_key,
            "reason": reason,
        }));
    let result = run_mutation(&auth, context, client, request, confirmation).await?;
    if matches!(result, ConnectionsMutationResult::AccessLost { .. }) {
        connections.invalidate()?;
        invalidate_connection_view(&app)?;
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn spaces_connect_connection_key(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
    input: ConnectKeyInput,
) -> Result<ConnectionsMutationResult, String> {
    enabled()?;
    let secret = Zeroizing::new(input.secret);
    if secret.trim().is_empty()
        || secret.len() > 64_000
        || secret.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
    {
        return Err("Enter a valid account key.".into());
    }
    let context = action_context(&app, &auth, &connections).await?;
    let entry = personal_setup(context.snapshot(), &input.connection_id, &["key"], true)?;
    let confirmation = Confirmation::Key {
        connection_id: entry.connection_id.clone(),
        connector_id: entry.setup.connector_id.clone(),
        previous: context
            .snapshot()
            .accounts
            .iter()
            .filter(|account| {
                account.connection_id == entry.connection_id
                    && account.connector_id == entry.setup.connector_id
                    && account.owner_type == "personal"
            })
            .map(|account| {
                (
                    account.id.clone(),
                    account.updated_at.clone(),
                    account.status.clone(),
                )
            })
            .collect(),
    };
    let client = oauth::client()?;
    let request = client
        .post(format!(
            "{}/v1/connectors/{}/accounts",
            oauth::GATEWAY,
            path_segment(&entry.setup.connector_id)
        ))
        .bearer_auth(&context.session.access_token)
        .json(&serde_json::json!({ "secret": secret.trim() }));
    let result = run_mutation(&auth, context, client, request, confirmation).await?;
    if matches!(result, ConnectionsMutationResult::AccessLost { .. }) {
        connections.invalidate()?;
        invalidate_connection_view(&app)?;
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn spaces_disconnect_connection_account(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
    input: DisconnectAccountInput,
) -> Result<ConnectionsMutationResult, String> {
    enabled()?;
    let context = action_context(&app, &auth, &connections).await?;
    if !identifier(&input.account_id) {
        return Err("Select an account you own.".into());
    }
    let account = context
        .snapshot()
        .accounts
        .iter()
        .find(|account| account.id == input.account_id && account.can_disconnect)
        .ok_or("Only your own connected accounts can be disconnected here.")?;
    let entry = personal_setup(
        context.snapshot(),
        &account.connection_id,
        &["key", "oauth", "google_oauth"],
        false,
    )?;
    if account.connector_id != entry.setup.connector_id {
        return Err("Refresh this account before disconnecting it.".into());
    }
    let path = if entry.setup.kind == "key" {
        format!(
            "{}/v1/connectors/{}/accounts",
            oauth::GATEWAY,
            path_segment(&entry.setup.connector_id)
        )
    } else {
        format!(
            "{}/v1/connections/{}",
            oauth::GATEWAY,
            path_segment(&entry.setup.connector_id)
        )
    };
    let confirmation = Confirmation::Disconnect {
        account_id: account.id.clone(),
        connection_id: entry.connection_id.clone(),
        connector_id: entry.setup.connector_id.clone(),
    };
    let client = oauth::client()?;
    let request = client
        .delete(path)
        .bearer_auth(&context.session.access_token);
    let result = run_mutation(&auth, context, client, request, confirmation).await?;
    if matches!(result, ConnectionsMutationResult::AccessLost { .. }) {
        connections.invalidate()?;
        invalidate_connection_view(&app)?;
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn spaces_start_connection_oauth(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
    input: StartOauthInput,
) -> Result<OAuthOpenResult, String> {
    enabled()?;
    let mut context = action_context(&app, &auth, &connections).await?;
    let entry = personal_setup(
        context.snapshot(),
        &input.connection_id,
        &["oauth", "google_oauth"],
        true,
    )?;
    let access = input.access.as_deref();
    if entry.setup.kind == "google_oauth" {
        if access.is_some_and(|value| !matches!(value, "read_only" | "drafts")) {
            return Err("Choose a supported Google access level.".into());
        }
    } else if access.is_some() {
        return Err("This provider does not use Google access levels.".into());
    }
    let connector_id = entry.setup.connector_id.clone();
    provider_route(&connector_id)
        .ok_or("This provider's authorization route is not supported yet.")?;
    let mut start = Url::parse(&format!(
        "{}/v1/connections/{}/start",
        oauth::GATEWAY,
        path_segment(&connector_id)
    ))
    .map_err(|_| "Account sign-in could not start. Refresh and try again.".to_string())?;
    start
        .query_pairs_mut()
        .append_pair("return_to", CALLBACK_PATH);
    if entry.setup.kind == "google_oauth" {
        start
            .query_pairs_mut()
            .append_pair("access", access.unwrap_or("read_only"));
    }
    let client = oauth::client()?;
    let response = tokio::select! {
        biased;
        _ = context.auth_cancel.cancelled() => return Err(CANCELLED.into()),
        _ = context.operation_cancel.cancelled() => return Err(CANCELLED.into()),
        result = client
            .get(start)
            .bearer_auth(&context.session.access_token)
            .header("Cache-Control", "no-store")
            .send() => {
                result.map_err(|_| "Account sign-in could not start. Refresh and try again.".to_string())?
            }
    };
    if !matches!(response.status(), StatusCode::FOUND | StatusCode::SEE_OTHER) {
        let clear = matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        );
        if clear {
            context.complete(None)?;
            connections.invalidate()?;
            invalidate_connection_view(&app)?;
        }
        return Err(if clear {
            ACCESS_LOST.into()
        } else {
            "Account sign-in could not start. Refresh and try again.".into()
        });
    }
    if response
        .headers()
        .get_all(reqwest::header::LOCATION)
        .iter()
        .count()
        != 1
    {
        return Err("Gateway returned an invalid authorization route.".into());
    }
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .ok_or("Gateway returned an invalid authorization route.")?;
    let authorization = provider_authorization(
        location,
        &connector_id,
        oauth::GATEWAY,
        &context.session.access_token,
    )?;
    auth.current(context.auth_generation, || {
        connections.current(context.operation_generation)
    })?;
    app.opener()
        .open_url(authorization, None::<&str>)
        .map_err(|_| "Could not open your browser. Refresh and try again.".to_string())?;
    let snapshot = context.snapshot().clone();
    let auth_generation = context.auth_generation;
    auth.current(auth_generation, || context.complete(Some(snapshot)))?;
    Ok(OAuthOpenResult { opened: true })
}

#[cfg(test)]
#[path = "connections_test_support.rs"]
mod test_support;
