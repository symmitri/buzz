//! Read the existing caller-visible registry and join exact Alpha identities.
//! A directory read never enrolls, starts an Agent, or grants conversation access.
use super::{community::Configuration, oauth};
use nostr::PublicKey;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

const INVALID: &str = "Your agent directory changed. Refresh to check it again.";

#[derive(Deserialize)]
struct Registry {
    agents: Vec<RegisteredAgent>,
}

#[derive(Deserialize)]
struct RegisteredAgent {
    id: String,
    identity_id: String,
    org_id: String,
    name: String,
    description: String,
    directory_visibility: String,
    owner_identity_id: String,
    #[serde(default)]
    paired_identity_id: String,
    status: String,
}

#[derive(Deserialize)]
struct NativeAgent {
    agent_id: String,
    identity_id: String,
    owner_id: String,
    pubkey: String,
}

#[derive(Deserialize)]
struct NativePerson {
    pubkey: String,
}

#[derive(Deserialize)]
struct NativeDirectory {
    #[serde(flatten)]
    connection: Configuration,
    enabled: bool,
    agents: Vec<NativeAgent>,
    people: Vec<NativePerson>,
    #[serde(default)]
    company_agent_ids: Vec<String>,
    #[serde(default)]
    private_owner_dms: bool,
    #[serde(default)]
    owned_conversations: bool,
}

#[derive(Serialize)]
pub(crate) struct AgentDirectory {
    pub(super) relay_url: String,
    human_pubkey: String,
    pub(super) agents: Vec<Agent>,
    #[serde(skip)]
    pub(super) member_pubkeys: HashSet<String>,
}

#[derive(Serialize)]
pub(super) struct Agent {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) description: String,
    pub(super) private: bool,
    #[serde(skip)]
    pub(super) company: bool,
    // Presence permits the existing exact-DM action; it is not runtime health.
    pub(super) pubkey: Option<String>,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn public_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && PublicKey::from_hex(value).is_ok()
}

pub(super) async fn read_directory(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &Configuration,
    human_pubkey: &str,
) -> Result<AgentDirectory, String> {
    let registry: Registry = oauth::json_for(
        client
            .get(format!("{gateway}/v1/agents"))
            .bearer_auth(&session.access_token),
        "Agent directory",
    )
    .await?;
    let native: NativeDirectory = oauth::json_for(
        client
            .get(format!("{gateway}/v1/space/buzz/config"))
            .bearer_auth(&session.access_token)
            .header("X-Axis-Buzz-Environment", "alpha"),
        "Alpha agent connections",
    )
    .await?;
    native.connection.validate(session)?;
    if !native.enabled
        || native.connection != *expected
        || !public_key(human_pubkey)
        || registry.agents.len() > 1000
        || native.agents.len() > 1000
        || native.people.len() > 1000
        || native.company_agent_ids.len() > 1000
    {
        return Err(INVALID.into());
    }
    let mut ids = HashSet::new();
    let mut identities = HashSet::new();
    let mut keys = HashSet::from([human_pubkey]);
    for person in &native.people {
        if !public_key(&person.pubkey) {
            return Err(INVALID.into());
        }
        keys.insert(&person.pubkey);
    }
    for agent in &native.agents {
        if !identifier(&agent.agent_id)
            || !identifier(&agent.identity_id)
            || !identifier(&agent.owner_id)
            || !public_key(&agent.pubkey)
            || !ids.insert(&agent.agent_id)
            || !identities.insert(&agent.identity_id)
            || !keys.insert(&agent.pubkey)
        {
            return Err(INVALID.into());
        }
    }
    let member_pubkeys = keys.into_iter().map(str::to_owned).collect();
    let mut ids = HashSet::new();
    let mut identities = HashSet::new();
    let mut agents = Vec::new();
    for agent in registry.agents {
        if !identifier(&agent.id)
            || !identifier(&agent.identity_id)
            || agent.org_id != session.org_id
            || !identifier(&agent.owner_identity_id)
            || agent.name.trim().is_empty()
            || agent.name.len() > 512
            || agent.description.len() > 16_384
            || !ids.insert(agent.id.clone())
            || !identities.insert(agent.identity_id.clone())
            || !matches!(
                agent.directory_visibility.as_str(),
                "private" | "organisation"
            )
        {
            return Err(INVALID.into());
        }
        let private = agent.directory_visibility == "private";
        let owned = agent.owner_identity_id == session.identity_id;
        if agent.status != "active"
            || (private && (!owned || agent.paired_identity_id != session.identity_id))
        {
            continue;
        }
        let native_agent = native
            .agents
            .iter()
            .find(|entry| entry.agent_id == agent.id);
        if native_agent.is_some_and(|entry| {
            entry.identity_id != agent.identity_id || entry.owner_id != agent.owner_identity_id
        }) {
            return Err(INVALID.into());
        }
        let permitted = if private {
            owned
                && native.private_owner_dms
                && native.owned_conversations
                && !native.company_agent_ids.contains(&agent.id)
        } else {
            native.company_agent_ids.contains(&agent.id) || (owned && native.owned_conversations)
        };
        agents.push(Agent {
            company: !private && native.company_agent_ids.contains(&agent.id),
            id: agent.id,
            name: agent.name,
            description: agent.description,
            private,
            pubkey: native_agent
                .filter(|_| permitted)
                .map(|entry| entry.pubkey.clone()),
        });
    }
    agents.sort_by(|a, b| {
        b.private
            .cmp(&a.private)
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(AgentDirectory {
        relay_url: expected.relay_url.replacen("https://", "wss://", 1),
        human_pubkey: human_pubkey.to_string(),
        agents,
        member_pubkeys,
    })
}

#[cfg(test)]
#[path = "agents_tests.rs"]
mod tests;
