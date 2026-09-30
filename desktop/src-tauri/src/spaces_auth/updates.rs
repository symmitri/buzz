//! Alpha's private development feed. Credentials and verified archives stay native.
use super::{enabled, oauth, read_session, SpacesAuth, CANCELLED};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio_util::sync::CancellationToken;
use url::Url;

const ORIGIN: &str = "https://spaces-alpha-updates-334562777753.europe-west1.run.app";
const UNAVAILABLE: &str = "Could not check Alpha updates. Check your connection and try again.";
const INVALID: &str = "This Alpha update could not be verified. Check again later.";
const MAX_DOWNLOAD: usize = 512 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct SpacesUpdates {
    operation: tokio::sync::Mutex<()>,
    ready: Mutex<Option<PreparedUpdate>>,
}
impl SpacesUpdates {
    pub(super) fn clear(&self) -> Result<(), String> {
        *self.ready.lock().map_err(|_| INVALID.to_string())? = None;
        Ok(())
    }
}
struct PreparedUpdate {
    generation: u64,
    identity_id: String,
    update: Update,
    bytes: Vec<u8>,
}
#[derive(Serialize)]
pub(crate) struct UpdateReady {
    version: String,
}

fn allowed_download(url: &Url) -> bool {
    let Some(hash) = url
        .path()
        .strip_prefix("/payloads/")
        .and_then(|p| p.strip_suffix(".tar.gz"))
    else {
        return false;
    };
    url.origin().ascii_serialization() == ORIGIN
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

async fn verified_session(
    auth: &SpacesAuth,
) -> Result<(u64, CancellationToken, oauth::Session), String> {
    enabled()?;
    let (generation, cancel) = {
        let current = auth.0.lock().map_err(|_| CANCELLED.to_string())?;
        (current.generation, current.cancel.clone())
    };
    let storage = SpacesAuth(auth.0.clone());
    let session = tokio::task::spawn_blocking(move || storage.current(generation, read_session))
        .await
        .map_err(|_| UNAVAILABLE.to_string())??
        .ok_or("Sign in with Google to check Alpha updates.")?;
    let client = oauth::client()?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CANCELLED.into()),
        result = session.account(&client, oauth::GATEWAY) => { result?; }
    }
    auth.current(generation, || Ok(()))?;
    Ok((generation, cancel, session))
}

/// Check and stage one signature-verified archive. Never installs or restarts.
#[tauri::command]
pub(crate) async fn spaces_prepare_update(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    updates: tauri::State<'_, SpacesUpdates>,
) -> Result<Option<UpdateReady>, String> {
    enabled()?;
    let _guard = updates
        .operation
        .try_lock()
        .map_err(|_| "An Alpha update is already in progress.".to_string())?;
    *updates.ready.lock().map_err(|_| UNAVAILABLE.to_string())? = None;
    let (generation, cancel, session) = verified_session(&auth).await?;
    let updater = app
        .updater_builder()
        .endpoints(vec![
            Url::parse(&format!("{ORIGIN}/alpha.json")).map_err(|_| INVALID)?
        ])
        .map_err(|_| INVALID)?
        .header("Authorization", format!("Bearer {}", session.access_token))
        .map_err(|_| INVALID)?
        .header("Cache-Control", "no-store")
        .map_err(|_| INVALID)?
        .timeout(Duration::from_secs(120))
        // Both manifest and archive requests use this policy. An update URL may
        // not redirect the native company credential to another destination.
        .configure_client(|builder| builder.redirect(reqwest::redirect::Policy::none()))
        .build()
        .map_err(|_| UNAVAILABLE)?;
    let found = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(20), updater.check()) => result.map_err(|_| UNAVAILABLE)?.map_err(|_| UNAVAILABLE)?,
    };
    let Some(update) = found else {
        return auth.current(generation, || Ok(None));
    };
    if !allowed_download(&update.download_url) {
        return Err(INVALID.into());
    }
    let too_large = CancellationToken::new();
    let exceeded = too_large.clone();
    let mut received = 0usize;
    let bytes = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CANCELLED.into()),
        _ = too_large.cancelled() => return Err(INVALID.into()),
        result = update.download(move |count, total| {
            received = received.saturating_add(count);
            if received > MAX_DOWNLOAD || total.is_some_and(|n| n > MAX_DOWNLOAD as u64) { exceeded.cancel() }
        }, || {}) => result.map_err(|_| INVALID)?,
    };
    if bytes.is_empty() || bytes.len() > MAX_DOWNLOAD || too_large.is_cancelled() {
        return Err(INVALID.into());
    }
    // The digest path identifies the payload as well as the Minisign signature.
    use sha2::{Digest, Sha256};
    if !update
        .download_url
        .path()
        .contains(&hex::encode(Sha256::digest(&bytes)))
    {
        return Err(INVALID.into());
    }
    let version = update.version.clone();
    auth.current(generation, || {
        *updates.ready.lock().map_err(|_| UNAVAILABLE.to_string())? = Some(PreparedUpdate {
            generation,
            identity_id: session.identity_id.clone(),
            update,
            bytes,
        });
        Ok(Some(UpdateReady { version }))
    })
}

/// Called only by the existing explicit Update Now action. No forced restart.
#[tauri::command]
pub(crate) async fn spaces_install_update(
    auth: tauri::State<'_, SpacesAuth>,
    updates: tauri::State<'_, SpacesUpdates>,
) -> Result<(), String> {
    let _guard = updates
        .operation
        .try_lock()
        .map_err(|_| "An Alpha update is already in progress.".to_string())?;
    let (generation, _, session) = verified_session(&auth).await?;
    let pending = updates
        .ready
        .lock()
        .map_err(|_| INVALID.to_string())?
        .take()
        .ok_or("Check for an Alpha update first.")?;
    if pending.generation != generation || pending.identity_id != session.identity_id {
        return Err("Your sign-in changed. Check for the update again.".into());
    }
    let auth = SpacesAuth(Arc::clone(&auth.0));
    tokio::task::spawn_blocking(move || {
        auth.current(generation, || {
            pending
                .update
                .install(pending.bytes)
                .map_err(|_| "Alpha could not install the update. Check again and retry.".into())
        })
    })
    .await
    .map_err(|_| INVALID.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn downloads_never_send_company_credentials_outside_alpha() {
        let path = format!("/payloads/{}.tar.gz", "a".repeat(64));
        assert!(allowed_download(
            &Url::parse(&format!("{ORIGIN}{path}")).unwrap()
        ));
        for candidate in [
            format!("https://other.example{path}"),
            format!("http://spaces-alpha-updates-334562777753.europe-west1.run.app{path}"),
            format!("{ORIGIN}{path}?token=x"),
            format!("{ORIGIN}{path}#fragment"),
            format!("{ORIGIN}/alpha.json"),
            format!("{ORIGIN}/payloads/{}.zip", "a".repeat(64)),
            format!("{ORIGIN}/payloads/{}.tar.gz", "A".repeat(64)),
            format!("https://user@spaces-alpha-updates-334562777753.europe-west1.run.app{path}"),
        ] {
            assert!(
                !allowed_download(&Url::parse(&candidate).unwrap()),
                "{candidate}"
            );
        }
    }
}
