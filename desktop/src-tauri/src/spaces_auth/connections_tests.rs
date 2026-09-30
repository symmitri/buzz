use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    routing::any,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct Fixture {
    catalog: Value,
    accounts: Value,
    catalog_status: StatusCode,
    accounts_status: StatusCode,
    catalog_delay: Duration,
    accounts_delay: Duration,
    requests: Arc<Mutex<Vec<(String, String)>>>,
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
    if method != Method::GET
        || headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            != Some(&format!("Bearer sym_{}", "t".repeat(43)))
    {
        return (StatusCode::FORBIDDEN, Json(json!({})));
    }
    match uri.path() {
        "/v1/me/connections" => {
            tokio::time::sleep(fixture.catalog_delay).await;
            (fixture.catalog_status, Json(fixture.catalog))
        }
        "/v1/connection-accounts" => {
            tokio::time::sleep(fixture.accounts_delay).await;
            (fixture.accounts_status, Json(fixture.accounts))
        }
        _ => (StatusCode::NOT_FOUND, Json(json!({}))),
    }
}

fn session() -> oauth::Session {
    serde_json::from_value(json!({
        "access_token": format!("sym_{}", "t".repeat(43)),
        "token_type": "Bearer",
        "expires_at": "2099-01-01T00:00:00Z",
        "identity_id": "usr_test",
        "org_id": "org_symmitri"
    }))
    .unwrap()
}

fn entry(id: &str, scope: &str, provider: &str) -> Value {
    json!({
        "connection_id": id,
        "alias": id,
        "name": format!("{provider} service"),
        "provider": provider,
        "credential_scope": scope,
        "auth_mode": "bearer",
        "visibility": "discoverable",
        "entitlement": "allowed",
        "activation": {"enabled": true, "source": "default", "version": 2},
        "readiness": "ready",
        "setup": {"kind": "none", "connector_id": id}
    })
}

fn account(id: &str, connection: &str, owner_type: &str, owner_id: &str, email: &str) -> Value {
    json!({
        "id": id,
        "connection_id": connection,
        "connector_id": connection,
        "connector_name": format!("{connection} connector"),
        "provider": connection,
        "credential_owner_type": owner_type,
        "credential_owner_id": owner_id,
        "credential_owner_name": match owner_type { "organisation" => "Symmitri", "agent" => "Private Agent", _ => "Test Person" },
        "account_label": "Primary",
        "account_email": email,
        "status": "active",
        "connected_at": "2026-09-16T12:00:00Z",
        "updated_at": "2026-09-16T12:00:00Z"
    })
}

fn fixture() -> Fixture {
    Fixture {
        catalog: json!({
            "schema_version": 1,
            "principal": {"id": "usr_test", "type": "user"},
            "organisation": {"id": "org_symmitri"},
            "entries": [
                entry("personal_notes", "identity", "granola"),
                entry("company_code", "organisation", "github"),
                {
                    "connection_id": "future_provider", "alias": "future", "name": "Future provider",
                    "provider": "provider-added-later", "credential_scope": "identity", "auth_mode": "oauth",
                    "visibility": "discoverable", "entitlement": "requestable",
                    "activation": {"enabled": false, "source": "user", "version": 4},
                    "readiness": "account_required", "setup": {"kind": "oauth", "connector_id": "future"},
                    "request": {"id": "crq_pending", "status": "pending", "version": 1}
                }
            ]
        }),
        accounts: json!({"accounts": [
            account("acc_mine", "personal_notes", "human", "usr_test", "person@symmitri.ai"),
            account("acc_company", "company_code", "organisation", "", "company@example.test"),
            account("acc_foreign", "personal_notes", "human", "usr_other", "private@example.test"),
            account("acc_agent", "personal_notes", "agent", "idn_agent", "agent@example.test")
        ], "can_manage_agent_accounts": true}),
        catalog_status: StatusCode::OK,
        accounts_status: StatusCode::OK,
        catalog_delay: Duration::ZERO,
        accounts_delay: Duration::ZERO,
        requests: Arc::default(),
    }
}

async fn read(
    fixture: Fixture,
) -> (
    Result<ConnectionsSnapshot, ReadFailure>,
    Vec<(String, String)>,
) {
    let requests = fixture.requests.clone();
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
    let result = read_connections(&oauth::client().unwrap(), &session(), &gateway).await;
    server.abort();
    let observed = requests.lock().unwrap().clone();
    (result, observed)
}

#[tokio::test]
async fn reads_the_complete_catalog_and_only_safe_personal_and_company_accounts() {
    let (result, mut requests) = read(fixture()).await;
    let snapshot = result.ok().unwrap();
    assert_eq!(snapshot.entries.len(), 3);
    assert_eq!(snapshot.accounts.len(), 2);
    assert_eq!(snapshot.accounts[0].owner_type, "personal");
    assert_eq!(snapshot.accounts[1].owner_type, "company");
    assert_eq!(snapshot.accounts_state, "ready");
    assert!(snapshot.message.is_none());
    requests.sort();
    assert_eq!(
        requests,
        vec![
            ("GET".into(), "/v1/connection-accounts".into()),
            ("GET".into(), "/v1/me/connections".into())
        ]
    );
    let public = serde_json::to_string(&snapshot).unwrap();
    for private in [
        "sym_ttt",
        "usr_other",
        "idn_agent",
        "private@example.test",
        "agent@example.test",
        "credential_owner_id",
    ] {
        assert!(!public.contains(private), "leaked {private}");
    }
    assert!(public.contains("provider-added-later"));
}

#[tokio::test]
async fn account_failure_is_partial_but_catalog_identity_failure_clears_everything() {
    let mut partial = fixture();
    partial.accounts_status = StatusCode::NOT_FOUND;
    let (result, requests) = read(partial).await;
    let snapshot = result.ok().unwrap();
    assert_eq!(snapshot.entries.len(), 3);
    assert!(snapshot.accounts.is_empty());
    assert_eq!(snapshot.accounts_state, "unavailable");
    assert!(snapshot.message.is_some());
    assert_eq!(requests.len(), 2);

    let mut changed = fixture();
    changed.catalog["principal"]["id"] = json!("usr_replaced");
    let (result, _) = read(changed).await;
    assert!(matches!(result, Err(ReadFailure::Invalid)));
}

#[tokio::test]
async fn access_denial_is_distinct_and_never_retried() {
    let mut denied = fixture();
    denied.catalog_status = StatusCode::UNAUTHORIZED;
    denied.accounts_status = StatusCode::UNAUTHORIZED;
    let (result, requests) = read(denied).await;
    assert!(matches!(result, Err(ReadFailure::AccessLost)));
    assert!((1..=2).contains(&requests.len()));
    assert_eq!(
        requests.iter().collect::<HashSet<_>>().len(),
        requests.len()
    );
}

#[tokio::test]
async fn either_endpoint_authentication_loss_wins_over_the_other_failure() {
    for catalog_denied in [false, true] {
        let mut denied = fixture();
        denied.catalog_status = if catalog_denied {
            StatusCode::UNAUTHORIZED
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        denied.accounts_status = if catalog_denied {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::UNAUTHORIZED
        };
        let (result, _) = read(denied).await;
        assert!(matches!(result, Err(ReadFailure::AccessLost)));
    }
}

#[tokio::test]
async fn authentication_loss_cancels_a_stalled_sibling_read() {
    for catalog_denied in [false, true] {
        let mut denied = fixture();
        if catalog_denied {
            denied.catalog_status = StatusCode::FORBIDDEN;
            denied.accounts_delay = Duration::from_secs(10);
        } else {
            denied.accounts_status = StatusCode::UNAUTHORIZED;
            denied.catalog_delay = Duration::from_secs(10);
        }
        let (result, _) = tokio::time::timeout(Duration::from_secs(1), read(denied))
            .await
            .expect("access loss must not wait for the other endpoint's timeout");
        assert!(matches!(result, Err(ReadFailure::AccessLost)));
    }
}

#[tokio::test]
async fn large_provider_agnostic_catalog_remains_bounded_and_complete() {
    let mut large = fixture();
    large.catalog["entries"] = Value::Array(
        (0..1_000)
            .map(|index| {
                entry(
                    &format!("connection_{index}"),
                    if index % 2 == 0 {
                        "identity"
                    } else {
                        "organisation"
                    },
                    &format!("provider-{index}"),
                )
            })
            .collect(),
    );
    large.accounts = json!({"accounts": []});
    let (result, requests) = read(large).await;
    let snapshot = result.ok().unwrap();
    assert_eq!(snapshot.entries.len(), 1_000);
    assert_eq!(requests.len(), 2);
}

#[tokio::test]
async fn registered_anonymous_providers_remain_available_without_personal_setup() {
    let mut value = fixture();
    for (provider, entitlement) in [
        ("exa", "allowed"),
        ("parallel-search", "requestable"),
        ("context7", "allowed"),
    ] {
        let mut anonymous = entry(provider, "none", provider);
        anonymous["auth_mode"] = json!("anonymous");
        anonymous["entitlement"] = json!(entitlement);
        value.catalog["entries"]
            .as_array_mut()
            .unwrap()
            .push(anonymous);
    }
    let (result, requests) = read(value).await;
    let snapshot = result.unwrap();
    assert_eq!(snapshot.entries.len(), 6);
    assert_eq!(snapshot.accounts.len(), 2);
    assert_eq!(snapshot.accounts_state, "ready");
    assert_eq!(requests.len(), 2);
    for provider in ["exa", "parallel-search", "context7"] {
        let anonymous = snapshot
            .entries
            .iter()
            .find(|entry| entry.provider == provider)
            .unwrap();
        assert_eq!(anonymous.credential_scope, "none");
        assert_eq!(anonymous.setup.kind, "none");
        assert!(!anonymous.setup.browser_supported);
        // Activation/access requests use their normal entitlement and version gates.
        assert!(
            super::super::actions::available_entry(&snapshot, &anonymous.connection_id).is_ok()
        );
        // Even complete inventory and a matching setup kind cannot permit account actions.
        assert!(super::super::actions::personal_setup(
            &snapshot,
            &anonymous.connection_id,
            &["none"],
            false,
        )
        .is_err());
    }
}

#[tokio::test]
async fn anonymous_scope_cannot_advertise_credential_setup() {
    for (auth_mode, setup_kind) in [
        ("bearer", "none"),
        ("anonymous", "key"),
        ("anonymous", "oauth"),
    ] {
        let mut value = fixture();
        value.catalog["entries"][0]["credential_scope"] = json!("none");
        value.catalog["entries"][0]["auth_mode"] = json!(auth_mode);
        value.catalog["entries"][0]["setup"]["kind"] = json!(setup_kind);
        assert!(matches!(read(value).await.0, Err(ReadFailure::Invalid)));
    }
}

#[tokio::test]
async fn duplicate_and_over_limit_catalogs_fail_closed() {
    let mut duplicate = fixture();
    let repeated = duplicate.catalog["entries"][0].clone();
    duplicate.catalog["entries"]
        .as_array_mut()
        .unwrap()
        .push(repeated);
    assert!(matches!(read(duplicate).await.0, Err(ReadFailure::Invalid)));

    let mut over = fixture();
    over.catalog["entries"] = Value::Array(
        (0..=ENTRY_LIMIT)
            .map(|index| entry(&format!("connection_{index}"), "identity", "fixture"))
            .collect(),
    );
    assert!(matches!(read(over).await.0, Err(ReadFailure::Invalid)));
}

#[tokio::test]
async fn malformed_inventory_is_partial_and_hidden_accounts_never_escape() {
    let mut malformed = fixture();
    malformed.accounts["accounts"][0]["connector_name"] = json!("Invalid\nmetadata");
    let value = read(malformed).await.0.unwrap();
    assert_eq!(value.entries.len(), 3);
    assert_eq!(value.accounts_state, "unavailable");
    assert!(value.accounts.is_empty());

    let mut hidden = fixture();
    hidden.catalog["entries"][0]["visibility"] = json!("hidden");
    hidden.catalog["entries"][0]["entitlement"] = json!("denied");
    let value = read(hidden).await.0.unwrap();
    assert!(value
        .accounts
        .iter()
        .all(|account| account.connection_id != "personal_notes"));
}

#[tokio::test]
async fn read_helper_refuses_writes_and_bounds_slow_gateway_attempts() {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/slow", listener.local_addr().unwrap());
    let observed = calls.clone();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().fallback(any(move || {
                let calls = calls.clone();
                async move {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    Json(json!({}))
                }
            })),
        )
        .await
        .unwrap();
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(40))
        .build()
        .unwrap();
    let invalid: Result<Value, _> = request_json(client.post(&address)).await;
    assert!(matches!(invalid, Err(ReadFailure::Invalid)));
    assert_eq!(observed.load(std::sync::atomic::Ordering::SeqCst), 0);
    let unavailable: Result<Value, _> =
        tokio::time::timeout(Duration::from_secs(5), request_json(client.get(address)))
            .await
            .unwrap();
    assert!(matches!(unavailable, Err(ReadFailure::Unavailable)));
    assert_eq!(observed.load(std::sync::atomic::Ordering::SeqCst), 3);
    server.abort();
}
