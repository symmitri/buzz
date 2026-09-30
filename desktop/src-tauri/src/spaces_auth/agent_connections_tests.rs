use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    routing::any,
    Router,
};
use nostr::Keys;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct Fixture {
    registry: Value,
    native: Value,
    grants: Value,
    status: StatusCode,
    rebind: bool,
    requests: Arc<Mutex<Vec<String>>>,
}
async fn serve(
    State(f): State<Fixture>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> (StatusCode, String) {
    assert_eq!(method, Method::GET);
    assert_eq!(headers.get("authorization").unwrap(), "Bearer synthetic");
    let mut calls = f.requests.lock().unwrap();
    calls.push(uri.path().into());
    match uri.path() {
        "/v1/agents" => (StatusCode::OK, f.registry.to_string()),
        "/v1/space/buzz/config" => {
            assert_eq!(headers.get("x-axis-buzz-environment").unwrap(), "alpha");
            let mut value = f.native;
            if f.rebind
                && calls
                    .iter()
                    .filter(|p| *p == "/v1/space/buzz/config")
                    .count()
                    > 1
            {
                value["agents"][0]["pubkey"] = json!(Keys::generate().public_key().to_hex());
            }
            (StatusCode::OK, value.to_string())
        }
        "/v1/agents/agent_company/grants" => (f.status, f.grants.to_string()),
        _ => panic!("unexpected request"),
    }
}
fn fixture() -> (Fixture, oauth::Session, Configuration, String, String) {
    let human = Keys::generate().public_key().to_hex();
    let agent = Keys::generate().public_key().to_hex();
    let native = json!({"enabled":true,"environment":"alpha","org_id":"org_symmitri","identity_id":"usr_test","tenant_id":"synthetic_alpha","relay_url":"https://relay.example.test","relay_pubkey":Keys::generate().public_key().to_hex(),"pubkey":human,"people":[{"pubkey":human}],"company_agent_ids":["agent_company"],"agents":[{"agent_id":"agent_company","identity_id":"idn_company","owner_id":"usr_owner","pubkey":agent}]});
    let registry = json!({"agents":[{"id":"agent_company","identity_id":"idn_company","org_id":"org_symmitri","name":"Company Agent","description":"","directory_visibility":"organisation","owner_identity_id":"usr_owner","status":"active"}]});
    let grants = json!({"agent_id":"agent_company","org_id":"org_symmitri","workload_id":"app_company","version":10,"connections":[{"connection_id":"conn_code","alias":"Company code","provider":"github","credential_scope":"organisation","credential_identity_id":"private-credential-id"}],"connection_setup_options":[{"credential_account_email":"private@example.test"}],"audiences":[{"channel_id":"private-audience"}],"connection_options":[{"alias":"not-granted"}]});
    let session=serde_json::from_value(json!({"access_token":"synthetic","token_type":"Bearer","expires_at":"2099-01-01T00:00:00Z","identity_id":"usr_test","org_id":"org_symmitri"})).unwrap();
    let expected = serde_json::from_value(native.clone()).unwrap();
    (
        Fixture {
            registry,
            native,
            grants,
            status: StatusCode::OK,
            rebind: false,
            requests: Arc::default(),
        },
        session,
        expected,
        human,
        agent,
    )
}
async fn read(
    f: Fixture,
    session: &oauth::Session,
    expected: &Configuration,
    human: &str,
    agent: &str,
) -> Result<AgentConnections, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().fallback(any(serve)).with_state(f))
            .await
            .unwrap();
    });
    let result = read_connections(
        &oauth::client().unwrap(),
        session,
        &url,
        expected,
        human,
        agent,
    )
    .await;
    server.abort();
    result
}
#[tokio::test]
async fn projects_only_this_agents_configured_connections() {
    let (f, s, c, h, a) = fixture();
    let calls = f.requests.clone();
    let result = read(f, &s, &c, &h, &a).await.unwrap();
    let json = serde_json::to_string(&result).unwrap();
    for forbidden in [
        "private-credential-id",
        "private@example.test",
        "private-audience",
        "not-granted",
        "synthetic",
        "ready",
    ] {
        assert!(!json.contains(forbidden), "{forbidden}");
    }
    assert_eq!(result.agent_pubkey, a);
    assert_eq!(result.connections[0].ownership, "company");
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        [
            "/v1/agents",
            "/v1/space/buzz/config",
            "/v1/agents/agent_company/grants",
            "/v1/agents",
            "/v1/space/buzz/config"
        ]
    );
}
#[tokio::test]
async fn human_delegation_is_not_presented_as_agent_owned() {
    let (mut f, s, c, h, a) = fixture();
    f.grants["connections"][0]["credential_scope"] = json!("identity");
    f.grants["connections"][0]["credential_owner_type"] = json!("human");
    assert_eq!(
        read(f, &s, &c, &h, &a).await.unwrap().connections[0].ownership,
        "delegated"
    );
}
#[tokio::test]
async fn denial_setup_and_outage_are_distinct_and_do_not_leak_body() {
    for (status, message) in [
        (StatusCode::FORBIDDEN, DENIED),
        (
            StatusCode::CONFLICT,
            "This agent's connection setup is incomplete.",
        ),
        (StatusCode::SERVICE_UNAVAILABLE, UNAVAILABLE),
    ] {
        let (mut f, s, c, h, a) = fixture();
        f.status = status;
        f.grants = json!({"error":"private upstream diagnostic"});
        let calls = f.requests.clone();
        assert_eq!(read(f, &s, &c, &h, &a).await.err().unwrap(), message);
        assert_eq!(calls.lock().unwrap().len(), 3);
    }
}
#[tokio::test]
async fn unknown_native_identity_never_reads_grants() {
    let (f, s, c, h, _) = fixture();
    let calls = f.requests.clone();
    assert_eq!(
        read(f, &s, &c, &h, &Keys::generate().public_key().to_hex())
            .await
            .err()
            .unwrap(),
        CHANGED
    );
    assert_eq!(calls.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn foreign_org_or_wrong_agent_receipt_is_rejected() {
    for field in ["agent_id", "org_id"] {
        let (mut f, s, c, h, a) = fixture();
        f.grants[field] = json!("foreign");
        assert_eq!(read(f, &s, &c, &h, &a).await.err().unwrap(), CHANGED);
    }
}
#[tokio::test]
async fn rebinding_during_read_discards_connections() {
    let (mut f, s, c, h, a) = fixture();
    f.rebind = true;
    assert_eq!(read(f, &s, &c, &h, &a).await.err().unwrap(), CHANGED);
}
#[tokio::test]
async fn private_agent_of_another_human_never_reads_grants() {
    let (mut f, s, c, h, a) = fixture();
    f.registry["agents"][0]["directory_visibility"] = json!("private");
    let calls = f.requests.clone();
    assert_eq!(read(f, &s, &c, &h, &a).await.err().unwrap(), CHANGED);
    assert_eq!(calls.lock().unwrap().len(), 2);
}
#[tokio::test]
async fn duplicate_connections_and_unbound_grants_fail_closed() {
    for mode in [0, 1] {
        let (mut f, s, c, h, a) = fixture();
        if mode == 0 {
            let grant = f.grants["connections"][0].clone();
            f.grants["connections"].as_array_mut().unwrap().push(grant);
        } else {
            f.grants["workload_id"] = json!("");
        }
        assert_eq!(read(f, &s, &c, &h, &a).await.err().unwrap(), UNAVAILABLE);
    }
}
#[tokio::test]
async fn oversized_response_is_not_projected() {
    let (mut f, s, c, h, a) = fixture();
    f.grants["ignored"] = json!("x".repeat(262_144));
    assert_eq!(read(f, &s, &c, &h, &a).await.err().unwrap(), UNAVAILABLE);
}
#[tokio::test]
async fn empty_grant_set_is_an_explicit_empty_result() {
    let (mut f, s, c, h, a) = fixture();
    f.grants["connections"] = Value::Null;
    assert!(read(f, &s, &c, &h, &a)
        .await
        .unwrap()
        .connections
        .is_empty());
}
