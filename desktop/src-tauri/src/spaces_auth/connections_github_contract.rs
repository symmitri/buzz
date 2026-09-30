//! The existing company GitHub setup contract, projected without browser state.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub(crate) struct GitHubScope {
    pub account_login: String,
    #[serde(default = "selected_scope")]
    pub repository_scope: String,
    pub repositories: Vec<String>,
    pub read_tools: Vec<String>,
}

fn selected_scope() -> String {
    "selected".into()
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub(crate) struct GitHubSession {
    pub id: String,
    pub phase: String,
    #[serde(flatten)]
    pub scope: GitHubScope,
    pub expires_at: String,
    pub can_resume: bool,
    pub agent_access_granted: bool,
    pub provider_read_verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub(crate) struct GitHubCapability {
    pub configured: bool,
    pub administrator_id: String,
    pub organisation_id: String,
    #[serde(flatten)]
    pub scope: GitHubScope,
    pub in_progress: bool,
    pub can_start: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<GitHubSession>,
}

#[derive(Clone, Serialize)]
pub(crate) struct GitHubView {
    pub revision: String,
    pub capability: GitHubCapability,
}

pub(super) fn view(capability: GitHubCapability) -> Result<GitHubView, Failure> {
    let bytes = serde_json::to_vec(&capability).map_err(|_| Failure::Invalid)?;
    Ok(GitHubView {
        revision: hex::encode(Sha256::digest(bytes)),
        capability,
    })
}

fn slug(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|v| v.is_ascii_lowercase() || v.is_ascii_digit() || *v == b'-')
}

pub(super) fn session_id(value: &str) -> bool {
    value.strip_prefix("ghon_").is_some_and(|v| {
        v.len() == 32
            && v.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn valid_scope(scope: &GitHubScope) -> bool {
    let repositories_valid = match scope.repository_scope.as_str() {
        "all" => scope.repositories.is_empty(),
        "selected" => {
            !scope.repositories.is_empty()
                && scope.repositories.len() <= 100
                && scope.repositories.iter().all(|value| {
                    value
                        .strip_prefix(&format!("{}/", scope.account_login))
                        .is_some_and(|repo| {
                            !repo.is_empty()
                                && repo.len() <= 100
                                && repo != "."
                                && repo != ".."
                                && repo
                                    .bytes()
                                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                        })
                })
        }
        _ => false,
    };
    slug(&scope.account_login)
        && repositories_valid
        && scope.repositories.iter().collect::<HashSet<_>>().len() == scope.repositories.len()
        && !scope.read_tools.is_empty()
        && scope.read_tools.len() <= 50
        && scope.read_tools.iter().all(|tool| {
            !tool.is_empty()
                && tool.len() <= 64
                && tool.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                && tool
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        })
        && scope.read_tools.iter().collect::<HashSet<_>>().len() == scope.read_tools.len()
}

pub(super) fn validate_session(value: &GitHubSession, scope: &GitHubScope) -> Result<(), Failure> {
    if &value.scope != scope
        || !valid_scope(&value.scope)
        || !session_id(&value.id)
        || !matches!(
            value.phase.as_str(),
            "registration"
                | "converting"
                | "vaulting"
                | "installation"
                | "verifying"
                | "completed"
                | "failed"
                | "expired"
        )
        || value.expires_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(&value.expires_at).is_err()
        || value.agent_access_granted
        || value.provider_read_verified
        || value.phase == "completed" && value.connection_id.is_none()
        || value
            .connection_id
            .as_deref()
            .is_some_and(|id| !super::super::identifier(id))
        || value.error_code.as_ref().is_some_and(|code| {
            code.is_empty()
                || code.len() > 100
                || !code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
        })
        || value.can_resume
            && !matches!(
                value.phase.as_str(),
                "registration" | "installation" | "failed" | "expired"
            )
    {
        return Err(Failure::Invalid);
    }
    Ok(())
}

pub(super) fn validate_capability(
    value: &GitHubCapability,
    session: &oauth::Session,
) -> Result<(), Failure> {
    if value.administrator_id != session.identity_id || value.organisation_id != session.org_id {
        return Err(Failure::AccessLost);
    }
    if !value.configured || !valid_scope(&value.scope) || value.can_start && value.in_progress {
        return Err(Failure::Invalid);
    }
    if let Some(current) = &value.session {
        validate_session(current, &value.scope)?;
    }
    Ok(())
}

pub(super) fn authorize_change(
    value: &GitHubView,
    input: &GitHubChangeInput,
    session: &oauth::Session,
) -> Result<(), Failure> {
    if input.expected_administrator_id != session.identity_id
        || input.expected_organisation_id != session.org_id
    {
        return Err(Failure::AccessLost);
    }
    if input.expected_revision != value.revision {
        return Err(Failure::Conflict);
    }
    match input.action.as_str() {
        "start" if value.capability.can_start && input.session_id.is_none() => Ok(()),
        "resume"
            if value
                .capability
                .session
                .as_ref()
                .is_some_and(|v| v.can_resume && input.session_id.as_ref() == Some(&v.id)) =>
        {
            Ok(())
        }
        _ => Err(Failure::Conflict),
    }
}

pub(super) fn authorization_url(
    raw: &str,
    phase: &str,
    gateway: &str,
    token: &str,
) -> Result<String, Failure> {
    if raw.len() > 2048 || token.is_empty() || raw.contains(token) {
        return Err(Failure::Invalid);
    }
    let url = Url::parse(raw).map_err(|_| Failure::Invalid)?;
    let pairs: Vec<_> = url.query_pairs().collect();
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || pairs.len() != 1
        || pairs[0].0 != "state"
        || pairs[0].1.len() != 43
        || !pairs[0]
            .1
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(Failure::Invalid);
    }
    let registration = phase == "registration"
        && url.origin().ascii_serialization() == gateway
        && url.path() == format!("{PATH}/register");
    let installation = phase == "installation"
        && url.host_str() == Some("github.com")
        && url
            .path()
            .strip_prefix("/apps/")
            .and_then(|v| v.strip_suffix("/installations/new"))
            .is_some_and(slug);
    if !registration && !installation {
        return Err(Failure::Invalid);
    }
    Ok(url.into())
}
