//! Presentation hints for exact consent IDs. Inventory never crosses IPC.
use super::*;
use std::collections::BTreeMap;

#[derive(Default, Deserialize)]
pub(super) struct Directory {
    #[serde(default)]
    people: Vec<PersonLabel>,
    #[serde(default)]
    agents: Vec<AgentLabel>,
}
#[derive(Deserialize)]
struct PersonLabel {
    #[serde(default)]
    identity_id: String,
    #[serde(default)]
    name: String,
}
#[derive(Deserialize)]
struct AgentLabel {
    #[serde(default)]
    agent_id: String,
    #[serde(default)]
    name: String,
}
#[derive(Default, Deserialize)]
struct Inventory {
    accounts: Vec<Account>,
}
#[derive(Deserialize)]
struct Account {
    id: String,
    connection_id: String,
    provider: String,
    credential_owner_type: String,
    #[serde(default)]
    credential_owner_id: String,
    #[serde(default)]
    credential_owner_name: String,
    #[serde(default)]
    account_label: String,
    #[serde(default)]
    account_email: String,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Display {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) account_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) account_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) agent_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) initiator_label: Option<String>,
}
pub(super) fn label(value: &str, limit: usize) -> Option<String> {
    (!value.is_empty() && value.len() <= limit && !value.chars().any(char::is_control))
        .then(|| value.into())
}

pub(super) fn task_display(directory: &Directory, task: &Task) -> Display {
    let agents: Vec<_> = directory
        .agents
        .iter()
        .filter(|a| a.agent_id == task.agent_id)
        .take(2)
        .collect();
    let people: Vec<_> = directory
        .people
        .iter()
        .filter(|p| p.identity_id == task.requester_id)
        .take(2)
        .collect();
    Display {
        agent_label: (agents.len() == 1)
            .then(|| label(&agents[0].name, 512))
            .flatten(),
        initiator_label: (people.len() == 1)
            .then(|| label(&people[0].name, 512))
            .flatten(),
        ..Default::default()
    }
}

pub(super) async fn displays(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    directory: &Directory,
    records: &[&Record],
) -> Result<BTreeMap<String, Display>, Failure> {
    if records.is_empty() {
        return Ok(BTreeMap::new());
    }
    // The endpoint is already caller filtered. Only exact owner/account rows are
    // retained, including when the caller can administer other people's accounts.
    let inventory: Inventory = match response(
        client
            .get(format!("{gateway}/v1/connection-accounts"))
            .bearer_auth(&session.access_token),
    )
    .await
    {
        Ok(value) => value,
        Err(Failure::AccessLost) => return Err(Failure::AccessLost),
        Err(_) => Inventory::default(), // Hints are optional, frozen IDs stay visible.
    };
    let mut result = BTreeMap::new();
    for record in records {
        let terms = &record.terms;
        let accounts: Vec<_> = inventory
            .accounts
            .iter()
            .filter(|a| {
                a.id == terms.account_id
                    && a.connection_id == terms.connection_id
                    && a.provider == terms.provider
                    && a.credential_owner_type == "human"
                    && a.credential_owner_id == session.identity_id
            })
            .take(2)
            .collect();
        let account = (accounts.len() == 1).then(|| accounts[0]);
        result.insert(
            record.id.clone(),
            Display {
                account_label: account.and_then(|a| label(&a.account_label, 500)
                    .or_else(|| label(&a.credential_owner_name, 256).map(|name| format!("{name}’s Granola account")))),
                account_email: account.and_then(|a| label(&a.account_email, 254)),
                ..task_display(directory, &terms.task)
            },
        );
    }
    Ok(result)
}
