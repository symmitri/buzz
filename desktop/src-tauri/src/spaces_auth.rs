//! Symmitri modification: Alpha-only Google sign-in and native credential custody.
pub(crate) mod agents;
mod community;
pub(crate) mod community_session;
pub(crate) mod connections;
pub(crate) mod conversations;
mod oauth;
pub(crate) use community_session::SpacesCommunity;
pub(crate) use connections::SpacesConnections;
pub(crate) mod updates;
pub(crate) use updates::SpacesUpdates;

use oauth::{Account, Session, GATEWAY};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

const STORAGE_ERROR: &str = "Spaces Alpha could not access its sign-in in macOS Keychain. Try again after unlocking Keychain.";
const CANCELLED: &str = "Sign-in was cancelled.";

fn invalidate_connection_view(app: &tauri::AppHandle) -> Result<(), String> {
    app.emit("spaces-connections-invalidated", ())
        .map_err(|_| "Could not clear connection details. Close Settings and try again.".into())
}

#[derive(Default)]
pub(crate) struct SpacesAuth(Arc<Mutex<Operation>>);

#[derive(Default)]
struct Operation {
    generation: u64,
    cancel: CancellationToken,
}

impl SpacesAuth {
    fn begin(&self) -> Result<(u64, CancellationToken), String> {
        let mut current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        current.cancel.cancel();
        current.generation = current.generation.wrapping_add(1);
        current.cancel = CancellationToken::new();
        Ok((current.generation, current.cancel.clone()))
    }

    // Serialize the generation check with storage, including sign-out. A late
    // callback or restore can never re-save a replaced account.
    fn current<T>(
        &self,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        if current.generation != generation || current.cancel.is_cancelled() {
            return Err(CANCELLED.into());
        }
        action()
    }
}

fn enabled() -> Result<(), String> {
    if crate::build_identity::demo_slug() != Some("spaces-alpha") {
        return Err("Company sign-in is available only in Spaces Alpha.".into());
    }
    Ok(())
}

#[cfg(all(target_os = "macos", feature = "system-keyring"))]
fn entry() -> Result<keyring::Entry, String> {
    enabled()?;
    // Fixed service and account; never inspect Spaces Dev or upstream identities.
    keyring::Entry::new("ai.symmitri.spaces.alpha", "gateway-session")
        .map_err(|_| STORAGE_ERROR.into())
}

fn read_session() -> Result<Option<Session>, String> {
    #[cfg(all(target_os = "macos", feature = "system-keyring"))]
    {
        let secret = match entry()?.get_password() {
            Ok(value) => Zeroizing::new(value),
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err(STORAGE_ERROR.into()),
        };
        if secret.len() > 64_000 {
            return Err(STORAGE_ERROR.into());
        }
        serde_json::from_str(&secret)
            .map(Some)
            .map_err(|_| STORAGE_ERROR.into())
    }
    #[cfg(not(all(target_os = "macos", feature = "system-keyring")))]
    {
        Err(STORAGE_ERROR.into())
    }
}

fn save_session(session: &Session) -> Result<(), String> {
    #[cfg(all(target_os = "macos", feature = "system-keyring"))]
    {
        entry()?
            .set_password(&session.stored())
            .map_err(|_| STORAGE_ERROR.into())
    }
    #[cfg(not(all(target_os = "macos", feature = "system-keyring")))]
    {
        let _ = session;
        Err(STORAGE_ERROR.into())
    }
}

fn delete_session() -> Result<(), String> {
    #[cfg(all(target_os = "macos", feature = "system-keyring"))]
    {
        match entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(STORAGE_ERROR.into()),
        }
    }
    #[cfg(not(all(target_os = "macos", feature = "system-keyring")))]
    {
        Err(STORAGE_ERROR.into())
    }
}

#[tauri::command]
pub(crate) async fn spaces_list_agents(
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
) -> Result<agents::AgentDirectory, String> {
    enabled()?;
    let (generation, cancel, expected, human_pubkey) = {
        let operation = auth.0.lock().map_err(|_| CANCELLED.to_string())?;
        let ready = community.ready.lock().map_err(|_| CANCELLED.to_string())?;
        let (generation, admitted) = ready.as_ref().ok_or(CANCELLED)?;
        if *generation != operation.generation || operation.cancel.is_cancelled() {
            return Err(CANCELLED.into());
        }
        (
            *generation,
            operation.cancel.clone(),
            admitted.config.clone(),
            admitted.keys.public_key().to_hex(),
        )
    };
    let storage = SpacesAuth(auth.0.clone());
    let session = tokio::task::spawn_blocking(move || storage.current(generation, read_session))
        .await
        .map_err(|_| CANCELLED.to_string())??
        .ok_or(CANCELLED)?;
    let client = oauth::client()?;
    let directory = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(45), agents::read_directory(
            &client, &session, oauth::GATEWAY, &expected, &human_pubkey
        )) => result.map_err(|_| "Agent directory took too long to load. Try again.".to_string())??,
    };
    auth.current(generation, || {
        let ready = community.ready.lock().map_err(|_| CANCELLED.to_string())?;
        let (current_generation, admitted) = ready.as_ref().ok_or(CANCELLED)?;
        if *current_generation != generation
            || admitted.config != expected
            || admitted.keys.public_key().to_hex() != human_pubkey
        {
            return Err(CANCELLED.into());
        }
        Ok(directory)
    })
}

#[tauri::command]
pub(crate) async fn spaces_start_google_login(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
) -> Result<Account, String> {
    enabled()?;
    connections.invalidate()?;
    let (generation, cancel) = auth.begin()?;
    invalidate_connection_view(&app)?;
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(300), oauth::login(GATEWAY, |url| {
            app.opener().open_url(url, None::<&str>)
                .map_err(|_| "Could not open your browser. Try again.".into())
        })) => result.map_err(|_| "Sign-in timed out. Try again.".to_string())?,
    };
    let (session, account) = result?;
    let auth = SpacesAuth(auth.0.clone());
    tokio::task::spawn_blocking(move || {
        auth.current(generation, || {
            save_session(&session)?;
            Ok(account)
        })
    })
    .await
    .map_err(|_| STORAGE_ERROR.to_string())?
}

#[tauri::command]
pub(crate) async fn spaces_get_google_account(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
) -> Result<Option<Account>, String> {
    enabled()?;
    connections.invalidate()?;
    let (generation, cancel) = auth.begin()?;
    invalidate_connection_view(&app)?;
    let storage_auth = SpacesAuth(auth.0.clone());
    let session =
        tokio::task::spawn_blocking(move || storage_auth.current(generation, read_session))
            .await
            .map_err(|_| STORAGE_ERROR.to_string())??;
    let Some(session) = session else {
        return auth.current(generation, || Ok(None));
    };
    let client = oauth::client()?;
    let account = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CANCELLED.into()),
        result = session.account(&client, GATEWAY) => result?,
    };
    auth.current(generation, || Ok(Some(account)))
}

#[tauri::command]
pub(crate) fn spaces_cancel_google_login(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
) -> Result<(), String> {
    enabled()?;
    connections.invalidate()?;
    auth.begin()?;
    invalidate_connection_view(&app)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn spaces_forget_google_account(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    updates: tauri::State<'_, SpacesUpdates>,
    connections: tauri::State<'_, SpacesConnections>,
) -> Result<(), String> {
    enabled()?;
    connections.invalidate()?;
    let (generation, _) = auth.begin()?;
    invalidate_connection_view(&app)?;
    updates.clear()?;
    let auth = SpacesAuth(auth.0.clone());
    tokio::task::spawn_blocking(move || auth.current(generation, delete_session))
        .await
        .map_err(|_| STORAGE_ERROR.to_string())??;
    // A process restart closes every native/renderer socket and drops keys and
    // cached messages together. Protected community keys remain recoverable.
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaced_cancelled_and_signed_out_operations_cannot_commit() {
        let auth = SpacesAuth::default();
        let (old, cancel) = auth.begin().unwrap();
        let (new, _) = auth.begin().unwrap();
        assert!(cancel.is_cancelled());
        let mut writes = 0;
        assert!(auth
            .current(old, || {
                writes += 1;
                Ok(())
            })
            .is_err());
        auth.current(new, || {
            writes += 1;
            Ok(())
        })
        .unwrap();
        let (sign_out, _) = auth.begin().unwrap();
        auth.current(sign_out, || {
            writes = 0;
            Ok(())
        })
        .unwrap();
        assert!(auth
            .current(new, || {
                writes += 1;
                Ok(())
            })
            .is_err());
        assert_eq!(writes, 0);
    }
}
