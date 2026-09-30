//! Alpha canonical mention eligibility comes from current Gateway bindings and
//! native membership. It never fabricates an independently owned Agent policy.
use super::{
    agents, channel_agents, community::Configuration, enabled, oauth, SpacesAuth, SpacesCommunity,
    CANCELLED,
};
use crate::{app_state::AppState, managed_agents::RelayAgentInfo};
use nostr::{Keys, PublicKey};
use reqwest::Client;
use serde::Serialize;
use std::{collections::HashSet, time::Duration};

const CHANGED: &str = "This company agent or channel changed. Refresh the mention and try again.";
const UNAVAILABLE: &str = "Could not verify company mentions. Refresh and try again.";

#[derive(Serialize)]
/// Current company mention candidates, pinned to one native conversation.
pub(crate) struct CompanyMentions {
    relay_url: String,
    human_pubkey: String,
    channel_id: String,
    agents: Vec<CompanyMention>,
}

#[derive(Serialize)]
struct CompanyMention {
    #[serde(flatten)]
    agent: RelayAgentInfo,
    company_agent_id: String,
}

fn selected(pubkeys: Vec<String>) -> Result<HashSet<String>, String> {
    if pubkeys.is_empty() || pubkeys.len() > 32 {
        return Err(CHANGED.into());
    }
    let mut result = HashSet::new();
    for value in pubkeys {
        let key = PublicKey::from_hex(&value).map_err(|_| CHANGED)?.to_hex();
        if key != value || !result.insert(value) {
            return Err(CHANGED.into());
        }
    }
    Ok(result)
}

/// Use only caller-visible company registry endpoints. No administrator grant
/// projection is read; the runtime independently admits the exact audience.
#[allow(clippy::too_many_arguments)]
pub(super) async fn project(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    config: &Configuration,
    keys: &Keys,
    channel: &str,
    requested: Option<&HashSet<String>>,
    still_current: impl Fn() -> Result<(), String>,
) -> Result<CompanyMentions, String> {
    still_current()?;
    let human = keys.public_key().to_hex();
    let first = agents::read_directory(client, session, gateway, config, &human).await?;
    still_current()?;
    let initial =
        channel_agents::snapshot_for_mentions(client, config, keys, channel, &first.member_pubkeys, true).await?;
    still_current()?;
    // A removal/rebinding during membership I/O must not produce a row based on
    // the previous directory. Both projections must describe the same keys.
    let directory = agents::read_directory(client, session, gateway, config, &human).await?;
    still_current()?;
    let final_members =
        channel_agents::snapshot_for_mentions(client, config, keys, channel, &directory.member_pubkeys, true).await?;
    still_current()?;
    if initial.members != final_members.members || initial.is_dm != final_members.is_dm {
        return Err(CHANGED.into());
    }
    let mut rows = Vec::new();
    for agent in directory.agents {
        if !final_members.is_dm && (!agent.company || agent.private) {
            continue;
        }
        let Some(key) = agent.pubkey else { continue };
        if !final_members.members.contains(&key)
            || requested.is_some_and(|keys| !keys.contains(&key))
        {
            continue;
        }
        if !first.agents.iter().any(|old| {
            old.company == agent.company
                && old.private == agent.private
                && old.id == agent.id
                && old.pubkey.as_deref() == Some(key.as_str())
        }) {
            return Err(CHANGED.into());
        }
        rows.push(CompanyMention {
            company_agent_id: agent.id,
            agent: RelayAgentInfo {
                pubkey: key,
                owner_pubkey: None,
                name: agent.name,
                agent_type: "agent".into(),
                channels: Vec::new(),
                channel_ids: vec![channel.into()],
                capabilities: Vec::new(),
                status: "unknown".into(),
                respond_to: None,
                respond_to_allowlist: Vec::new(),
            },
        });
    }
    if requested.is_some_and(|keys| keys.len() != rows.len()) {
        return Err(CHANGED.into());
    }
    Ok(CompanyMentions {
        relay_url: directory.relay_url,
        human_pubkey: human,
        channel_id: channel.into(),
        agents: rows,
    })
}

#[tauri::command]
/// List current canonical Agents in this human's exact Alpha stream or DM.
pub(crate) async fn spaces_list_company_channel_mentions(
    channel_id: String,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
) -> Result<CompanyMentions, String> {
    enabled()?;
    read(channel_id, None, None, &auth, &community, &state).await
}

#[tauri::command]
/// Recheck every selected company recipient immediately before publication.
pub(crate) async fn spaces_revalidate_company_channel_mentions(
    channel_id: String,
    pubkeys: Vec<String>,
    expected_relay_url: String,
    expected_signer_pubkey: String,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
) -> Result<CompanyMentions, String> {
    enabled()?;
    let requested = selected(pubkeys)?;
    read(
        channel_id,
        Some(requested),
        Some((expected_relay_url, expected_signer_pubkey)),
        &auth,
        &community,
        &state,
    )
    .await
}

async fn read(
    channel: String,
    requested: Option<HashSet<String>>,
    pins: Option<(String, String)>,
    auth: &SpacesAuth,
    community: &SpacesCommunity,
    state: &AppState,
) -> Result<CompanyMentions, String> {
    let expected = channel_agents::scope(auth, community)?;
    if pins.is_some_and(|(relay, human)| {
        relay != expected.config.relay_url.replacen("https://", "wss://", 1)
            || human != expected.keys.public_key().to_hex()
    }) {
        return Err(CANCELLED.into());
    }
    let current = || channel_agents::current(auth, community, &expected, state);
    current()?;
    let session = channel_agents::session(auth, expected.generation).await?;
    current()?;
    let client = oauth::client()?;
    tokio::select! { biased;
        _ = expected.cancel.cancelled() => Err(CANCELLED.into()),
        value = tokio::time::timeout(Duration::from_secs(45), project(&client, &session, oauth::GATEWAY, &expected.config,
            &expected.keys, &channel, requested.as_ref(), current)) => value.map_err(|_| UNAVAILABLE)?,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_mentions_are_exact_bounded_public_keys() {
        let key = Keys::generate().public_key().to_hex();
        assert!(selected(vec![key.clone()]).is_ok());
        for invalid in [
            vec![],
            vec!["invalid".into()],
            vec![key.clone(), key.clone()],
            vec![key.to_uppercase()],
        ] {
            assert!(selected(invalid).is_err());
        }
    }
}
