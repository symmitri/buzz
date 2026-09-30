use serde::Deserialize;
use std::collections::HashSet;
use tauri::State;

use crate::{
    app_state::AppState,
    events,
    models::ChannelInfo,
    nostr_convert,
    relay::{
        assert_expected_relay_scope, assert_expected_signer, parse_command_response,
        query_relay_at_with_keys, submit_event, submit_event_at_with_keys,
    },
};

#[derive(Deserialize)]
struct OpenDmAck {
    channel_id: String,
}

const MAX_DM_RECIPIENTS: usize = 8;

fn normalize_dm_recipients(pubkeys: Vec<String>, signer: &str) -> Result<Vec<String>, String> {
    if pubkeys.is_empty() || pubkeys.len() > MAX_DM_RECIPIENTS {
        return Err("Choose between one and eight recipients.".into());
    }

    let signer = signer.to_ascii_lowercase();
    let mut normalized = Vec::with_capacity(pubkeys.len());
    let mut seen = HashSet::with_capacity(pubkeys.len());
    for pubkey in pubkeys {
        if pubkey.len() != 64 || !pubkey.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Choose a valid person before sending.".into());
        }
        let pubkey = pubkey.to_ascii_lowercase();
        if !seen.insert(pubkey.clone()) {
            return Err("Choose each recipient once.".into());
        }
        normalized.push(pubkey);
    }

    if normalized.iter().any(|pubkey| pubkey == &signer) && normalized.len() != 1 {
        return Err("Message yourself separately from other people.".into());
    }
    Ok(normalized)
}

#[tauri::command]
pub async fn open_dm(
    pubkeys: Vec<String>,
    expected_relay_url: Option<String>,
    expected_signer_pubkey: Option<String>,
    state: State<'_, AppState>,
) -> Result<ChannelInfo, String> {
    open_dm_with_scope(
        pubkeys,
        expected_relay_url.as_deref(),
        expected_signer_pubkey.as_deref(),
        &state,
    )
    .await
}

pub(crate) async fn open_dm_with_scope(
    pubkeys: Vec<String>,
    expected_relay_url: Option<&str>,
    expected_signer_pubkey: Option<&str>,
    state: &AppState,
) -> Result<ChannelInfo, String> {
    // Resolve the relay AND the signing identity once for the open + metadata
    // read pair. Callers with a captured tenant scope (Projects agent sends)
    // pass `expected_relay_url` and `expected_signer_pubkey`; a mismatch on
    // either means the active community changed while their callback was
    // suspended. The relay check alone is not enough: relay and keys mutate
    // under separate locks during a workspace switch, so a switch landing
    // between the URL check and the key read would otherwise create the
    // tenant-A DM signed as tenant B's identity — fail closed instead, and
    // use this exact key snapshot for both the event signature and the
    // NIP-98 auth of every request in this command.
    let api_base_url = crate::relay::relay_api_base_url_with_override(state);
    assert_expected_relay_scope(expected_relay_url, &api_base_url)?;
    let keys = state.signing_keys()?;
    assert_expected_signer(expected_signer_pubkey, &keys.public_key().to_hex())?;
    let pubkeys = normalize_dm_recipients(pubkeys, &keys.public_key().to_hex())?;

    // Submit a kind:41010 dm-open event; the relay replies with the channel id
    // in its OK message payload.
    let builder = events::build_dm_open(&pubkeys)?;
    let result = submit_event_at_with_keys(builder, state, &api_base_url, &keys).await?;
    let ack: OpenDmAck = parse_command_response(&result.message)?;

    // Re-fetch the channel metadata so the frontend gets the same `ChannelInfo`
    // shape as `get_channel_details` — through the same scope-checked base and
    // the same pinned identity.
    let metadata = query_relay_at_with_keys(
        state,
        &api_base_url,
        &[serde_json::json!({
            "kinds": [39000],
            "#d": [ack.channel_id],
            "limit": 1
        })],
        &keys,
        None,
    )
    .await?;

    if let Some(event) = metadata.first() {
        crate::spaces_auth::conversations::consent(
            state,
            &api_base_url,
            &keys,
            &ack.channel_id,
            event,
            &pubkeys,
        )
        .await?;
    }

    metadata
        .first()
        .map(|ev| nostr_convert::channel_info_from_event(ev, None, None))
        .transpose()?
        .ok_or_else(|| "DM channel created but metadata not yet available".to_string())
}

#[tauri::command]
pub async fn hide_dm(channel_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let builder = events::build_dm_hide(&channel_id)?;
    submit_event(builder, &state).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nostr::Keys;

    fn key(byte: u8) -> String {
        Keys::parse(&format!("{byte:02x}").repeat(32))
            .unwrap()
            .public_key()
            .to_hex()
    }

    #[test]
    fn recipients_allow_only_an_explicit_own_only_self_dm() {
        let own = key(1);
        let peer = key(2);
        assert_eq!(
            normalize_dm_recipients(vec![own.to_ascii_uppercase()], &own).unwrap(),
            vec![own.clone()]
        );
        assert_eq!(
            normalize_dm_recipients(vec![peer.clone()], &own).unwrap(),
            vec![peer.clone()]
        );
        assert!(normalize_dm_recipients(vec![], &own).is_err());
        assert!(normalize_dm_recipients(vec!["invalid".into()], &own).is_err());
        assert!(normalize_dm_recipients(vec![own.clone(), peer], &own).is_err());
        assert!(normalize_dm_recipients(vec![own.clone(), own.clone()], &own).is_err());
        assert!(normalize_dm_recipients(vec![key(2), key(2)], &own).is_err());
        assert!(normalize_dm_recipients((2..=10).map(key).collect(), &own).is_err());
    }
}
