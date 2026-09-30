//! Installs only the community admitted by native Google/Gateway bootstrap.
use super::{
    community::{self, CommunityInfo, PreparedCommunity},
    enabled, oauth, read_session, SpacesAuth, CANCELLED,
};
use std::{sync::Mutex, time::Duration};
use tauri::Manager;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub(crate) struct SpacesCommunity {
    operation: tokio::sync::Mutex<()>,
    pub(super) ready: Mutex<Option<(u64, PreparedCommunity)>>,
    monitor: Mutex<Option<CancellationToken>>,
}

#[tauri::command]
pub(crate) async fn spaces_connect_community(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
) -> Result<Option<CommunityInfo>, String> {
    enabled()?;
    let _guard = community.operation.lock().await;
    let (generation, cancel) = {
        let current = auth.0.lock().map_err(|_| CANCELLED.to_string())?;
        (current.generation, current.cancel.clone())
    };
    let storage = SpacesAuth(auth.0.clone());
    let session = tokio::task::spawn_blocking(move || storage.current(generation, read_session))
        .await
        .map_err(|_| CANCELLED.to_string())??
        .ok_or("Sign in with Google to open Alpha.")?;
    let client = oauth::client()?;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(90), async {
            let account = session.account(&client, oauth::GATEWAY).await?;
            community::prepare(&client, &session, &account, oauth::GATEWAY, async |config| {
                let storage = SpacesAuth(auth.0.clone());
                tokio::task::spawn_blocking(move || storage.current(generation, || community::key_for_scope(&config, oauth::GATEWAY)))
                    .await.map_err(|_| CANCELLED.to_string())?
            }).await
        }) => result.map_err(|_| "Alpha messaging took too long to connect. Try again.".to_string())??,
    };
    let info = auth.current(generation, || {
        let mut ready = community.ready.lock().map_err(|_| CANCELLED.to_string())?;
        let info = result.as_ref().map(PreparedCommunity::public_info);
        *ready = result.map(|value| (generation, value));
        Ok(info)
    })?;
    if let Some(info) = &info {
        apply_workspace(&app, &info.relay_url, None)?;
        let expected = community
            .ready
            .lock()
            .map_err(|_| CANCELLED.to_string())?
            .as_ref()
            .ok_or(CANCELLED)?
            .1
            .config
            .clone();
        let monitor = CancellationToken::new();
        if let Some(previous) = community
            .monitor
            .lock()
            .map_err(|_| CANCELLED.to_string())?
            .replace(monitor.clone())
        {
            previous.cancel();
        }
        let auth = SpacesAuth(auth.0.clone());
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = monitor.cancelled() => return,
                    _ = cancel.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {},
                }
                let valid = async {
                    session.account(&client, oauth::GATEWAY).await?;
                    let current =
                        community::configuration(&client, &session, oauth::GATEWAY).await?;
                    if current.as_ref() != Some(&expected) {
                        return Err(CANCELLED.to_string());
                    }
                    Ok::<_, String>(())
                };
                let result = tokio::select! {
                    biased;
                    _ = monitor.cancelled() => return,
                    _ = cancel.cancelled() => return,
                    result = tokio::time::timeout(Duration::from_secs(45), valid) => result,
                };
                if !matches!(result, Ok(Ok(()))) {
                    // Restart closes all old native sockets and caches before
                    // another account can enter the vanilla community tree.
                    let _ = auth.current::<()>(generation, || {
                        app.restart();
                    });
                    return;
                }
            }
        });
    }
    Ok(info)
}

/// Called from the real workspace command. Renderer input cannot substitute a
/// community or signing key, and upstream agent restoration is not run here.
pub(crate) fn apply_workspace(
    app: &tauri::AppHandle,
    relay_url: &str,
    nsec: Option<&str>,
) -> Result<(), String> {
    enabled()?;
    if nsec.is_some() {
        return Err("Alpha messaging identity is managed through Google sign-in.".into());
    }
    let auth = app.state::<SpacesAuth>();
    let community = app.state::<SpacesCommunity>();
    let operation = auth.0.lock().map_err(|_| CANCELLED.to_string())?;
    let ready = community.ready.lock().map_err(|_| CANCELLED.to_string())?;
    let (generation, admitted) = ready
        .as_ref()
        .ok_or("Connect Alpha through Google sign-in first.")?;
    if *generation != operation.generation
        || operation.cancel.is_cancelled()
        || relay_url != admitted.public_info().relay_url
    {
        return Err("Your Alpha connection changed. Sign in again.".into());
    }
    let state = app.state::<crate::app_state::AppState>();
    // Take all fallible locks before changing either member of the scope.
    let mut relay = state
        .relay_url_override
        .lock()
        .map_err(|_| CANCELLED.to_string())?;
    let mut keys = state.keys.lock().map_err(|_| CANCELLED.to_string())?;
    *relay = Some(relay_url.to_string());
    *keys = admitted.keys.clone();
    crate::relay_admission::reset_gate_for_workspace_change();
    Ok(())
}
