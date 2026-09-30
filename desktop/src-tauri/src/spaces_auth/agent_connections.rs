//! Read-only, Agent-specific projection of the existing governed grant API.
//! Never exposes grant candidates, account identifiers, audiences or credentials.
use super::{agents, community::Configuration, oauth};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const UNAVAILABLE: &str = "Could not load this agent's connections. Refresh to try again.";
const CHANGED: &str = "This agent's Alpha identity changed. Reopen its profile.";
const DENIED: &str = "You do not have permission to view this agent's connections.";

#[derive(Deserialize)]
struct GrantState {
    agent_id: String,
    org_id: String,
    #[serde(default)]
    workload_id: String,
    version: i64,
    connections: Option<Vec<Grant>>,
}

#[derive(Deserialize)]
struct Grant {
    connection_id: String,
    alias: String,
    provider: String,
    credential_scope: String,
    #[serde(default)]
    credential_owner_type: String,
}

#[derive(Serialize)]
pub(crate) struct AgentConnections {
    relay_url: String,
    human_pubkey: String,
    agent_pubkey: String,
    agent_name: String,
    // These are configured grants, not successful access checks or runtime health.
    connections: Vec<Connection>,
}

#[derive(Serialize)]
struct Connection {
    label: String,
    provider: String,
    ownership: &'static str,
}

fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

pub(super) async fn read_connections(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &Configuration,
    human_pubkey: &str,
    agent_pubkey: &str,
) -> Result<AgentConnections, String> {
    let directory =
        agents::read_directory(client, session, gateway, expected, human_pubkey).await?;
    let agent = directory
        .agents
        .iter()
        .find(|a| a.pubkey.as_deref() == Some(agent_pubkey))
        .ok_or(CHANGED)?;
    let mut response = client
        .get(format!("{gateway}/v1/agents/{}/grants", agent.id))
        .bearer_auth(&session.access_token)
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| UNAVAILABLE)?;
    match response.status() {
        StatusCode::OK => (),
        StatusCode::FORBIDDEN => return Err(DENIED.into()),
        StatusCode::UNAUTHORIZED => return Err("Sign in again to view agent connections.".into()),
        StatusCode::NOT_FOUND => return Err(CHANGED.into()),
        StatusCode::CONFLICT => return Err("This agent's connection setup is incomplete.".into()),
        _ => return Err(UNAVAILABLE.into()),
    }
    const LIMIT: usize = 262_144;
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(UNAVAILABLE.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if bytes.len() + chunk.len() > LIMIT {
            return Err(UNAVAILABLE.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let state: GrantState = serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    if state.agent_id != agent.id || state.org_id != session.org_id || state.version < 0 {
        return Err(CHANGED.into());
    }
    let grants = state.connections.unwrap_or_default();
    if grants.len() > 100 || (!grants.is_empty() && state.workload_id.is_empty()) {
        return Err(UNAVAILABLE.into());
    }
    let mut ids = HashSet::new();
    let mut connections = Vec::new();
    for grant in grants {
        if !label(&grant.connection_id, 200)
            || !ids.insert(grant.connection_id)
            || !label(&grant.alias, 512)
            || !label(&grant.provider, 64)
        {
            return Err(UNAVAILABLE.into());
        }
        let ownership = match (
            grant.credential_scope.as_str(),
            grant.credential_owner_type.as_str(),
        ) {
            ("organisation", _) => "company",
            ("identity", "agent") => "agent",
            ("identity", "human") => "delegated",
            _ => "unknown",
        };
        connections.push(Connection {
            label: grant.alias,
            provider: grant.provider,
            ownership,
        });
    }
    // Do not return a previous Agent's grant result after native rebinding or removal.
    let fresh = agents::read_directory(client, session, gateway, expected, human_pubkey).await?;
    if !fresh
        .agents
        .iter()
        .any(|a| a.id == agent.id && a.pubkey.as_deref() == Some(agent_pubkey))
    {
        return Err(CHANGED.into());
    }
    connections.sort_by(|a, b| a.provider.cmp(&b.provider).then(a.label.cmp(&b.label)));
    Ok(AgentConnections {
        relay_url: directory.relay_url,
        human_pubkey: human_pubkey.into(),
        agent_pubkey: agent_pubkey.into(),
        agent_name: agent.name.clone(),
        connections,
    })
}

#[cfg(test)]
#[path = "agent_connections_tests.rs"]
mod tests;
