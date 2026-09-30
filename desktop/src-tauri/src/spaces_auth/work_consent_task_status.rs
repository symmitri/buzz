//! Current owner's durable task progress. This projection never grants access,
//! starts work, reads provider content or authorizes publication.
use super::*;
use chrono::{DateTime, Utc};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum TaskState {
    Queued,
    Running,
    CandidateReady,
    Failed,
    Pending,
    Declined,
    Revoked,
    Expired,
    Stale,
    Unconfirmed,
}
impl TaskState {
    fn active(self) -> bool {
        matches!(self, Self::Queued | Self::Running)
    }
    fn loss(self) -> bool {
        matches!(
            self,
            Self::Pending | Self::Declined | Self::Revoked | Self::Expired | Self::Stale
        )
    }
}

// An optional wire field may be absent, but explicit null is not canonical.
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskStatus {
    consent_id: String,
    consent_version: u64,
    terms_digest: String,
    state: TaskState,
    revision: u64,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    updated_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    lease_expires_at: Option<String>,
}

/// Native projection of the canonical #303 owner-only task-status lookup.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskStatusLookup {
    org_id: String,
    owner_id: String,
    work_id: String,
    observed_at: String,
    statuses: Vec<TaskStatus>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    next: Option<Cursor>,
}

fn instant(value: &str) -> Result<DateTime<Utc>, Failure> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes.last() != Some(&b'Z')
        || [0..4, 5..7, 8..10, 11..13, 14..16, 17..19]
            .iter()
            .any(|range| !bytes[range.clone()].iter().all(u8::is_ascii_digit))
        || bytes[17] > b'5'
        || (bytes.len() > 20
            && (bytes[19] != b'.'
                || !(22..=30).contains(&bytes.len())
                || !bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit)))
    {
        return Err(Failure::Invalid);
    }
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| Failure::Invalid)
}

impl TaskStatusLookup {
    fn validate(
        &mut self,
        expected: &native_scope::Scope,
        consents: &Lookup,
        now: DateTime<Utc>,
    ) -> Result<(), Failure> {
        if self.org_id != expected.config.org_id
            || self.owner_id != expected.config.identity_id
            || self.work_id != consents.work_id
        {
            return Err(Failure::AccessLost);
        }
        let observed = instant(&self.observed_at)?;
        if !identifier(&self.work_id)
            || self.statuses.len() > REQUEST_LIMIT
            || observed > now + chrono::Duration::seconds(5)
        {
            return Err(Failure::Invalid);
        }
        if let Some(cursor) = &self.next {
            if !identifier(&cursor.id) || instant(&cursor.created_at)?.timestamp_millis() <= 0 {
                return Err(Failure::Invalid);
            }
        }
        if self.next.as_ref().map(|c| (&c.id, &c.created_at))
            != consents.next.as_ref().map(|c| (&c.id, &c.created_at))
        {
            return Err(Failure::Invalid);
        }
        let mut seen = HashSet::new();
        for status in &mut self.statuses {
            if !identifier(&status.consent_id)
                || !seen.insert(status.consent_id.clone())
                || !version(status.consent_version)
                || !digest(&status.terms_digest)
                || (status.revision != 0 && !version(status.revision))
            {
                return Err(Failure::Invalid);
            }
            let updated = status.updated_at.as_deref().map(instant).transpose()?;
            if updated.is_some_and(|at| at > observed)
                || (status.revision == 0) != updated.is_none()
                || (status.state.loss()
                    && (status.revision != 0 || status.lease_expires_at.is_some()))
                || (status.state.active()
                    && (status.revision == 0 || status.lease_expires_at.is_none()))
                || (!status.state.active() && status.lease_expires_at.is_some())
                || (matches!(status.state, TaskState::CandidateReady | TaskState::Failed)
                    && status.revision == 0)
            {
                return Err(Failure::Invalid);
            }
            if let Some(lease) = &status.lease_expires_at {
                let lease = instant(lease)?;
                let updated = updated.ok_or(Failure::Invalid)?;
                if lease <= updated
                    || lease - updated > chrono::Duration::seconds(120)
                    || lease <= observed
                {
                    return Err(Failure::Invalid);
                }
            }
            let consent = consents
                .requests
                .iter()
                .find(|record| record.id == status.consent_id)
                .ok_or(Failure::AccessLost)?;
            if consent.state == ConsentState::Approved {
                if status.consent_version != consent.version
                    || status.terms_digest != consent.terms_digest
                {
                    return Err(Failure::Invalid);
                }
            } else {
                // The fresh consent read wins over an earlier task checkpoint.
                status.state = match consent.state {
                    ConsentState::Pending => TaskState::Pending,
                    ConsentState::Declined => TaskState::Declined,
                    ConsentState::Revoked => TaskState::Revoked,
                    ConsentState::Expired => TaskState::Expired,
                    ConsentState::Stale => TaskState::Stale,
                    ConsentState::Approved => return Err(Failure::Invalid),
                };
                status.consent_version = consent.version;
                status.terms_digest = consent.terms_digest.clone();
                status.revision = 0;
                status.updated_at = None;
                status.lease_expires_at = None;
            }
        }
        self.expire_at(now);
        Ok(())
    }

    fn expire_at(&mut self, now: DateTime<Utc>) {
        for status in &mut self.statuses {
            if status.state.active()
                && !status
                    .lease_expires_at
                    .as_deref()
                    .and_then(|value| instant(value).ok())
                    .is_some_and(|lease| lease > now)
            {
                status.state = TaskState::Unconfirmed;
                status.lease_expires_at = None;
            }
        }
    }

    /// Recheck immediately after native postflight auth, before returning IPC.
    pub(super) fn expire_leases(&mut self) {
        self.expire_at(Utc::now());
    }
}

pub(super) async fn query(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    input: &ThreadInput,
    current: &impl Fn() -> Result<(), Failure>,
) -> Result<TaskStatusLookup, Failure> {
    current()?;
    let mut lookup: TaskStatusLookup = response(
        client
            .post(format!(
                "{gateway}/v1/space/work-consents/task-status/query"
            ))
            .bearer_auth(&session.access_token)
            .json(&lookup_body(expected, input)?),
    )
    .await?;
    current()?;
    // Correlate against this exact owner's freshly resolved origin and history
    // page after status I/O, so revocation or changed terms cannot imply running.
    let consents = super::query(client, session, gateway, expected, input).await?;
    current()?;
    lookup.validate(expected, &consents, Utc::now())?;
    Ok(lookup)
}

/// Read current durable progress only for the current owner's consent page.
#[tauri::command]
pub(crate) async fn spaces_query_work_consent_task_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    auth: tauri::State<'_, SpacesAuth>,
    community: tauri::State<'_, SpacesCommunity>,
    state: tauri::State<'_, AppState>,
    operations: tauri::State<'_, SpacesWorkConsent>,
    input: ThreadInput,
) -> Result<CommandResult, String> {
    commands::command(
        &app,
        &auth,
        &community,
        &state,
        &operations,
        Action::TaskStatus(&input),
    )
    .await
}

#[cfg(test)]
#[path = "work_consent_task_status_tests.rs"]
mod tests;
