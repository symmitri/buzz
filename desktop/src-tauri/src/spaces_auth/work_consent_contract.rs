//! Native IPC projection of Gateway's work-consent wire contract (#301).
//! Shared work metadata belongs to @axis/collaboration; this is no authority.
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum ConsentState {
    Pending,
    Approved,
    Declined,
    Revoked,
    Expired,
    Stale,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Decision {
    Approve,
    Decline,
    Revoke,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Record {
    pub(super) id: String,
    pub(super) terms: Terms,
    pub(super) terms_digest: String,
    pub(super) version: u64,
    pub(super) state: ConsentState,
    pub(super) created_at: String,
    pub(super) execution_enabled: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Terms {
    pub(super) org_id: String,
    pub(super) grantor_id: String,
    pub(super) application_id: String,
    pub(super) workload_identity_id: String,
    pub(super) task: Task,
    pub(super) account_id: String,
    pub(super) account_version: u64,
    pub(super) connection_id: String,
    pub(super) provider: String,
    pub(super) task_summary: String,
    pub(super) scope: AccountScope,
    pub(super) audience: Audience,
    pub(super) output_audience: OutputAudience,
    pub(super) sharing: String,
    pub(super) expires_at: String,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Task {
    pub(super) work_id: String,
    pub(super) request_id: String,
    pub(super) requester_id: String,
    pub(super) agent_id: String,
    pub(super) conversation_id: String,
    pub(super) session_id: String,
    pub(super) binding_version: u64,
    pub(super) audience_version: u64,
    pub(super) audience_digest: String,
    pub(super) authorization_epoch: u64,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AccountScope {
    pub(super) mechanics_version: u32,
    pub(super) allow_recording_time_probes: bool,
    pub(super) max_probe_pages_per_note: u32,
    pub(super) max_provider_calls: u32,
    pub(super) max_transcript_pages_per_note: u32,
    pub(super) max_bytes: u32,
    pub(super) time_zone: String,
    pub(super) meeting_start: String,
    pub(super) meeting_end: String,
    pub(super) selection: String,
    pub(super) note_ids: Vec<String>,
    pub(super) max_notes: u32,
    pub(super) max_list_pages: u32,
    pub(super) page_size: u32,
    pub(super) allowed_tools: Vec<String>,
    pub(super) include_transcript: bool,
}
#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Audience {
    pub(super) digest: String,
    pub(super) revision: String,
    pub(super) version: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OutputAudience {
    pub(super) kind: String,
    pub(super) owner_id: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Lookup {
    pub(super) work_id: String,
    pub(super) requests: Vec<Record>,
    pub(super) participants: Vec<Participant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) next: Option<Cursor>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Participant {
    pub(super) grantor_id: String,
    pub(super) state: ConsentState,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DecisionResult {
    pub(super) receipt: Receipt,
    pub(super) consent: Record,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Receipt {
    pub(super) receipt_id: String,
    pub(super) operation_id: String,
    pub(super) actor_id: String,
    pub(super) consent_id: String,
    pub(super) terms_digest: String,
    pub(super) version: u64,
    pub(super) decision: Decision,
    pub(super) decided_at: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecisionInput {
    pub(super) operation_id: String,
    pub(super) expected_version: u64,
    pub(super) terms_digest: String,
    pub(super) decision: Decision,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Cursor {
    pub(super) created_at: String,
    pub(super) id: String,
}
