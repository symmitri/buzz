use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    routing::any,
    Json, Router,
};
use nostr::Keys;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct Fixture {
    registry: Value,
    native: Value,
    requests: Arc<Mutex<Vec<(String, String)>>>,
    denied: bool,
}

async fn serve(
    State(fixture): State<Fixture>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    fixture
        .requests
        .lock()
        .unwrap()
        .push((method.to_string(), uri.path().to_string()));
    if fixture.denied
        || method != Method::GET
        || headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer synthetic")
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"synthetic denial"})),
        );
    }
    if uri.path() == "/v1/agents" {
        (StatusCode::OK, Json(fixture.registry))
    } else if uri.path() == "/v1/space/buzz/config"
        && headers
            .get("X-Axis-Buzz-Environment")
            .and_then(|v| v.to_str().ok())
            == Some("alpha")
    {
        (StatusCode::OK, Json(fixture.native))
    } else {
        (StatusCode::NOT_FOUND, Json(json!({})))
    }
}

fn fixture() -> (Fixture, oauth::Session, Configuration, String) {
    let human = Keys::generate().public_key().to_hex();
    let key = Keys::generate().public_key().to_hex();
    let native = json!({
        "enabled":true, "environment":"alpha", "org_id":"org_symmitri", "identity_id":"usr_test",
        "tenant_id":"synthetic_alpha", "relay_url":"https://relay.example.test",
        "relay_pubkey":Keys::generate().public_key().to_hex(), "pubkey":human,
        "private_owner_dms":true, "owned_conversations":true,
        "people":[{"pubkey":human}], "company_agent_ids":["agent_company"],
        "agents":[{"agent_id":"agt_private", "identity_id":"idn_private", "owner_id":"usr_test", "pubkey":key}]
    });
    let registry = json!({"agents":[
        {"id":"agt_private", "identity_id":"idn_private", "org_id":"org_symmitri", "name":"Private Agent", "description":"Existing private agent",
         "directory_visibility":"private", "owner_identity_id":"usr_test", "paired_identity_id":"usr_test", "status":"active"},
        {"id":"agent_company", "identity_id":"idn_company", "org_id":"org_symmitri", "name":"Company Agent", "description":"Existing company agent",
         "directory_visibility":"organisation", "owner_identity_id":"usr_other", "status":"active"}
    ]});
    let session = serde_json::from_value(json!({"access_token":"synthetic", "token_type":"Bearer", "expires_at":"2099-01-01T00:00:00Z", "identity_id":"usr_test", "org_id":"org_symmitri"})).unwrap();
    let expected = serde_json::from_value(native.clone()).unwrap();
    (
        Fixture {
            registry,
            native,
            requests: Arc::new(Mutex::new(Vec::new())),
            denied: false,
        },
        session,
        expected,
        human,
    )
}

async fn read(
    fixture: Fixture,
    session: &oauth::Session,
    expected: &Configuration,
    human: &str,
) -> Result<AgentDirectory, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().fallback(any(serve)).with_state(fixture),
        )
        .await
        .unwrap();
    });
    let result = read_directory(
        &oauth::client().unwrap(),
        session,
        &gateway,
        expected,
        human,
    )
    .await;
    server.abort();
    result
}

#[tokio::test]
async fn existing_private_and_company_agents_are_joined_without_a_write() {
    let (mut f, session, expected, human) = fixture();
    let company_key = Keys::generate().public_key().to_hex();
    f.native["agents"].as_array_mut().unwrap().push(json!({"agent_id":"agent_company", "identity_id":"idn_company", "owner_id":"usr_other", "pubkey":company_key}));
    let requests = f.requests.clone();
    let result = read(f, &session, &expected, &human).await.unwrap();
    assert_eq!(result.human_pubkey, human);
    assert_eq!(result.relay_url, "wss://relay.example.test");
    assert_eq!(result.agents.len(), 2);
    assert!(result.agents[0].private);
    assert!(result.agents[0].pubkey.is_some());
    assert_eq!(
        result.agents[1].pubkey.as_deref(),
        Some(company_key.as_str())
    );
    assert_eq!(
        *requests.lock().unwrap(),
        vec![
            ("GET".into(), "/v1/agents".into()),
            ("GET".into(), "/v1/space/buzz/config".into())
        ]
    );
    let public = serde_json::to_string(&result).unwrap();
    assert!(!public.contains("access_token") && !public.contains("owner_identity_id"));
}

#[tokio::test]
async fn unconnected_agent_stays_visible_and_foreign_private_agent_stays_hidden() {
    let (mut f, session, expected, human) = fixture();
    f.registry["agents"][0]["paired_identity_id"] = json!("usr_other");
    let result = read(f, &session, &expected, &human).await.unwrap();
    assert_eq!(result.agents.len(), 1);
    assert_eq!(result.agents[0].id, "agent_company");
    assert!(result.agents[0].pubkey.is_none());
}

#[tokio::test]
async fn disabled_private_capability_cannot_be_replaced_by_company_sponsorship() {
    let (mut f, session, expected, human) = fixture();
    f.native["private_owner_dms"] = json!(false);
    f.native["company_agent_ids"]
        .as_array_mut()
        .unwrap()
        .push(json!("agt_private"));
    let result = read(f, &session, &expected, &human).await.unwrap();
    assert!(result.agents[0].private);
    assert!(result.agents[0].pubkey.is_none());
}

#[tokio::test]
async fn changed_scope_ambiguous_keys_and_mismatched_identities_fail_closed() {
    for case in 0..7 {
        let (mut f, session, expected, human) = fixture();
        match case {
            0 => f.native["tenant_id"] = json!("different_alpha"),
            1 => f.native["enabled"] = json!(false),
            2 => f.native["agents"][0]["identity_id"] = json!("idn_other"),
            3 => f.native["agents"][0]["owner_id"] = json!("usr_other"),
            4 => f.native["agents"][0]["pubkey"] = json!(human),
            5 => {
                let duplicate = f.native["agents"][0].clone();
                f.native["agents"].as_array_mut().unwrap().push(duplicate);
            }
            _ => f.registry["agents"][0]["org_id"] = json!("other_org"),
        }
        assert!(
            read(f, &session, &expected, &human).await.is_err(),
            "case {case}"
        );
    }
}

#[tokio::test]
async fn denied_registry_read_returns_no_agents_and_is_not_retried() {
    let (mut f, session, expected, human) = fixture();
    f.denied = true;
    let requests = f.requests.clone();
    assert!(read(f, &session, &expected, &human).await.is_err());
    assert_eq!(requests.lock().unwrap().len(), 1);
}
