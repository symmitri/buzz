use super::super::test_support::snapshot;
use super::*;
use axum::{
    extract::State,
    http::{Method, StatusCode, Uri},
    routing::any,
    Router,
};
use std::future::IntoFuture;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[test]
fn provider_browser_route_is_exact_and_never_exports_a_native_credential() {
    let gateway = "https://gateway.symmitri.ai";
    for (provider, host, path, callback) in [
        (
            "google-workspace",
            "accounts.google.com",
            "/o/oauth2/v2/auth",
            "/v1/auth/google/callback",
        ),
        (
            "slack",
            "slack.com",
            "/oauth/v2_user/authorize",
            "/v1/connections/slack/callback",
        ),
        (
            "granola-mcp",
            "mcp-auth.granola.ai",
            "/oauth2/authorize",
            "/v1/connections/granola-mcp/callback",
        ),
        (
            "ramp",
            "mcp.ramp.com",
            "/oauth/authorize",
            "/v1/connections/ramp/callback",
        ),
    ] {
        let mut url = Url::parse(&format!("https://{host}{path}")).unwrap();
        url.query_pairs_mut()
            .append_pair("state", "opaque_challenge")
            .append_pair("redirect_uri", &format!("{gateway}{callback}"));
        assert!(
            provider_authorization(url.as_str(), provider, gateway, "sym_fixture_token").is_ok()
        );
        for (key, value) in [
            ("token", "secret"),
            ("other", "sym_fixture_token"),
            ("state", "duplicate"),
            ("redirect_uri", "https://evil.test/callback"),
        ] {
            let mut invalid = url.clone();
            invalid.query_pairs_mut().append_pair(key, value);
            assert!(provider_authorization(
                invalid.as_str(),
                provider,
                gateway,
                "sym_fixture_token"
            )
            .is_err());
        }
        for invalid in [
            url.as_str().replace("https:", "http:"),
            url.as_str().replace(host, "evil.test"),
            format!("{url}#fragment"),
        ] {
            assert!(
                provider_authorization(&invalid, provider, gateway, "sym_fixture_token").is_err()
            );
        }
    }
    assert!(provider_route("provider-added-later").is_none());
}

#[test]
fn partial_accounts_company_scope_and_denial_cannot_become_personal_setup() {
    for scope in ["identity", "organisation"] {
        for entitlement in ["allowed", "requestable", "denied"] {
            for ready in [true, false] {
                let mut value = snapshot();
                value.entries[0].credential_scope = scope.into();
                value.entries[0].entitlement = entitlement.into();
                value.accounts_state = if ready { "ready" } else { "unavailable" }.into();
                assert_eq!(
                    personal_setup(&value, "conn_google", &["google_oauth"], true).is_ok(),
                    scope == "identity" && entitlement == "allowed" && ready
                );
            }
        }
    }
}

#[test]
fn reconciliation_requires_observed_change_and_complete_accounts() {
    let mut value = snapshot();
    let activation = Confirmation::Activation {
        connection_id: "conn_google".into(),
        enabled: true,
        previous_version: 2,
    };
    assert!(!activation.matches(&value, WriteOutcome::Accepted));
    value.entries[0].activation.version = 3;
    assert!(activation.matches(&value, WriteOutcome::Accepted));
    let key = Confirmation::Key {
        connection_id: "conn_google".into(),
        connector_id: "google-workspace".into(),
        previous: vec![(
            "acc_mine".into(),
            "2026-09-17T00:00:00Z".into(),
            "active".into(),
        )],
    };
    assert!(!key.matches(&value, WriteOutcome::Accepted));
    value.accounts[0].updated_at = "2026-09-17T00:01:00Z".into();
    assert!(key.matches(&value, WriteOutcome::Accepted));
    let disconnected = Confirmation::Disconnect {
        account_id: "acc_mine".into(),
        connection_id: "conn_google".into(),
        connector_id: "google-workspace".into(),
    };
    assert!(!disconnected.matches(&value, WriteOutcome::Accepted));
    value.accounts.clear();
    value.accounts_state = "unavailable".into();
    assert!(!disconnected.matches(&value, WriteOutcome::Accepted));
    value.accounts_state = "ready".into();
    assert!(disconnected.matches(&value, WriteOutcome::Accepted));
}

#[test]
fn filtered_inventory_absence_does_not_confirm_disconnect_after_catalog_access_loss() {
    let session = serde_json::from_value::<super::super::oauth::Session>(serde_json::json!({
        "access_token": format!("sym_{}", "t".repeat(43)),
        "token_type": "Bearer", "expires_at": "2099-01-01T00:00:00Z",
        "identity_id": "usr_test", "org_id": "org_symmitri",
    }))
    .unwrap();
    let confirmation = Confirmation::Disconnect {
        account_id: "acc_mine".into(),
        connection_id: "conn_google".into(),
        connector_id: "google-workspace".into(),
    };
    for removed in [false, true] {
        let mut value = snapshot();
        if removed {
            value.entries.clear();
        } else {
            value.entries[0].visibility = "hidden".into();
            value.entries[0].entitlement = "denied".into();
        }
        let catalog = Catalog {
            schema_version: 1,
            principal: value.principal.clone(),
            organisation: value.organisation.clone(),
            entries: value.entries.clone(),
        };
        // The account remains saved in the real inventory. Catalog filtering
        // removes it from the public snapshot without deleting the credential.
        let inventory = serde_json::from_value::<Inventory>(serde_json::json!({
            "accounts": [{
                "id": "acc_mine", "connection_id": "conn_google",
                "connector_id": "google-workspace", "connector_name": "Google Workspace",
                "provider": "google-workspace", "credential_owner_type": "human",
                "credential_owner_id": "usr_test", "credential_owner_name": "You",
                "status": "active", "connected_at": "2026-09-17T00:00:00Z",
                "updated_at": "2026-09-17T00:00:00Z"
            }]
        }))
        .unwrap();
        value.accounts = validate_accounts(inventory, &catalog, &session).unwrap();
        assert!(value.accounts.is_empty());
        assert_eq!(value.accounts_state, "ready");
        assert!(!confirmation.matches(&value, WriteOutcome::Accepted));
    }
    let mut value = snapshot();
    value.accounts.clear();
    value.entries[0].readiness = "unavailable".into();
    assert!(!confirmation.matches(&value, WriteOutcome::Accepted));
}

#[tokio::test]
async fn transient_write_is_uncertain_and_never_replayed() {
    let calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/write", listener.local_addr().unwrap());
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .fallback(any(
                    |State(calls): State<Arc<AtomicUsize>>, method: Method| async move {
                        assert_eq!(method, Method::POST);
                        calls.fetch_add(1, Ordering::SeqCst);
                        StatusCode::SERVICE_UNAVAILABLE
                    },
                ))
                .with_state(calls.clone()),
        )
        .into_future(),
    );
    let result = send_write(
        reqwest::Client::new()
            .post(url)
            .json(&serde_json::json!({"enabled": true})),
    )
    .await;
    assert!(matches!(result, WriteOutcome::Uncertain));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn missing_account_after_failed_secret_cleanup_does_not_confirm_disconnect() {
    let calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .fallback(any(
                    |State(calls): State<Arc<AtomicUsize>>, method: Method, uri: Uri| async move {
                        assert_eq!(method, Method::DELETE);
                        calls.fetch_add(1, Ordering::SeqCst);
                        let mut body = serde_json::json!({
                            "error": {
                                "code": "connector_secret_cleanup_failed",
                                "message": "private fixture detail must never be exported"
                            }
                        });
                        match uri.path() {
                            "/unknown" => {
                                body["error"]["code"] = serde_json::json!("other_failure")
                            }
                            "/oversized" => body["padding"] = serde_json::json!("x".repeat(5000)),
                            "/wrong-shape" => {
                                body["error"] = serde_json::json!("connector_secret_cleanup_failed")
                            }
                            _ => {}
                        }
                        (StatusCode::SERVICE_UNAVAILABLE, axum::Json(body))
                    },
                ))
                .with_state(calls.clone()),
        )
        .into_future(),
    );
    let outcome = send_write(reqwest::Client::new().delete(format!("{origin}/accounts"))).await;
    assert!(matches!(outcome, WriteOutcome::CleanupRequired));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let mut value = snapshot();
    value.accounts.clear();
    value.entries[0].readiness = "account_required".into();
    let confirmation = Confirmation::Disconnect {
        account_id: "acc_mine".into(),
        connection_id: "conn_google".into(),
        connector_id: "google-workspace".into(),
    };
    assert!(!confirmation.matches(&value, outcome));
    assert!(confirmation.matches(&value, WriteOutcome::Accepted));
    // The real command uses this same result projection after reconciliation.
    let public = outcome.unconfirmed(Some(value));
    let serialized = serde_json::to_string(&public).unwrap();
    match public {
        ConnectionsMutationResult::NotConfirmed {
            snapshot: Some(snapshot),
            message,
        } => {
            assert!(snapshot.accounts.is_empty());
            assert_eq!(message, "Gateway access was revoked. Ask a company administrator to complete provider secret cleanup.");
        }
        _ => panic!("cleanup failure must remain unconfirmed with administrator follow-up"),
    }
    assert!(!serialized.contains("private fixture detail"));
    for path in ["unknown", "oversized", "wrong-shape"] {
        let outcome = send_write(reqwest::Client::new().delete(format!("{origin}/{path}"))).await;
        assert!(matches!(outcome, WriteOutcome::Uncertain));
        let public = serde_json::to_string(&outcome.unconfirmed(None)).unwrap();
        assert!(!public.contains("administrator"));
        assert!(!public.contains("private fixture detail"));
    }
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    server.abort();
}
