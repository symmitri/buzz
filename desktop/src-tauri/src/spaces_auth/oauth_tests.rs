use super::*;
use axum::{extract::State, http::HeaderValue, routing::post, Json};
use serde_json::{json, Value};

fn session() -> Value {
    json!({"access_token": format!("sym_{}", "t".repeat(43)), "token_type": "Bearer",
        "expires_at": (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        "identity_id": "person-1", "org_id": ORG})
}

fn person() -> Value {
    json!({"id": "person-1", "org_id": ORG, "type": "user", "name": "Test Person",
        "email": "test@symmitri.ai", "email_verified": true})
}

#[derive(Clone)]
struct Fixture {
    grant: Value,
    person: Value,
    challenge: Arc<Mutex<Option<(String, String)>>>,
}

async fn exchange(State(fixture): State<Fixture>, Json(body): Json<Value>) -> Json<Value> {
    let (challenge, redirect) = fixture.challenge.lock().unwrap().clone().unwrap();
    assert_eq!(body["client_id"], CLIENT);
    assert_eq!(body["org_id"], ORG);
    assert_eq!(body["code"], "c".repeat(43));
    assert_eq!(body["grant_type"], "authorization_code");
    assert_eq!(body["redirect_uri"], redirect);
    let verifier = body["code_verifier"].as_str().unwrap();
    assert!(opaque(verifier, 64));
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
        challenge
    );
    Json(fixture.grant)
}

async fn me(State(fixture): State<Fixture>, headers: HeaderMap) -> Json<Value> {
    assert_eq!(
        headers["authorization"],
        format!("Bearer sym_{}", "t".repeat(43))
    );
    Json(json!({"identity": fixture.person}))
}

async fn serve(router: Router) -> (String, AbortOnDropHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    (origin, server)
}

async fn exercise(grant: Value, identity: Value) -> Result<(Session, Account), String> {
    let fixture = Fixture {
        grant,
        person: identity,
        challenge: Arc::default(),
    };
    let router = Router::new()
        .route("/v1/auth/desktop/token", post(exchange))
        .route("/v1/me", get(me))
        .with_state(fixture.clone());
    let (gateway, _server) = serve(router).await;
    tokio::time::timeout(
        Duration::from_secs(5),
        login(&gateway, move |url| {
            let url = Url::parse(url).unwrap();
            let values: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            assert_eq!(values["workspace_url"], WORKSPACE);
            assert_eq!(values["code_challenge_method"], "S256");
            assert!(opaque(&values["state"], 43));
            *fixture.challenge.lock().unwrap() = Some((
                values["code_challenge"].clone(),
                values["redirect_uri"].clone(),
            ));
            let mut callback = Url::parse(&values["redirect_uri"]).unwrap();
            assert_eq!(callback.host_str(), Some("127.0.0.1"));
            callback
                .query_pairs_mut()
                .append_pair("state", &values["state"])
                .append_pair("code", &"c".repeat(43));
            tokio::spawn(async move {
                let response = reqwest::get(callback).await.unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                assert_eq!(response.headers()["cache-control"], "no-store");
                assert!(!response.text().await.unwrap().contains("sym_"));
            });
            Ok(())
        }),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn real_loopback_pkce_exchange_returns_only_verified_public_identity() {
    let (session, account) = exercise(session(), person()).await.unwrap();
    let public = serde_json::to_value(account).unwrap();
    assert_eq!(public["email"], "test@symmitri.ai");
    assert_eq!(public["server_setup_pending"], true);
    assert_eq!(public.as_object().unwrap().len(), 4);
    assert!(!public.to_string().contains(&session.access_token));
    let restored: Session = serde_json::from_str(&session.stored()).unwrap();
    assert_eq!(restored.identity_id, session.identity_id);
}

#[tokio::test]
async fn identity_mismatch_expiry_unverified_and_foreign_accounts_are_rejected() {
    for (field, value) in [
        ("id", json!("another-person")),
        ("org_id", json!("another-org")),
        ("type", json!("agent")),
        ("email_verified", json!(false)),
        ("email", json!("test@symmitri.ai.attacker.test")),
    ] {
        let mut identity = person();
        identity[field] = value;
        assert!(exercise(session(), identity).await.is_err());
    }
    for (field, value) in [
        ("org_id", json!("another-org")),
        ("token_type", json!("Other")),
        ("access_token", json!("do-not-echo-this")),
        ("expires_at", json!("2000-01-01T00:00:00Z")),
    ] {
        let mut grant = session();
        grant[field] = value;
        let error = exercise(grant, person()).await.err().unwrap();
        assert!(!error.contains("do-not-echo-this"));
    }
}

#[test]
fn callback_rejects_state_host_path_duplicate_and_extra_parameters() {
    let state = "s".repeat(43);
    let code = "c".repeat(43);
    let pending = CallbackState {
        origin: "http://127.0.0.1:43210".into(),
        state: Zeroizing::new(state.clone()),
        sender: Mutex::new(None),
    };
    let mut headers = HeaderMap::new();
    headers.insert("host", HeaderValue::from_static("127.0.0.1:43210"));
    let valid = format!("{CALLBACK}?state={state}&code={code}");
    assert!(callback_code(&valid.parse().unwrap(), &headers, &pending).is_some());
    for invalid in [
        valid.replace(&state, &"x".repeat(43)),
        valid.replace(CALLBACK, "/wrong"),
        format!("{valid}&code={code}"),
        format!("{valid}&state={state}"),
        format!("{valid}&extra=1"),
        format!("{CALLBACK}?state={state}"),
        valid.replace(&code, "short"),
    ] {
        assert!(callback_code(&invalid.parse().unwrap(), &headers, &pending).is_none());
    }
    headers.insert("host", HeaderValue::from_static("attacker.test:43210"));
    assert!(callback_code(&valid.parse().unwrap(), &headers, &pending).is_none());
}

#[tokio::test]
async fn transport_rejects_redirects_and_oversized_streams() {
    let router = Router::new()
        .route(
            "/redirect",
            get(|| async { (StatusCode::FOUND, [("location", "https://example.invalid")]) }),
        )
        .route(
            "/large",
            get(|| async {
                axum::body::Body::from_stream(futures_util::stream::iter([
                    Ok::<_, std::io::Error>(vec![b' '; 40_000]),
                    Ok(vec![b' '; 40_000]),
                ]))
            }),
        );
    let (gateway, _server) = serve(router).await;
    for path in ["/redirect", "/large"] {
        assert!(
            json::<Value>(client().unwrap().get(format!("{gateway}{path}")))
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn cancelling_login_closes_its_callback_listener() {
    let (sender, receiver) = oneshot::channel();
    let attempt = tokio::spawn(async move {
        login("http://127.0.0.1:1", |url| {
            let url = Url::parse(url).unwrap();
            let callback = url
                .query_pairs()
                .find(|(k, _)| k == "redirect_uri")
                .unwrap()
                .1
                .into_owned();
            sender.send(callback).unwrap();
            Ok(())
        })
        .await
    });
    let callback = Url::parse(&receiver.await.unwrap()).unwrap();
    let port = callback.port().unwrap();
    attempt.abort();
    let _ = attempt.await;
    // Wait for the aborted axum task to be polled and drop its owned listener.
    for _ in 0..100 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
        {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("cancelled sign-in retained its callback listener");
}

#[tokio::test]
async fn callback_requires_get_and_accepts_a_code_only_once() {
    let (sender, receiver) = oneshot::channel();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let state = "s".repeat(43);
    let router = Router::new()
        .route(CALLBACK, get(callback))
        .with_state(Arc::new(CallbackState {
            origin: origin.clone(),
            state: Zeroizing::new(state.clone()),
            sender: Mutex::new(Some(sender)),
        }));
    let _server = AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let url = format!("{origin}{CALLBACK}?state={state}&code={}", "c".repeat(43));
    let client = client().unwrap();
    assert_eq!(
        client.head(&url).send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(receiver.await.unwrap().as_str(), "c".repeat(43));
    assert_eq!(
        client.get(&url).send().await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn community_transport_reports_stage_without_returning_private_response() {
    let router = Router::new().route(
        "/unavailable",
        get(|| async { (StatusCode::SERVICE_UNAVAILABLE, "private-server-detail") }),
    );
    let (server, _task) = serve(router).await;
    let error = json_for::<Value>(
        client()
            .unwrap()
            .get(format!("{server}/unavailable?private-query=secret")),
        "Alpha messaging enrollment",
    )
    .await
    .unwrap_err();
    assert_eq!(
        error,
        "Alpha messaging enrollment: server returned HTTP 503."
    );
}

#[tokio::test]
async fn community_transport_bounds_read_recovery_and_identifies_timeout() {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = calls.clone();
    let router = Router::new().route(
        "/slow",
        get(move || {
            let calls = observed.clone();
            async move {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::time::sleep(Duration::from_secs(2)).await;
                Json(json!({}))
            }
        }),
    );
    let (server, _task) = serve(router).await;
    let error = json_for::<Value>(
        client()
            .unwrap()
            .get(format!("{server}/slow"))
            .timeout(Duration::from_millis(100)),
        "Alpha profile lookup",
    )
    .await
    .unwrap_err();
    assert_eq!(error, "Alpha profile lookup: request timed out. Try again.");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
}

#[tokio::test]
async fn transient_reads_recover_but_denials_and_writes_are_never_replayed() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    for (method, status, expected_calls) in [
        (Method::GET, StatusCode::SERVICE_UNAVAILABLE, 3),
        (Method::GET, StatusCode::UNAUTHORIZED, 1),
        (Method::POST, StatusCode::SERVICE_UNAVAILABLE, 1),
    ] {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let router = Router::new().route(
            "/request",
            axum::routing::any(move || {
                let calls = observed.clone();
                async move {
                    let count = calls.fetch_add(1, Ordering::SeqCst);
                    if count < 2 {
                        (status, Json(json!({"private": "never returned"})))
                    } else {
                        (StatusCode::OK, Json(json!({"recovered": true})))
                    }
                }
            }),
        );
        let (server, _task) = serve(router).await;
        let result = json_for::<Value>(
            client()
                .unwrap()
                .request(method.clone(), format!("{server}/request")),
            "Alpha configuration",
        )
        .await;
        assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
        if expected_calls == 3 {
            assert_eq!(result.unwrap(), json!({"recovered": true}));
        } else {
            assert!(result.is_err());
        }
    }
}
