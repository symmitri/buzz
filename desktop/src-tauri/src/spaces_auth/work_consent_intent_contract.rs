//! Narrow serde projection of @axis/gateway-client work-consent-intent. Native
//! inputs identify a saved account incarnation; Gateway derives the human.
use super::*;

fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum IntentState {
    SelectAccount,
    Stale,
    Expired,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Intent {
    pub(super) id: String,
    pub(super) version: u64,
    pub(super) digest: String,
    pub(super) created_at: String,
    pub(super) state: IntentState,
    pub(super) terms: IntentTerms,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct IntentTerms {
    pub(super) org_id: String,
    pub(super) application_id: String,
    pub(super) workload_identity_id: String,
    pub(super) task: Task,
    pub(super) task_summary: String,
    pub(super) scope: AccountScope,
    pub(super) audience: Audience,
    pub(super) expires_at: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Account {
    pub(super) account_id: String,
    pub(super) account_version: u64,
    pub(super) connection_id: String,
    pub(super) provider: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) label: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) email: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OwnerResult {
    pub(super) intent: Intent,
    pub(super) accounts: Vec<Account>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) consent: Option<Record>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IntentLookup {
    pub(super) work_id: String,
    pub(super) intents: Vec<Intent>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub(super) next: Option<Cursor>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectionInput {
    pub(super) operation_id: String,
    pub(super) expected_version: u64,
    pub(super) intent_digest: String,
    pub(super) account_id: String,
    pub(super) account_version: u64,
}
impl SelectionInput {
    pub(super) fn same_terms(&self, other: &Self) -> bool {
        self.expected_version == other.expected_version
            && self.intent_digest == other.intent_digest
            && self.account_id == other.account_id
            && self.account_version == other.account_version
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IntentReadInput {
    #[serde(flatten)]
    pub(super) thread: ThreadInput,
    pub(super) intent_id: String,
    pub(super) expected_consent_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectInput {
    #[serde(flatten)]
    pub(super) read: IntentReadInput,
    #[serde(flatten)]
    pub(super) selection: SelectionInput,
}
