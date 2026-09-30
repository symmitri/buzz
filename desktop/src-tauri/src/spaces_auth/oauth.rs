//! Symmitri modification: native Gateway OAuth. No relay enrollment occurs here.
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::IntoResponse,
    routing::get,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{net::TcpListener, sync::oneshot};
use tokio_util::task::AbortOnDropHandle;
use url::Url;
use zeroize::{Zeroize, Zeroizing};

pub(super) const GATEWAY: &str = "https://gateway.symmitri.ai";
const WORKSPACE: &str = "https://spaces-alpha.symmitri.ai";
const ORG: &str = "org_symmitri";
const CLIENT: &str = "symmitri-studio";
const CALLBACK: &str = "/symmitri-studio/callback";
const INVALID: &str = "Gateway returned an invalid sign-in response.";

// Deliberately no Debug or Serialize: credentials cannot become IPC output.
#[derive(Deserialize)]
pub(super) struct Session {
    pub(super) access_token: String,
    pub(super) expires_at: String,
    pub(super) identity_id: String,
    pub(super) org_id: String,
    token_type: String,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.access_token.zeroize();
    }
}

#[derive(Serialize)]
pub(crate) struct Account {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) email: String,
    // Authentication is separate from an admitted, connected Buzz workspace.
    pub(super) server_setup_pending: bool,
}

#[derive(Deserialize)]
struct Me {
    identity: Person,
}
#[derive(Deserialize)]
struct Person {
    id: String,
    org_id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    name: String,
    email: String,
    email_verified: bool,
}

fn opaque(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn random_value(size: usize) -> Result<Zeroizing<String>, String> {
    let mut bytes = Zeroizing::new(vec![0_u8; size]);
    getrandom::getrandom(&mut bytes).map_err(|_| "Could not start secure sign-in.".to_string())?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(&*bytes)))
}

pub(super) fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Could not start company sign-in.".into())
}

pub(super) async fn json<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, String> {
    json_for(request, "Company sign-in").await
}

// Fixed call-site labels identify the failing service without disclosing URLs,
// bearer headers, signed proofs, response bodies or underlying error text.
pub(super) async fn json_for<T: DeserializeOwned>(
    request: reqwest::RequestBuilder,
    operation: &'static str,
) -> Result<T, String> {
    let (client, request) = request.header("Cache-Control", "no-store").build_split();
    let mut request =
        request.map_err(|_| format!("{operation}: could not prepare the request."))?;
    // Recover transient read failures before the account/authority monitor gives
    // up. Never replay OAuth exchanges, enrollment proofs, consent or messages.
    let mut retries_left = if request.method() == reqwest::Method::GET {
        2
    } else {
        0
    };
    let mut response = loop {
        let retry_request = if retries_left > 0 {
            request.try_clone()
        } else {
            None
        };
        let result = client.execute(request).await;
        let transient = match &result {
            Ok(response) => matches!(response.status().as_u16(), 502 | 503 | 504),
            Err(error) => error.is_timeout() || error.is_connect() || error.is_request(),
        };
        if transient {
            if let Some(retry) = retry_request {
                retries_left -= 1;
                tokio::time::sleep(Duration::from_millis(if retries_left == 1 {
                    250
                } else {
                    750
                }))
                .await;
                request = retry;
                continue;
            }
        }
        break result.map_err(|error| {
            let reason = if error.is_timeout() {
                "request timed out"
            } else if error.is_connect() {
                "could not connect to the server"
            } else {
                "connection was interrupted"
            };
            format!("{operation}: {reason}. Try again.")
        })?;
    };
    if !response.status().is_success() {
        return Err(format!(
            "{operation}: server returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    const LIMIT: usize = 64_000;
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        return Err(INVALID.into());
    }
    let mut body = Zeroizing::new(Vec::new());
    while let Some(chunk) = response.chunk().await.map_err(|_| INVALID.to_string())? {
        if body.len().saturating_add(chunk.len()) > LIMIT {
            return Err(INVALID.into());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| INVALID.into())
}

impl Session {
    fn validate(&self) -> Result<(), String> {
        if !self
            .access_token
            .strip_prefix("sym_")
            .is_some_and(|t| opaque(t, 43))
            || self.token_type != "Bearer"
            || self.org_id != ORG
            || self.identity_id.is_empty()
            || self.identity_id.len() > 160
            || !chrono::DateTime::parse_from_rfc3339(&self.expires_at)
                .is_ok_and(|expiry| expiry > chrono::Utc::now())
        {
            return Err("Your company sign-in has expired or is invalid. Sign in again.".into());
        }
        Ok(())
    }

    // Explicit native-only persistence format; never return it from a command.
    pub(super) fn stored(&self) -> Zeroizing<String> {
        Zeroizing::new(serde_json::json!({
            "access_token": self.access_token, "expires_at": self.expires_at,
            "identity_id": self.identity_id, "org_id": self.org_id, "token_type": self.token_type,
        }).to_string())
    }

    pub(super) async fn account(
        &self,
        client: &reqwest::Client,
        gateway: &str,
    ) -> Result<Account, String> {
        self.validate()?;
        let me: Me = json(
            client
                .get(format!("{gateway}/v1/me"))
                .bearer_auth(&self.access_token),
        )
        .await?;
        let person = me.identity;
        let email = person.email.to_ascii_lowercase();
        let parts: Vec<_> = email.split('@').collect();
        if person.kind != "user"
            || person.org_id != ORG
            || person.id != self.identity_id
            || !person.email_verified
            || parts.len() != 2
            || parts[0].is_empty()
            || parts[1] != "symmitri.ai"
            || email.len() > 254
            || person.name.len() > 512
        {
            return Err("Sign in with your invited, verified Symmitri Google account.".into());
        }
        Ok(Account {
            id: person.id,
            name: person.name,
            email: person.email,
            server_setup_pending: true,
        })
    }
}

struct CallbackState {
    origin: String,
    state: Zeroizing<String>,
    sender: Mutex<Option<oneshot::Sender<Zeroizing<String>>>>,
}

fn callback_code(
    uri: &Uri,
    headers: &HeaderMap,
    pending: &CallbackState,
) -> Option<Zeroizing<String>> {
    if uri.to_string().len() > 4096
        || headers.get_all("host").iter().count() != 1
        || headers.get("host")?.to_str().ok()? != pending.origin.strip_prefix("http://")?
    {
        return None;
    }
    let url = Url::parse(&format!("{}{}", pending.origin, uri)).ok()?;
    if url.origin().ascii_serialization() != pending.origin
        || url.path() != CALLBACK
        || url.fragment().is_some()
    {
        return None;
    }
    let params: Vec<_> = url.query_pairs().collect();
    if params.len() != 2
        || params.iter().filter(|(k, _)| k == "state").count() != 1
        || params.iter().filter(|(k, _)| k == "code").count() != 1
    {
        return None;
    }
    let state = &params.iter().find(|(k, _)| k == "state")?.1;
    let code = &params.iter().find(|(k, _)| k == "code")?.1;
    if !opaque(state, 43) || !opaque(code, 43) {
        return None;
    }
    // Fixed-size comparison, with no early return on a mismatching byte.
    let difference = state
        .bytes()
        .zip(pending.state.bytes())
        .fold(0_u8, |d, (a, b)| d | (a ^ b));
    if difference != 0 {
        return None;
    }
    Some(Zeroizing::new(code.to_string()))
}

async fn callback(
    State(pending): State<Arc<CallbackState>>,
    headers: HeaderMap,
    method: Method,
    uri: Uri,
) -> impl IntoResponse {
    let accepted = method == Method::GET
        && callback_code(&uri, &headers, &pending).is_some_and(|code| {
            pending
                .sender
                .lock()
                .ok()
                .and_then(|mut sender| sender.take())
                .is_some_and(|sender| sender.send(code).is_ok())
        });
    (
        if accepted {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        },
        [
            ("Cache-Control", "no-store"),
            ("Referrer-Policy", "no-referrer"),
            (
                "Content-Security-Policy",
                "default-src 'none'; frame-ancestors 'none'",
            ),
            ("X-Content-Type-Options", "nosniff"),
        ],
        if accepted {
            "Return to Spaces Alpha. Your request was received; the app is checking your account."
        } else {
            "This sign-in link is invalid. Return to Spaces Alpha and start again."
        },
    )
}

// Only the fixed constants above reach this seam in production. Tests supply a
// loopback Gateway and browser to exercise the actual callback/exchange path.
pub(super) async fn login(
    gateway: &str,
    open_browser: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(Session, Account), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Could not open the local sign-in callback.".to_string())?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not read the sign-in callback.".to_string())?
        .port();
    let origin = format!("http://127.0.0.1:{port}");
    let redirect = format!("{origin}{CALLBACK}");
    let verifier = random_value(48)?;
    let state = random_value(32)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let (sender, receiver) = oneshot::channel();
    let router = Router::new()
        .route(CALLBACK, get(callback))
        .with_state(Arc::new(CallbackState {
            origin,
            state: Zeroizing::new(state.to_string()),
            sender: Mutex::new(Some(sender)),
        }));
    let server =
        AbortOnDropHandle::new(tokio::spawn(
            async move { axum::serve(listener, router).await },
        ));
    let mut browser =
        Url::parse(&format!("{gateway}/v1/auth/desktop")).map_err(|_| INVALID.to_string())?;
    browser.query_pairs_mut().extend_pairs([
        ("client_id", CLIENT),
        ("redirect_uri", &redirect),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", state.as_str()),
        ("org_id", ORG),
        ("workspace_url", WORKSPACE),
    ]);
    open_browser(browser.as_str())?;
    let code = receiver
        .await
        .map_err(|_| "Sign-in callback was closed. Try again.".to_string())?;
    // Keep the listener alive until the browser has received its response;
    // AbortOnDrop also closes it on cancellation, exchange failure or timeout.
    let client = client()?;
    let session: Session = json(
        client
            .post(format!("{gateway}/v1/auth/desktop/token"))
            .json(&serde_json::json!({
                "client_id": CLIENT, "grant_type": "authorization_code", "code": *code,
                "code_verifier": *verifier, "redirect_uri": redirect, "org_id": ORG,
            })),
    )
    .await?;
    let account = session.account(&client, gateway).await?;
    drop(server);
    Ok((session, account))
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
