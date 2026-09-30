//! Current admitted human, relay and signer fence for owner-scoped Gateway I/O.
use super::{
    community::Configuration, oauth, read_session, SpacesAuth, SpacesCommunity, CANCELLED,
};
use crate::app_state::AppState;
use nostr::Keys;

// Isolated command-body fixtures replace host I/O only. Generation, admitted
// identity, relay, signer and all Gateway checks still run through production code.
#[cfg(test)]
pub(super) struct TestHost {
    session: zeroize::Zeroizing<String>,
    gateway: String,
}
#[cfg(test)]
impl TestHost {
    pub(super) fn new(session: &oauth::Session, gateway: &str) -> Self {
        let url = url::Url::parse(gateway).unwrap();
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.host_str(), Some("127.0.0.1"));
        Self {
            session: session.stored(),
            gateway: gateway.into(),
        }
    }
}

pub(super) fn gateway(auth: &SpacesAuth) -> Result<String, String> {
    #[cfg(test)]
    if let Some(host) = &auth.0.lock().map_err(|_| CANCELLED)?.test_host {
        return Ok(host.gateway.clone());
    }
    let _ = auth;
    Ok(oauth::GATEWAY.into())
}

pub(super) struct Scope {
    pub(super) generation: u64,
    pub(super) cancel: tokio_util::sync::CancellationToken,
    pub(super) config: Configuration,
    pub(super) keys: Keys,
}
pub(super) fn scope(auth: &SpacesAuth, community: &SpacesCommunity) -> Result<Scope, String> {
    let operation = auth.0.lock().map_err(|_| CANCELLED)?;
    let ready = community.ready.lock().map_err(|_| CANCELLED)?;
    let (generation, admitted) = ready.as_ref().ok_or(CANCELLED)?;
    if *generation != operation.generation || operation.cancel.is_cancelled() {
        return Err(CANCELLED.into());
    }
    Ok(Scope {
        generation: *generation,
        cancel: operation.cancel.clone(),
        config: admitted.config.clone(),
        keys: admitted.keys.clone(),
    })
}
pub(super) fn current(
    auth: &SpacesAuth,
    community: &SpacesCommunity,
    expected: &Scope,
    state: &AppState,
) -> Result<(), String> {
    let fresh = scope(auth, community)?;
    if fresh.generation != expected.generation
        || fresh.config != expected.config
        || fresh.keys.public_key() != expected.keys.public_key()
        || crate::relay::relay_api_base_url_with_override(state) != expected.config.relay_url
        || state.signing_keys().map_err(|_| CANCELLED)?.public_key() != expected.keys.public_key()
    {
        return Err(CANCELLED.into());
    }
    Ok(())
}
pub(super) async fn session(auth: &SpacesAuth, generation: u64) -> Result<oauth::Session, String> {
    #[cfg(test)]
    {
        let stored = auth
            .0
            .lock()
            .map_err(|_| CANCELLED)?
            .test_host
            .as_ref()
            .map(|host| host.session.clone());
        if let Some(stored) = stored {
            return auth.current(generation, || {
                serde_json::from_str(&stored).map_err(|_| CANCELLED.into())
            });
        }
    }
    let storage = SpacesAuth(auth.0.clone());
    tokio::task::spawn_blocking(move || storage.current(generation, read_session))
        .await
        .map_err(|_| CANCELLED)?
        .map_err(|_| CANCELLED)?
        .ok_or_else(|| CANCELLED.into())
}
