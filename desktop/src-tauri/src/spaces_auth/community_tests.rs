use super::*;
use axum::{
    extract::State,
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use std::sync::{Arc, Mutex};

struct Fixture {
    config: serde_json::Value,
    bound: bool,
    proofs: usize,
    profiles: Vec<Event>,
    publications: usize,
    drift: bool,
    capability: bool,
}
async fn read_config(
    State(state): State<Arc<Mutex<Fixture>>>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    assert_eq!(headers[ENVIRONMENT_HEADER], "alpha");
    assert_eq!(headers["authorization"], "Bearer synthetic-only");
    let state = state.lock().unwrap();
    let mut value = state.config.clone();
    if state.bound {
        value["pubkey"] = Keys::parse(&"01".repeat(32))
            .unwrap()
            .public_key()
            .to_hex()
            .into();
        if state.drift {
            value["tenant_id"] = "replaced-community".into();
        }
    }
    Json(value)
}
async fn bind(
    State(state): State<Arc<Mutex<Fixture>>>,
    headers: HeaderMap,
    Json(value): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    assert_eq!(headers[ENVIRONMENT_HEADER], "alpha");
    let event: Event = serde_json::from_value(value["event"].clone()).unwrap();
    event.verify().unwrap();
    assert_eq!(event.kind, Kind::HttpAuth);
    assert!(event.content.is_empty());
    let mut state = state.lock().unwrap();
    let endpoint = format!(
        "{}{}",
        state.config["relay_url"].as_str().unwrap(),
        IDENTITY_PATH
    );
    assert_eq!(
        event
            .tags
            .iter()
            .map(|t| t.as_slice().to_vec())
            .collect::<Vec<_>>(),
        vec![
            vec!["u", &endpoint],
            vec!["method", "POST"],
            vec!["org", "org_symmitri"],
            vec!["tenant", "synthetic-alpha"],
            vec!["identity", "synthetic-human"],
        ]
    );
    state.bound = true;
    state.proofs += 1;
    Json(serde_json::json!({"bound":true}))
}
async fn relay_info(State(state): State<Arc<Mutex<Fixture>>>) -> Json<serde_json::Value> {
    let state = state.lock().unwrap();
    Json(
        serde_json::json!({"self": state.config["relay_pubkey"], "supported_extensions": if state.capability {CAPABILITIES} else {&[]}}),
    )
}
fn verify_native(headers: &HeaderMap) {
    use base64::Engine;
    let encoded = headers["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("Nostr ")
        .unwrap();
    let event: Event = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap(),
    )
    .unwrap();
    event.verify().unwrap();
    assert_eq!(
        event.pubkey,
        Keys::parse(&"01".repeat(32)).unwrap().public_key()
    );
}
async fn query(State(state): State<Arc<Mutex<Fixture>>>, headers: HeaderMap) -> Json<Vec<Event>> {
    verify_native(&headers);
    Json(state.lock().unwrap().profiles.clone())
}
async fn publish(
    State(state): State<Arc<Mutex<Fixture>>>,
    headers: HeaderMap,
    Json(event): Json<Event>,
) -> Json<serde_json::Value> {
    verify_native(&headers);
    event.verify().unwrap();
    assert_eq!(event.kind, Kind::Metadata);
    let mut state = state.lock().unwrap();
    state.publications += 1;
    state.profiles = vec![event];
    Json(serde_json::json!({"accepted":true}))
}
async fn fixture() -> (
    String,
    Arc<Mutex<Fixture>>,
    tokio_util::task::AbortOnDropHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(Fixture {
        config: serde_json::json!({"enabled":true,"environment":"alpha","org_id":"org_symmitri","identity_id":"synthetic-human","tenant_id":"synthetic-alpha","relay_url":origin,"relay_pubkey":Keys::parse(&"04".repeat(32)).unwrap().public_key().to_hex()}),
        bound: false,
        proofs: 0,
        profiles: vec![],
        publications: 0,
        drift: false,
        capability: true,
    }));
    let router = Router::new()
        .route(CONFIG_PATH, get(read_config))
        .route(IDENTITY_PATH, post(bind))
        .route("/", get(relay_info))
        .route("/query", post(query))
        .route("/events", post(publish))
        .with_state(state.clone());
    let task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    (origin, state, task)
}
fn session() -> Session {
    serde_json::from_value(serde_json::json!({"access_token":"synthetic-only","expires_at":"2099-01-01T00:00:00Z","identity_id":"synthetic-human","org_id":"org_symmitri","token_type":"Bearer"})).unwrap()
}
fn account() -> Account {
    Account {
        id: "synthetic-human".into(),
        name: "Synthetic Human".into(),
        email: "synthetic@symmitri.ai".into(),
        server_setup_pending: true,
    }
}

#[tokio::test]
async fn actual_bootstrap_proves_same_key_and_preserves_existing_profile() {
    let (origin, state, _task) = fixture().await;
    let client = oauth::client().unwrap();
    for _ in 0..2 {
        let result = prepare(&client, &session(), &account(), &origin, async |_| {
            Ok(Keys::parse(&"01".repeat(32)).unwrap())
        })
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            result.public_info().pubkey,
            Keys::parse(&"01".repeat(32)).unwrap().public_key().to_hex()
        );
    }
    let state = state.lock().unwrap();
    assert_eq!(state.proofs, 2);
    assert_eq!(state.publications, 1);
}

#[tokio::test]
async fn ignored_alpha_header_and_malformed_config_cannot_load_or_bind_key() {
    for (field, value) in [
        ("environment", serde_json::Value::Null),
        ("environment", "".into()),
        ("org_id", "other-org".into()),
        ("identity_id", "other-human".into()),
        ("relay_url", "https://relay.example/path".into()),
        ("relay_url", "https://relay.example?".into()),
        ("relay_pubkey", "invalid".into()),
    ] {
        let (origin, state, _task) = fixture().await;
        state.lock().unwrap().config[field] = value;
        let result = prepare(
            &oauth::client().unwrap(),
            &session(),
            &account(),
            &origin,
            async |_| panic!("invalid connection loaded a key"),
        )
        .await;
        assert!(result.is_err(), "accepted {field}");
        assert_eq!(state.lock().unwrap().proofs, 0);
    }
}

#[tokio::test]
async fn disabled_config_and_post_enrollment_drift_never_admit() {
    let (origin, state, _task) = fixture().await;
    state.lock().unwrap().config = serde_json::json!({"enabled":false});
    assert!(prepare(
        &oauth::client().unwrap(),
        &session(),
        &account(),
        &origin,
        async |_| panic!("disabled connection loaded key")
    )
    .await
    .unwrap()
    .is_none());
    for capability in [true, false] {
        let (origin, state, _task) = fixture().await;
        {
            let mut state = state.lock().unwrap();
            state.drift = capability;
            state.capability = capability;
        }
        assert!(prepare(
            &oauth::client().unwrap(),
            &session(),
            &account(),
            &origin,
            async |_| Ok(Keys::parse(&"01".repeat(32)).unwrap())
        )
        .await
        .is_err());
        assert_eq!(state.lock().unwrap().publications, 0);
    }
}

#[test]
fn bound_identity_requires_exact_recoverable_key_and_scope() {
    let keys = Keys::parse(&"01".repeat(32)).unwrap();
    let bound = keys.public_key().to_hex();
    assert!(restore_key(None, "scope", Some(&bound)).is_err());
    let record = serde_json::json!({"scope":"scope","secret":"01".repeat(32)}).to_string();
    assert_eq!(
        restore_key(Some(&record), "scope", Some(&bound))
            .unwrap()
            .public_key(),
        keys.public_key()
    );
    assert!(restore_key(Some(&record), "other", Some(&bound)).is_err());
    assert!(restore_key(
        Some(&record),
        "scope",
        Some(&Keys::parse(&"02".repeat(32)).unwrap().public_key().to_hex())
    )
    .is_err());
    assert!(restore_key(Some("invalid"), "scope", None).is_err());
}
