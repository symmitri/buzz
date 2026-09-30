//! Owner-only readback of an existing immutable result, never a sharing decision.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PrivateResult {
    candidate: Candidate,
    markdown: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    candidate_id: String,
    content_digest: String,
    version: u64,
    execution: Execution,
    task: Task,
    media_type: String,
    byte_length: usize,
    created_at: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Execution {
    id: String,
    consent_id: String,
    consent_version: u64,
    terms_digest: String,
}

fn validate(result: &PrivateResult, record: &Record) -> Result<(), Failure> {
    let c = &result.candidate;
    let hash = |bytes: &[u8]| hex::encode(Sha256::digest(bytes));
    let execution_id = format!(
        "contribution_{}",
        hash(
            serde_json::json!([record.id, record.terms_digest, record.version])
                .to_string()
                .as_bytes()
        )
    );
    if record.state != ConsentState::Approved
        || chrono::DateTime::parse_from_rfc3339(&record.terms.expires_at)
            .map_err(|_| Failure::Invalid)?
            <= chrono::Utc::now()
        || c.task != record.terms.task
        || c.execution.consent_id != record.id
        || c.execution.consent_version != record.version
        || c.execution.terms_digest != record.terms_digest
        || c.execution.id != execution_id
        || c.candidate_id != format!("candidate_{}", hash(execution_id.as_bytes()))
        || c.version != 1
        || c.media_type != "text/markdown"
        || c.byte_length == 0
        || c.byte_length > 65_536
        || result.markdown.len() != c.byte_length
        || hash(result.markdown.as_bytes()) != c.content_digest
        || !timestamp(&c.created_at)
    {
        return Err(Failure::AccessLost);
    }
    Ok(())
}

pub(super) async fn read_result(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    expected: &native_scope::Scope,
    input: &ReadInput,
    current: &impl Fn() -> Result<(), Failure>,
) -> Result<PrivateResult, Failure> {
    let record = read(client, session, gateway, expected, input, current).await?;
    if record.state != ConsentState::Approved {
        return Err(Failure::AccessLost);
    }
    current()?;
    let result: PrivateResult = response(
        client
            .get(format!(
                "{gateway}/v1/space/work-consents/{}/result",
                input.consent_id
            ))
            .bearer_auth(&session.access_token),
    )
    .await?;
    current()?;
    validate(&result, &record)?;
    let now = read(client, session, gateway, expected, input, current).await?;
    current()?;
    validate(&result, &now)?;
    Ok(result)
}
