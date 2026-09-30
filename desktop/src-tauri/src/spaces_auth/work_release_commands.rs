//! Thin Tauri adapters for the current native scope and fixed Gateway routes.
use super::*;

fn access_lost<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<CommandResult, String> {
    invalidate_connection_view(app)?;
    Ok(Failure::AccessLost.public())
}

async fn command<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    auth: &SpacesAuth,
    community: &SpacesCommunity,
    state: &AppState,
    operations: &SpacesWorkRelease,
    action: Action<'_>,
) -> Result<CommandResult, String> {
    if !WORK_RELEASE_ENABLED {
        return Ok(CommandResult::Unsupported);
    }
    enabled()?;
    let expected = match native_scope::scope(auth, community) {
        Ok(value) => value,
        Err(_) => return access_lost(app),
    };
    if let Err(error) = action.validate(&expected) {
        return if error == Failure::AccessLost {
            access_lost(app)
        } else {
            Ok(error.public())
        };
    }
    let (generation, cancel) = match operations.begin(&action.thread().client_id, &expected) {
        Ok(value) => value,
        Err(error) => {
            return if error == Failure::AccessLost {
                access_lost(app)
            } else {
                Ok(error.public())
            }
        }
    };
    let current = || {
        if cancel.is_cancelled() {
            return Err(Failure::AccessLost);
        }
        operations.current(&action.thread().client_id, generation)?;
        native_scope::current(auth, community, &expected, state).map_err(|_| Failure::AccessLost)
    };
    if current().is_err() {
        return access_lost(app);
    }
    let session = match native_scope::session(auth, expected.generation).await {
        Ok(value) => value,
        Err(_) => return access_lost(app),
    };
    let client = oauth::client()?;
    let outcome = tokio::select! { biased;
        _ = expected.cancel.cancelled() => Err(Failure::AccessLost),
        _ = cancel.cancelled() => Err(Failure::AccessLost),
        result = tokio::time::timeout(Duration::from_secs(60), perform(&client, &session, oauth::GATEWAY, &expected, &action, operations, &current)) => result.unwrap_or(Err(if matches!(action, Action::Decide(_)) { Failure::Uncertain } else { Failure::Unavailable })),
    };
    let outcome = current().and(outcome);
    if matches!(outcome, Err(Failure::AccessLost)) && !cancel.is_cancelled() {
        invalidate_connection_view(app)?;
    }
    Ok(outcome.unwrap_or_else(Failure::public))
}

/// Query only exact reviews belonging to the authenticated native owner.
#[tauri::command]
pub(crate) async fn spaces_query_work_releases<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
    operations: tauri::State<'_, SpacesWorkRelease>,
    input: ThreadInput,
) -> Result<CommandResult, String> {
    command(
        &app,
        &auth,
        &community,
        &state,
        &operations,
        Action::Query(&input),
    )
    .await
}

/// Read one exact owner-private request in the current authenticated thread.
#[tauri::command]
pub(crate) async fn spaces_read_work_release<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
    operations: tauri::State<'_, SpacesWorkRelease>,
    input: ReadInput,
) -> Result<CommandResult, String> {
    command(
        &app,
        &auth,
        &community,
        &state,
        &operations,
        Action::Read(&input),
    )
    .await
}

/// Record the deliberate selected-output decision; this command never publishes.
#[tauri::command]
pub(crate) async fn spaces_decide_work_release<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
    operations: tauri::State<'_, SpacesWorkRelease>,
    input: DecideInput,
) -> Result<CommandResult, String> {
    command(
        &app,
        &auth,
        &community,
        &state,
        &operations,
        Action::Decide(&input),
    )
    .await
}

/// Fetch the exact selected message through Gateway's owner-scoped transport.
#[tauri::command]
pub(crate) async fn spaces_preview_work_release<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
    operations: tauri::State<'_, SpacesWorkRelease>,
    input: ReadInput,
) -> Result<CommandResult, String> {
    command(
        &app,
        &auth,
        &community,
        &state,
        &operations,
        Action::Preview(&input),
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelInput {
    client_id: String,
}
/// Cancel only the hidden view's reads; this never revokes or declines consent.
#[tauri::command]
pub(crate) fn spaces_cancel_work_release(
    operations: tauri::State<'_, SpacesWorkRelease>,
    input: CancelInput,
) -> Result<(), String> {
    operations.cancel(&input.client_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextInput {
    channel_id: String,
    root_event_id: String,
    expected_signer_pubkey: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ThreadContext {
    channel_id: String,
    root_event_id: String,
    expected_relay_url: String,
    expected_signer_pubkey: String,
}
#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum ContextResult {
    Unsupported,
    Ready { context: ThreadContext },
    AccessLost,
    Unavailable,
}
/// Discover the fixed native-origin lookup only when both gates permit it.
/// Gateway resolves the stored original admission; no source/request ID is guessed.
#[tauri::command]
pub(crate) async fn spaces_work_release_context(
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
    input: ContextInput,
) -> Result<ContextResult, String> {
    if !WORK_RELEASE_ENABLED {
        return Ok(ContextResult::Unsupported);
    }
    enabled()?;
    let expected = match native_scope::scope(&auth, &community) {
        Ok(value) => value,
        Err(_) => return Ok(ContextResult::AccessLost),
    };
    if !identifier(&input.channel_id)
        || !digest(&input.root_event_id)
        || input.expected_signer_pubkey != expected.keys.public_key().to_hex()
    {
        return Ok(ContextResult::AccessLost);
    }
    let current = || {
        native_scope::current(&auth, &community, &expected, &state).map_err(|_| Failure::AccessLost)
    };
    if current().is_err() {
        return Ok(ContextResult::AccessLost);
    }
    let session = match native_scope::session(&auth, expected.generation).await {
        Ok(value) => value,
        Err(_) => return Ok(ContextResult::AccessLost),
    };
    let client = oauth::client()?;
    let read = async {
        verify_session(&client, &session, oauth::GATEWAY, &expected, &current).await?;
        let supported = capability(&client, &session, oauth::GATEWAY).await?;
        current()?;
        verify_session(&client, &session, oauth::GATEWAY, &expected, &current).await?;
        current()?;
        Ok::<_, Failure>(supported)
    };
    let result = tokio::select! { biased;
        _ = expected.cancel.cancelled() => Err(Failure::AccessLost),
        result = tokio::time::timeout(Duration::from_secs(45), read) => result.unwrap_or(Err(Failure::Unavailable)),
    };
    Ok(match result {
        Ok(true) => ContextResult::Ready {
            context: ThreadContext {
                channel_id: input.channel_id,
                root_event_id: input.root_event_id,
                expected_relay_url: expected.config.relay_url.replacen("https://", "wss://", 1),
                expected_signer_pubkey: expected.keys.public_key().to_hex(),
            },
        },
        Ok(false) => ContextResult::Unsupported,
        Err(Failure::AccessLost) => ContextResult::AccessLost,
        Err(_) => ContextResult::Unavailable,
    })
}
