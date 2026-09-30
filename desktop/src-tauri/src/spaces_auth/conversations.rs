//! Explicit native DM creation consents through Gateway. Ordinary sends never
//! create or restore grants; the agent edge checks current authority per turn.
use super::{
    community::Configuration, oauth, read_session, SpacesAuth, SpacesCommunity, CANCELLED,
};
use crate::app_state::AppState;
use nostr::{Event, Keys, Kind};
use reqwest::{Client, Method};
use serde::Deserialize;
use tauri::Manager;

const DENIED: &str =
    "This agent could not connect to the conversation. Open the conversation again to retry.";

#[derive(Deserialize)]
struct Agent {
    agent_id: String,
    pubkey: String,
}

#[derive(Deserialize)]
struct Person {
    pubkey: String,
}

#[derive(Deserialize)]
struct Directory {
    #[serde(flatten)]
    connection: Configuration,
    agents: Vec<Agent>,
    people: Vec<Person>,
    #[serde(default)]
    company_agent_ids: Vec<String>,
}

#[derive(Deserialize)]
struct Receipt {
    channel_id: String,
    agents: Vec<ReceiptAgent>,
}

#[derive(Deserialize)]
struct ReceiptAgent {
    agent_id: String,
    version: u64,
    audience_id: String,
    visibility: String,
}

fn exact_receipt(receipt: &Receipt, channel: &str, agents: &[String], company: &[String]) -> bool {
    let mut received: Vec<_> = receipt
        .agents
        .iter()
        .map(|agent| agent.agent_id.clone())
        .collect();
    received.sort();
    receipt.channel_id == channel
        && received == agents
        && receipt.agents.iter().all(|agent| {
            agent.version > 0
                && !agent.audience_id.is_empty()
                && agent.audience_id.len() <= 256
                && if company.contains(&agent.agent_id) {
                    agent.visibility == "shared"
                } else {
                    agent.visibility == "shared" || agent.visibility == "private"
                }
        })
}

/// Only called after an explicit native DM-open action. The renderer supplies
/// neither Agent IDs nor a consent proof: both are independently read here.
pub(crate) async fn consent(
    state: &AppState,
    relay: &str,
    keys: &Keys,
    channel: &str,
    metadata: &Event,
    participants: &[String],
) -> Result<(), String> {
    if crate::build_identity::demo_slug() != Some("spaces-alpha") {
        return Ok(());
    }
    let app = state
        .app_handle
        .lock()
        .map_err(|_| CANCELLED.to_string())?
        .clone()
        .ok_or(CANCELLED)?;
    let auth = app.state::<SpacesAuth>();
    let community = app.state::<SpacesCommunity>();
    let (generation, cancel, expected) = {
        let operation = auth.0.lock().map_err(|_| CANCELLED.to_string())?;
        let ready = community.ready.lock().map_err(|_| CANCELLED.to_string())?;
        let (generation, admitted) = ready.as_ref().ok_or(CANCELLED)?;
        if *generation != operation.generation
            || operation.cancel.is_cancelled()
            || admitted.config.relay_url != relay
            || admitted.keys.public_key() != keys.public_key()
        {
            return Err(CANCELLED.into());
        }
        (
            *generation,
            operation.cancel.clone(),
            admitted.config.clone(),
        )
    };
    let storage = SpacesAuth(auth.0.clone());
    let session = tokio::task::spawn_blocking(move || storage.current(generation, read_session))
        .await
        .map_err(|_| CANCELLED.to_string())??
        .ok_or(CANCELLED)?;
    let client = oauth::client()?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CANCELLED.into()),
        result = approve(&client, &session, oauth::GATEWAY, &expected, keys, channel, metadata, participants) => result?,
    }
    auth.current(generation, || Ok(()))
}

#[allow(clippy::too_many_arguments)]
async fn approve(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &Configuration,
    keys: &Keys,
    channel: &str,
    metadata: &Event,
    participants: &[String],
) -> Result<(), String> {
    let directory: Directory = oauth::json(
        client
            .get(format!("{gateway}/v1/space/buzz/config"))
            .bearer_auth(&session.access_token)
            .header("X-Axis-Buzz-Environment", "alpha"),
    )
    .await?;
    directory.connection.validate(session)?;
    if directory.connection != *expected
        || directory.agents.len() > 1000
        || directory.people.len() > 1000
    {
        return Err(CANCELLED.into());
    }
    let mut agents = Vec::new();
    for participant in participants {
        if participant == &keys.public_key().to_hex() {
            continue;
        }
        let matches: Vec<_> = directory
            .agents
            .iter()
            .filter(|agent| agent.pubkey == *participant)
            .collect();
        if matches.len() == 1 {
            agents.push(matches[0].agent_id.clone());
        } else if !matches.is_empty()
            || !directory
                .people
                .iter()
                .any(|person| person.pubkey == *participant)
        {
            return Err("A participant is no longer available in your company.".into());
        }
    }
    if agents.is_empty() {
        return Ok(());
    }
    agents.sort();
    if agents.len() > 8 || agents.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(DENIED.into());
    }
    let url = format!("{}/query", expected.relay_url);
    let body = serde_json::to_vec(&serde_json::json!([{"kinds":[39002],"authors":[expected.relay_pubkey],"#d":[channel],"limit":1}]))
        .map_err(|_| DENIED.to_string())?;
    let auth = crate::relay::build_nip98_auth_header_for_keys(keys, &Method::POST, &url, &body)?;
    let membership: Vec<Event> = oauth::json(
        client
            .post(url)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .body(body),
    )
    .await?;
    if membership.len() != 1
        || metadata.kind != Kind::Custom(39000)
        || membership[0].kind != Kind::Custom(39002)
        || [metadata, &membership[0]].iter().any(|event| {
            event.verify().is_err()
                || event.pubkey.to_hex() != expected.relay_pubkey
                || event
                    .tags
                    .iter()
                    .filter(|tag| tag.as_slice().first().is_some_and(|name| name == "d"))
                    .map(|tag| tag.as_slice().to_vec())
                    .collect::<Vec<_>>()
                    != vec![vec!["d".to_string(), channel.to_string()]]
        })
    {
        return Err(DENIED.into());
    }
    let mut wanted = participants.to_vec();
    wanted.push(keys.public_key().to_hex());
    wanted.sort();
    wanted.dedup();
    let mut members: Vec<_> = membership[0]
        .tags
        .iter()
        .filter(|tag| tag.as_slice().first().is_some_and(|name| name == "p"))
        .map(|tag| {
            let values = tag.as_slice();
            // The canonical relay emits NIP-29 [p, key, "", role]. Retain
            // legacy two-field membership, but never ignore malformed p tags.
            if !(values.len() == 2
                || (values.len() == 4 && values[2].is_empty() && !values[3].is_empty()))
                || values[1].len() != 64
                || !values[1]
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            {
                return Err(DENIED.to_string());
            }
            Ok(values[1].clone())
        })
        .collect::<Result<Vec<_>, String>>()?;
    members.sort();
    if members != wanted {
        return Err(DENIED.into());
    }
    let receipt: Receipt = oauth::json(client.post(format!("{gateway}/v1/space/buzz/conversations"))
        .bearer_auth(&session.access_token).header("X-Axis-Buzz-Environment", "alpha")
        .json(&serde_json::json!({"agent_ids":agents,"metadata":metadata,"membership":membership[0]})))
        .await.map_err(|_| DENIED.to_string())?;
    if !exact_receipt(&receipt, channel, &agents, &directory.company_agent_ids) {
        return Err(DENIED.into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "conversations_tests.rs"]
mod tests;
