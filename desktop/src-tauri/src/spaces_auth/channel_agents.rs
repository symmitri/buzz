//! Explicit company Agent attachment: native membership plus one exact shared
//! Gateway audience. Existing capabilities and other audiences are preserved.
pub(super) use super::native_scope::{current, scope, session};
use super::{
    agents, community::Configuration, enabled, oauth, SpacesAuth, SpacesCommunity, CANCELLED,
};
use crate::app_state::AppState;
use nostr::{Event, Keys, Kind};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;

const CHANGED: &str = "This channel or agent changed. Refresh before trying again.";
const DENIED: &str = "A company administrator manages channel agent access.";
const UNAVAILABLE: &str = "Could not check channel agent access. Refresh to try again.";
const UNCONFIRMED: &str =
    "The change could not be confirmed. Refresh to check its current state before trying again.";
const LIMIT: usize = 262_144;
const CHANNEL_LIMIT: &str = "Agent replies support channels with at most 128 company members.";

#[derive(Default)]
pub(crate) struct SpacesChannelAgents(tokio::sync::Mutex<()>);

#[derive(Serialize)]
pub(crate) struct ChannelAgents {
    relay_url: String,
    human_pubkey: String,
    channel_id: String,
    agents: Vec<ChannelAgent>,
}
#[derive(Serialize)]
struct ChannelAgent {
    id: String,
    name: String,
    description: String,
    pubkey: Option<String>,
    in_channel: bool,
    ready: bool,
    can_add: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable_reason: Option<String>,
}
#[derive(Serialize)]
pub(crate) struct AddResult {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}
impl AddResult {
    fn confirmed() -> Self {
        Self {
            state: "confirmed",
            message: None,
        }
    }
    fn unconfirmed() -> Self {
        Self {
            state: "not_confirmed",
            message: Some(UNCONFIRMED.into()),
        }
    }
}

#[derive(Deserialize)]
struct Workspace {
    schema_version: u64,
    principal: Identity,
    company: Identity,
    permissions: Permissions,
}
#[derive(Deserialize)]
struct Identity {
    id: String,
}
#[derive(Deserialize)]
struct Permissions {
    manage_gateway: bool,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct Connection {
    connection_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    credential_identity_id: String,
}
#[derive(Deserialize)]
struct Skill {
    release_id: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct Audience {
    provider: String,
    tenant_id: String,
    channel_id: String,
    display_name: String,
    visibility: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    identity_id: String,
}
#[derive(Deserialize)]
struct AudienceOption {
    provider: String,
    tenant_id: String,
    visibility: String,
}
#[derive(Deserialize)]
struct Grants {
    agent_id: String,
    org_id: String,
    workload_id: String,
    version: i64,
    connections: Vec<Connection>,
    skills: Vec<Skill>,
    audiences: Vec<Audience>,
    audience_options: Vec<AudienceOption>,
}
#[derive(Serialize, PartialEq, Eq)]
struct Replacement {
    expected_version: i64,
    connections: Vec<Connection>,
    skill_release_ids: Vec<String>,
    audiences: Vec<Audience>,
}

async fn response<T: serde::de::DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, String> {
    let mut response = request
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| UNAVAILABLE)?;
    if response.status() == StatusCode::FORBIDDEN {
        return Err(DENIED.into());
    }
    if !response.status().is_success()
        || response.content_length().is_some_and(|n| n > LIMIT as u64)
    {
        return Err(UNAVAILABLE.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if bytes.len().saturating_add(chunk.len()) > LIMIT {
            return Err(UNAVAILABLE.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE.into())
}
async fn admin(client: &Client, session: &oauth::Session, gateway: &str) -> Result<bool, String> {
    let view: Workspace = response(
        client
            .get(format!("{gateway}/v1/admin/workspace"))
            .bearer_auth(&session.access_token),
    )
    .await?;
    if view.schema_version != 1
        || view.principal.id != session.identity_id
        || view.company.id != session.org_id
    {
        return Err(CHANGED.into());
    }
    Ok(view.permissions.manage_gateway)
}
async fn grants(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    agent: &str,
) -> Result<Grants, String> {
    let value: Grants = response(
        client
            .get(format!("{gateway}/v1/agents/{agent}/grants"))
            .bearer_auth(&session.access_token),
    )
    .await?;
    if value.agent_id != agent
        || value.org_id != session.org_id
        || value.workload_id.is_empty()
        || value.version < 0
        || value.connections.len() > 100
        || value.skills.len() > 100
        || value.audiences.len() > 100
    {
        return Err(CHANGED.into());
    }
    Ok(value)
}
impl Grants {
    fn exact_audience(&self, config: &Configuration, channel: &str) -> Result<bool, String> {
        let found: Vec<_> = self
            .audiences
            .iter()
            .filter(|a| {
                a.provider == "buzz" && a.tenant_id == config.tenant_id && a.channel_id == channel
            })
            .collect();
        if found.len() > 1
            || found
                .first()
                .is_some_and(|a| a.visibility != "shared" || !a.identity_id.is_empty())
        {
            return Err(CHANGED.into());
        }
        Ok(!found.is_empty())
    }
    fn replacement(
        &self,
        config: &Configuration,
        channel: &str,
        name: &str,
    ) -> Result<Replacement, String> {
        if !self.audience_options.iter().any(|a| {
            a.provider == "buzz" && a.tenant_id == config.tenant_id && a.visibility == "shared"
        }) {
            return Err("This agent is not configured for shared channel replies.".into());
        }
        let mut audiences = self.audiences.clone();
        if !self.exact_audience(config, channel)? {
            if audiences.len() >= 100 {
                return Err("This agent has reached its channel access limit.".into());
            }
            audiences.push(Audience {
                provider: "buzz".into(),
                tenant_id: config.tenant_id.clone(),
                channel_id: channel.into(),
                display_name: name.into(),
                visibility: "shared".into(),
                identity_id: String::new(),
            });
        }
        Ok(Replacement {
            expected_version: self.version,
            connections: self.connections.clone(),
            skill_release_ids: self.skills.iter().map(|s| s.release_id.clone()).collect(),
            audiences,
        })
    }
}

pub(super) struct Snapshot {
    pub(super) members: HashSet<String>,
    name: String,
}
fn single(event: &Event, name: &str) -> Result<Option<String>, String> {
    let values: Vec<_> = event
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|v| v == name))
        .collect();
    if values.len() > 1 || values.first().is_some_and(|tag| tag.as_slice().len() != 2) {
        return Err(CHANGED.into());
    }
    Ok(values.first().map(|tag| tag.as_slice()[1].clone()))
}
pub(super) async fn snapshot(
    client: &Client,
    config: &Configuration,
    keys: &Keys,
    channel: &str,
    known: &HashSet<String>,
) -> Result<Snapshot, String> {
    let uuid = Uuid::parse_str(channel).map_err(|_| CHANGED)?;
    if uuid.to_string() != channel {
        return Err(CHANGED.into());
    }
    let url = format!("{}/query", config.relay_url);
    let body = serde_json::to_vec(&serde_json::json!([
        {"kinds":[39000],"authors":[config.relay_pubkey],"#d":[channel],"limit":1},
        {"kinds":[39002],"authors":[config.relay_pubkey],"#d":[channel],"limit":1}
    ]))
    .map_err(|_| CHANGED)?;
    let auth = crate::relay::build_nip98_auth_header_for_keys(keys, &Method::POST, &url, &body)?;
    let events: Vec<Event> = response(
        client
            .post(url)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .body(body),
    )
    .await?;
    if events.len() != 2
        || events.iter().any(|e| {
            e.verify().is_err()
                || e.pubkey.to_hex() != config.relay_pubkey
                || single(e, "d").ok().flatten().as_deref() != Some(channel)
        })
    {
        return Err(CHANGED.into());
    }
    let metadata = events
        .iter()
        .find(|e| e.kind == Kind::Custom(39000))
        .ok_or(CHANGED)?;
    let membership = events
        .iter()
        .find(|e| e.kind == Kind::Custom(39002))
        .ok_or(CHANGED)?;
    if !matches!(single(metadata, "t")?.as_deref(), Some("stream"))
        || single(metadata, "archived")?.as_deref() == Some("true")
    {
        return Err("Company agent replies are supported in active stream channels only.".into());
    }
    let mut members = HashSet::new();
    for tag in membership
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|v| v == "p"))
    {
        let values = tag.as_slice();
        if !(values.len() == 2
            || values.len() == 4
                && values[2].is_empty()
                && matches!(
                    values[3].as_str(),
                    "owner" | "admin" | "member" | "bot" | "guest"
                ))
            || !known.contains(&values[1])
            || !members.insert(values[1].clone())
        {
            return Err("Every channel member must have an active company identity before agent replies can be enabled.".into());
        }
    }
    if members.len() > 128 {
        return Err(CHANNEL_LIMIT.into());
    }
    if !members.contains(&keys.public_key().to_hex()) {
        return Err("Join this channel before adding an agent.".into());
    }
    let name = single(metadata, "name")?
        .filter(|s| {
            !s.trim().is_empty()
                && s.len() <= 120
                && s.is_ascii()
                && !s.chars().any(char::is_control)
        })
        .unwrap_or_else(|| "Buzz channel".into());
    Ok(Snapshot { members, name })
}

async fn list(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    config: &Configuration,
    keys: &Keys,
    channel: &str,
) -> Result<ChannelAgents, String> {
    let human = keys.public_key().to_hex();
    let directory = agents::read_directory(client, session, gateway, config, &human).await?;
    let scope = snapshot(client, config, keys, channel, &directory.member_pubkeys).await?;
    let can_manage = admin(client, session, gateway).await?;
    let companies: Vec<_> = directory
        .agents
        .into_iter()
        .filter(|a| a.company && !a.private)
        .collect();
    if companies.len() > 32 {
        return Err(UNAVAILABLE.into());
    }
    let mut agents = Vec::new();
    for agent in companies {
        let in_channel = agent
            .pubkey
            .as_ref()
            .is_some_and(|key| scope.members.contains(key));
        let mut ready = false;
        let reason = if agent.pubkey.is_none() {
            Some("This agent is not connected to Spaces Alpha yet.".into())
        } else if !in_channel && scope.members.len() >= 128 {
            Some(CHANNEL_LIMIT.into())
        } else if !can_manage {
            Some(DENIED.into())
        } else {
            match grants(client, session, gateway, &agent.id)
                .await
                .and_then(|s| {
                    s.replacement(config, channel, &scope.name)?;
                    s.exact_audience(config, channel)
                }) {
                Ok(granted) => {
                    ready = in_channel && granted;
                    None
                }
                Err(reason) => Some(reason),
            }
        };
        agents.push(ChannelAgent {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            pubkey: agent.pubkey,
            in_channel,
            ready,
            can_add: !ready && reason.is_none(),
            unavailable_reason: reason,
        });
    }
    Ok(ChannelAgents {
        relay_url: directory.relay_url,
        human_pubkey: human,
        channel_id: channel.into(),
        agents,
    })
}

#[allow(clippy::too_many_arguments)]
async fn add(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    config: &Configuration,
    keys: &Keys,
    channel: &str,
    agent_id: &str,
    pubkey: &str,
    current: impl Fn() -> Result<(), String>,
) -> Result<AddResult, String> {
    current()?;
    let human = keys.public_key().to_hex();
    let directory = agents::read_directory(client, session, gateway, config, &human).await?;
    if !directory
        .agents
        .iter()
        .any(|a| a.company && !a.private && a.id == agent_id && a.pubkey.as_deref() == Some(pubkey))
    {
        return Err(CHANGED.into());
    }
    if !admin(client, session, gateway).await? {
        return Err(DENIED.into());
    }
    let before = snapshot(client, config, keys, channel, &directory.member_pubkeys).await?;
    if !before.members.contains(pubkey) && before.members.len() >= 128 {
        return Err(CHANNEL_LIMIT.into());
    }
    let initial = grants(client, session, gateway, agent_id).await?;
    let granted = initial.exact_audience(config, channel)?;
    let planned = serde_json::to_vec(&initial.replacement(config, channel, &before.name)?)
        .map_err(|_| CHANGED)?;
    if planned.len() > 65536 {
        return Err(UNAVAILABLE.into());
    }
    if before.members.contains(pubkey) && granted {
        current()?;
        return Ok(AddResult::confirmed());
    }
    if !before.members.contains(pubkey) {
        current()?;
        let uuid = Uuid::parse_str(channel).map_err(|_| CHANGED)?;
        let event = crate::events::build_add_member(uuid, pubkey, Some("bot"))?
            .sign_with_keys(keys)
            .map_err(|_| UNCONFIRMED)?;
        let body = serde_json::to_vec(&event).map_err(|_| UNCONFIRMED)?;
        let url = format!("{}/events", config.relay_url);
        let auth =
            crate::relay::build_nip98_auth_header_for_keys(keys, &Method::POST, &url, &body)?;
        // One immutable native write. On any response, inspect current membership;
        // never publish a newly signed retry or compensate by removing members.
        let _ = client
            .post(url)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await;
    }
    current()?;
    let fresh = agents::read_directory(client, session, gateway, config, &human).await?;
    if !fresh
        .agents
        .iter()
        .any(|a| a.company && !a.private && a.id == agent_id && a.pubkey.as_deref() == Some(pubkey))
    {
        return Ok(AddResult::unconfirmed());
    }
    let joined = snapshot(client, config, keys, channel, &fresh.member_pubkeys).await?;
    let mut wanted = before.members;
    wanted.insert(pubkey.into());
    if joined.members != wanted {
        return Ok(AddResult::unconfirmed());
    }
    if !admin(client, session, gateway).await? {
        return Ok(AddResult::unconfirmed());
    }
    let live = grants(client, session, gateway, agent_id).await?;
    let already_granted = live.exact_audience(config, channel)?;
    let mut replacement = live.replacement(config, channel, &joined.name)?;
    if !already_granted {
        let body = serde_json::to_vec(&replacement).map_err(|_| UNCONFIRMED)?;
        if body.len() > 65536 {
            return Err(UNAVAILABLE.into());
        }
        current()?;
        // CAS is not retried. Readback is the only recovery for an uncertain PUT.
        let _ = client
            .put(format!("{gateway}/v1/agents/{agent_id}/grants"))
            .bearer_auth(&session.access_token)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await;
    }
    current()?;
    let after = grants(client, session, gateway, agent_id).await?;
    let final_directory = agents::read_directory(client, session, gateway, config, &human).await?;
    let final_members = snapshot(
        client,
        config,
        keys,
        channel,
        &final_directory.member_pubkeys,
    )
    .await?;
    current()?;
    let mut observed = after.replacement(config, channel, &joined.name)?;
    let expected_version = live
        .version
        .checked_add(i64::from(!already_granted))
        .ok_or(CHANGED)?;
    for value in [&mut replacement, &mut observed] {
        value.expected_version = 0;
        value.connections.sort();
        value.skill_release_ids.sort();
        value.audiences.sort();
    }
    if after.version != expected_version
        || observed != replacement
        || !after.exact_audience(config, channel)?
        || final_members.members != wanted
        || !final_directory.agents.iter().any(|a| {
            a.company && !a.private && a.id == agent_id && a.pubkey.as_deref() == Some(pubkey)
        })
    {
        return Ok(AddResult::unconfirmed());
    }
    Ok(AddResult::confirmed())
}

/// Return only company Agents bound to the current native channel scope.
#[tauri::command]
pub(crate) async fn spaces_list_channel_agents(
    channel_id: String,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
) -> Result<ChannelAgents, String> {
    enabled()?;
    let expected = scope(&auth, &community)?;
    current(&auth, &community, &expected, &state)?;
    let session = session(&auth, expected.generation).await?;
    let client = oauth::client()?;
    let result = tokio::select! { biased;
        _ = expected.cancel.cancelled() => return Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(45), list(&client, &session, oauth::GATEWAY, &expected.config, &expected.keys, &channel_id)) => result.map_err(|_| UNAVAILABLE)??,
    };
    current(&auth, &community, &expected, &state)?;
    Ok(result)
}

/// Explicitly add one current company Agent and authorize its exact shared audience.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn spaces_add_channel_agent(
    channel_id: String,
    agent_id: String,
    expected_pubkey: String,
    expected_relay_url: String,
    expected_signer_pubkey: String,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    operations: tauri::State<'_, SpacesChannelAgents>,
    state: tauri::State<'_, AppState>,
) -> Result<AddResult, String> {
    enabled()?;
    let _operation = operations
        .0
        .try_lock()
        .map_err(|_| "An agent change is already being checked. Refresh shortly.")?;
    let expected = scope(&auth, &community)?;
    if expected.config.relay_url.replacen("https://", "wss://", 1) != expected_relay_url
        || expected.keys.public_key().to_hex() != expected_signer_pubkey
    {
        return Err(CANCELLED.into());
    }
    let session = session(&auth, expected.generation).await?;
    let client = oauth::client()?;
    tokio::select! { biased;
        _ = expected.cancel.cancelled() => Err(CANCELLED.into()),
        result = tokio::time::timeout(Duration::from_secs(90), add(&client, &session, oauth::GATEWAY, &expected.config, &expected.keys,
            &channel_id, &agent_id, &expected_pubkey, || current(&auth, &community, &expected, &state))) => result.map_err(|_| UNCONFIRMED)?,
    }
}

#[cfg(test)]
#[path = "channel_agents_tests.rs"]
mod tests;
