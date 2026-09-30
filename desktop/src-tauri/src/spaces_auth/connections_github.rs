//! Company GitHub setup uses only the Gateway's exact current administrator capability.
use super::*;
use serde::de::DeserializeOwned;
use std::sync::Mutex;

#[path = "connections_github_contract.rs"]
mod contract;
use contract::*;

const PATH: &str = "/v1/github-app/onboarding";
const LIMIT: usize = 64 * 1024;
const UNCERTAIN: &str = "Setup may have started. Check its status, then resume the saved setup.";

#[derive(Default)]
pub(crate) struct SpacesGitHubRequests(Mutex<Option<(String, CancellationToken)>>);

struct RequestGuard<'a> {
    owner: &'a SpacesGitHubRequests,
    id: String,
    cancel: CancellationToken,
}

impl SpacesGitHubRequests {
    fn begin(&self, id: &str) -> Result<RequestGuard<'_>, String> {
        if id.is_empty()
            || id.len() > 100
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Refresh GitHub setup before continuing.".into());
        }
        let mut current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        if current.is_some() {
            return Err("Wait for GitHub setup to finish checking.".into());
        }
        let cancel = CancellationToken::new();
        *current = Some((id.into(), cancel.clone()));
        Ok(RequestGuard {
            owner: self,
            id: id.into(),
            cancel,
        })
    }

    fn cancel(&self, id: &str) -> Result<(), String> {
        let mut current = self.0.lock().map_err(|_| CANCELLED.to_string())?;
        if current.as_ref().is_some_and(|(pending, _)| pending == id) {
            if let Some((_, cancel)) = current.take() {
                cancel.cancel();
            }
        }
        Ok(())
    }
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        let _ = self.owner.cancel(&self.id);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Failure {
    AccessLost,
    Denied,
    Unsupported,
    Unavailable,
    Invalid,
    Conflict,
}

#[derive(Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum GitHubResult {
    Ready {
        view: GitHubView,
    },
    Opened {
        view: GitHubView,
    },
    Uncertain {
        view: Option<GitHubView>,
        message: String,
    },
    Conflict {
        message: String,
    },
    AccessLost {
        message: String,
    },
    Denied {
        message: String,
    },
    Unsupported {
        message: String,
    },
    Unavailable {
        message: String,
    },
    Invalid {
        message: String,
    },
}

impl Failure {
    fn public(self) -> GitHubResult {
        match self {
            Self::AccessLost => GitHubResult::AccessLost {
                message: ACCESS_LOST.into(),
            },
            Self::Denied => GitHubResult::Denied {
                message:
                    "Company GitHub setup is available to an authorized company administrator."
                        .into(),
            },
            Self::Unsupported => GitHubResult::Unsupported {
                message: "Company GitHub setup is not available on this service yet.".into(),
            },
            Self::Unavailable => GitHubResult::Unavailable {
                message: "Company GitHub setup could not be checked. Try again.".into(),
            },
            Self::Invalid => GitHubResult::Invalid {
                message: "GitHub setup details could not be verified. Refresh before continuing."
                    .into(),
            },
            Self::Conflict => GitHubResult::Conflict {
                message: "GitHub setup changed. Check its status before continuing.".into(),
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitHubChangeInput {
    request_id: String,
    action: String,
    expected_revision: String,
    expected_administrator_id: String,
    expected_organisation_id: String,
    session_id: Option<String>,
}

async fn json<T: DeserializeOwned>(request: reqwest::RequestBuilder) -> Result<T, Failure> {
    // No retry, including for POST. Browser state never appears in public errors.
    let mut response = request
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|_| Failure::Unavailable)?;
    match response.status() {
        StatusCode::UNAUTHORIZED => return Err(Failure::AccessLost),
        StatusCode::FORBIDDEN => return Err(Failure::Denied),
        StatusCode::NOT_FOUND => return Err(Failure::Unsupported),
        StatusCode::CONFLICT => return Err(Failure::Conflict),
        status if !status.is_success() => return Err(Failure::Unavailable),
        _ => {}
    }
    if response
        .content_length()
        .is_some_and(|size| size > LIMIT as u64)
    {
        return Err(Failure::Invalid);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Failure::Unavailable)? {
        if bytes.len().saturating_add(chunk.len()) > LIMIT {
            return Err(Failure::Invalid);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure::Invalid)
}

async fn read_capability(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
) -> Result<GitHubView, Failure> {
    let value: GitHubCapability = json(
        client
            .get(format!("{gateway}{PATH}"))
            .bearer_auth(&session.access_token),
    )
    .await?;
    validate_capability(&value, session)?;
    view(value)
}

#[derive(Deserialize)]
struct Started {
    #[serde(flatten)]
    session: GitHubSession,
    open_url: String,
}

async fn change_setup(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    input: &GitHubChangeInput,
) -> Result<(GitHubView, String), (Failure, bool)> {
    let before = read_capability(client, session, gateway)
        .await
        .map_err(|error| (error, false))?;
    authorize_change(&before, input, session).map_err(|error| (error, false))?;
    let path = input
        .session_id
        .as_ref()
        .map_or_else(|| PATH.into(), |id| format!("{PATH}/{id}/resume"));
    let started: Started = json(
        client
            .post(format!("{gateway}{path}"))
            .bearer_auth(&session.access_token)
            .json(&serde_json::json!({})),
    )
    .await
    .map_err(|error| (error, true))?;
    validate_session(&started.session, &before.capability.scope).map_err(|error| (error, true))?;
    if input
        .session_id
        .as_ref()
        .is_some_and(|id| id != &started.session.id)
    {
        return Err((Failure::Invalid, true));
    }
    let destination = authorization_url(
        &started.open_url,
        &started.session.phase,
        gateway,
        &session.access_token,
    )
    .map_err(|error| (error, true))?;
    let mut capability = before.capability;
    capability.can_start = false;
    capability.in_progress = started.session.phase != "completed";
    capability.session = Some(started.session);
    Ok((
        view(capability).map_err(|error| (error, true))?,
        destination,
    ))
}

async fn change_with_recovery(
    client: &Client,
    session: &oauth::Session,
    gateway: &str,
    input: &GitHubChangeInput,
) -> Result<(GitHubView, String), GitHubResult> {
    let changed = tokio::time::timeout(
        Duration::from_secs(30),
        change_setup(client, session, gateway, input),
    )
    .await
    .unwrap_or(Err((Failure::Unavailable, true)));
    match changed {
        Ok(value) => Ok(value),
        Err((error, false))
        | Err((error @ Failure::AccessLost, true))
        | Err((error @ Failure::Denied, true)) => Err(error.public()),
        Err((_, true)) => {
            // A submitted or timed-out operation is recovered by GET only.
            let recovered = tokio::time::timeout(
                Duration::from_secs(15),
                read_capability(client, session, gateway),
            )
            .await
            .unwrap_or(Err(Failure::Unavailable));
            Err(match recovered {
                Err(Failure::AccessLost) => Failure::AccessLost.public(),
                Err(Failure::Denied) => Failure::Denied.public(),
                value => GitHubResult::Uncertain {
                    view: value.ok(),
                    message: UNCERTAIN.into(),
                },
            })
        }
    }
}

fn complete(
    context: &mut ActionContext<'_>,
    auth: &SpacesAuth,
    app: &tauri::AppHandle,
    result: &GitHubResult,
) -> Result<(), String> {
    let snapshot = if matches!(result, GitHubResult::AccessLost { .. }) {
        None
    } else {
        Some(context.snapshot().clone())
    };
    auth.current(context.auth_generation, || context.complete(snapshot))?;
    if matches!(result, GitHubResult::AccessLost { .. }) {
        context.connections.invalidate()?;
        invalidate_connection_view(app)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn spaces_read_github_connection(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
    requests: tauri::State<'_, SpacesGitHubRequests>,
    request_id: String,
) -> Result<GitHubResult, String> {
    enabled()?;
    let guard = requests.begin(&request_id)?;
    let mut context = action_context(&app, &auth, &connections).await?;
    let client = oauth::client()?;
    let result = tokio::select! {
        biased;
        _ = guard.cancel.cancelled() => return Err(CANCELLED.into()),
        _ = context.auth_cancel.cancelled() => return Err(CANCELLED.into()),
        _ = context.operation_cancel.cancelled() => return Err(CANCELLED.into()),
        value = tokio::time::timeout(Duration::from_secs(15), read_capability(&client, &context.session, oauth::GATEWAY)) => {
            match value.unwrap_or(Err(Failure::Unavailable)) {
                Ok(view) => GitHubResult::Ready { view },
                Err(error) => error.public(),
            }
        }
    };
    complete(&mut context, &auth, &app, &result)?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn spaces_cancel_github_connection(
    requests: tauri::State<'_, SpacesGitHubRequests>,
    request_id: String,
) -> Result<(), String> {
    enabled()?;
    requests.cancel(&request_id)
}

#[tauri::command]
pub(crate) async fn spaces_change_github_connection(
    app: tauri::AppHandle,
    auth: tauri::State<'_, SpacesAuth>,
    connections: tauri::State<'_, SpacesConnections>,
    requests: tauri::State<'_, SpacesGitHubRequests>,
    input: GitHubChangeInput,
) -> Result<GitHubResult, String> {
    enabled()?;
    let guard = requests.begin(&input.request_id)?;
    let mut context = action_context(&app, &auth, &connections).await?;
    let client = oauth::client()?;
    let changed = tokio::select! {
        biased;
        _ = guard.cancel.cancelled() => return Err(CANCELLED.into()),
        _ = context.auth_cancel.cancelled() => return Err(CANCELLED.into()),
        _ = context.operation_cancel.cancelled() => return Err(CANCELLED.into()),
        value = change_with_recovery(&client, &context.session, oauth::GATEWAY, &input) => value
    };
    let result = match changed {
        Ok((view, destination)) => {
            auth.current(context.auth_generation, || {
                connections.current(context.operation_generation)
            })?;
            if guard.cancel.is_cancelled() {
                return Err(CANCELLED.into());
            }
            if app.opener().open_url(destination, None::<&str>).is_ok() {
                GitHubResult::Opened { view }
            } else {
                GitHubResult::Uncertain { view: Some(view), message: "Your setup is saved, but the browser did not open. Check status, then resume.".into() }
            }
        }
        Err(result) => result,
    };
    complete(&mut context, &auth, &app, &result)?;
    Ok(result)
}

#[cfg(test)]
#[path = "connections_github_tests.rs"]
mod tests;
