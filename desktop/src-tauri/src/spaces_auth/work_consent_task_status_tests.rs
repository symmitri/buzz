use super::*;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    routing::any,
    Json, Router,
};
use nostr::Keys;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::Manager;

#[derive(Clone)]
struct Fixture(Arc<Mutex<Data>>);
struct Data {
    config: Value,
    consent: Value,
    status: Value,
    requests: Vec<(String, String, Value)>,
    next: Option<Value>,
    enabled: bool,
    owner: &'static str,
    status_read: bool,
    lose_owner: bool,
    lose_signer: bool,
    postflight_delay_ms: u64,
    status_code: u16,
}
async fn serve(
    State(f): State<Fixture>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let (value, code, delay) = {
        let mut data = f.0.lock().unwrap();
        assert_eq!(
            headers.get("authorization").unwrap().to_str().unwrap(),
            format!("Bearer sym_{}", "s".repeat(43))
        );
        assert_eq!(headers.get("cache-control").unwrap(), "no-store");
        assert_eq!(headers.get("x-axis-buzz-environment").unwrap(), "alpha");
        assert_eq!(headers.get_all("x-axis-buzz-environment").iter().count(), 1);
        let input = serde_json::from_slice(&body).unwrap_or(Value::Null);
        data.requests
            .push((method.to_string(), uri.path().into(), input));
        let mut code = StatusCode::OK;
        let mut delay = 0;
        let value = match (method.as_str(), uri.path()) {
            ("GET", "/v1/me") => {
                if data.status_read {
                    delay = data.postflight_delay_ms;
                }
                let owner = if data.status_read && data.lose_owner {
                    "usr_other"
                } else {
                    data.owner
                };
                json!({"identity":{"id":owner,"org_id":"org_symmitri","type":"user","email_verified":true}})
            }
            ("GET", "/v1/space/buzz/config") => {
                let mut config = data.config.clone();
                if data.status_read && data.lose_signer {
                    config["pubkey"] = json!(Keys::generate().public_key().to_hex());
                }
                config
            }
            ("GET", "/v1/space/work-consents/capabilities") => {
                json!({"enabled":data.enabled,"schemaVersion":1,"lookup":"native_origin"})
            }
            ("POST", "/v1/space/work-consents/task-status/query") => {
                data.status_read = true;
                code = StatusCode::from_u16(data.status_code).unwrap();
                data.status.clone()
            }
            ("POST", "/v1/space/work-consents/query") => {
                let mut lookup =
                    json!({"workId":"work_fixture","requests":[data.consent],"participants":[]});
                if let Some(next) = &data.next {
                    lookup["next"] = next.clone();
                }
                lookup
            }
            _ => panic!("unexpected task status route {method} {uri}"),
        };
        (value, code, delay)
    };
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    (code, Json(value))
}
fn at(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
fn status(now: DateTime<Utc>) -> Value {
    json!({"orgId":"org_symmitri","ownerId":"usr_owner","workId":"work_fixture","observedAt":at(now),
        "statuses":[{"consentId":"consent_fixture","consentVersion":2,"termsDigest":"a".repeat(64),"state":"running","revision":1,
        "updatedAt":at(now - chrono::Duration::seconds(1)),"leaseExpiresAt":at(now + chrono::Duration::seconds(60))}]})
}
async fn fixture() -> (
    Fixture,
    String,
    Client,
    oauth::Session,
    native_scope::Scope,
    ThreadInput,
) {
    let now = Utc::now();
    let keys = Keys::generate();
    let config = json!({"enabled":true,"org_id":"org_symmitri","identity_id":"usr_owner","tenant_id":"tenant_fixture",
        "relay_url":"https://relay.example.test","relay_pubkey":Keys::generate().public_key().to_hex(),"environment":"alpha","pubkey":keys.public_key().to_hex()});
    let scope = native_scope::Scope {
        generation: 1,
        cancel: tokio_util::sync::CancellationToken::new(),
        config: serde_json::from_value(config.clone()).unwrap(),
        keys,
    };
    let mut consent =
        serde_json::from_str::<Value>(include_str!("../../../tests/fixtures/work-consent.json"))
            .unwrap()["consent"]
            .clone();
    consent["terms"]["orgId"] = json!("org_symmitri");
    consent["state"] = json!("approved");
    consent["version"] = json!(2);
    consent["createdAt"] = json!(at(now - chrono::Duration::hours(1)));
    consent["terms"]["expiresAt"] = json!(at(now + chrono::Duration::hours(1)));
    let fixture = Fixture(Arc::new(Mutex::new(Data {
        config,
        consent,
        status: status(now),
        requests: vec![],
        next: None,
        enabled: true,
        owner: "usr_owner",
        status_read: false,
        lose_owner: false,
        lose_signer: false,
        postflight_delay_ms: 0,
        status_code: 200,
    })));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .fallback(any(serve))
        .with_state(fixture.clone());
    tokio::spawn(async {
        axum::serve(listener, app).await.unwrap();
    });
    let session = serde_json::from_value(
        json!({"access_token":format!("sym_{}", "s".repeat(43)),"token_type":"Bearer",
        "identity_id":"usr_owner","org_id":"org_symmitri","expires_at":"2099-01-01T00:00:00Z"}),
    )
    .unwrap();
    let thread = ThreadInput {
        client_id: "status_view".into(),
        channel_id: "channel_fixture".into(),
        root_event_id: "d".repeat(64),
        admission_request_id: None,
        before: None,
        expected_scope_token: None,
        expected_relay_url: "wss://relay.example.test".into(),
        expected_signer_pubkey: scope.keys.public_key().to_hex(),
    };
    (
        fixture,
        address,
        oauth::client().unwrap(),
        session,
        scope,
        thread,
    )
}
async fn run(
    client: &Client,
    session: &oauth::Session,
    url: &str,
    scope: &native_scope::Scope,
    input: &ThreadInput,
) -> Result<CommandResult, Failure> {
    perform(
        client,
        session,
        url,
        scope,
        &Action::TaskStatus(input),
        &SpacesWorkConsent::default(),
        || Ok(()),
    )
    .await
}

#[tokio::test]
async fn actual_status_adapter_correlates_current_owner_and_history_page_without_private_details() {
    let (f, url, client, session, scope, mut thread) = fixture().await;
    thread.before = Some(Cursor {
        created_at: "2026-09-17T12:00:00Z".into(),
        id: "consent_newer".into(),
    });
    thread.expected_scope_token = Some(scope_token(&scope));
    {
        let mut data = f.0.lock().unwrap();
        let next = json!({"id":data.consent["id"],"createdAt":data.consent["createdAt"]});
        data.next = Some(next.clone());
        data.status["next"] = next;
    }
    let result =
        serde_json::to_value(run(&client, &session, &url, &scope, &thread).await.unwrap()).unwrap();
    assert_eq!(result["state"], "ready");
    assert_eq!(result["principalId"], "usr_owner");
    assert_eq!(result["lookup"]["statuses"][0]["state"], "running");
    assert_eq!(result["lookup"]["ownerId"], "usr_owner");
    assert!(result["lookup"].get("participants").is_none());
    assert!(result["lookup"].get("accounts").is_none());
    assert!(!result.to_string().contains("taskSummary"));
    let data = f.0.lock().unwrap();
    let posts: Vec<_> = data
        .requests
        .iter()
        .filter(|(method, _, _)| method == "POST")
        .collect();
    assert_eq!(posts.len(), 2);
    assert_eq!(posts[0].1, "/v1/space/work-consents/task-status/query");
    assert_eq!(posts[1].1, "/v1/space/work-consents/query");
    assert_eq!(posts[0].2, posts[1].2);
    assert_eq!(posts[0].2["before"]["id"], "consent_newer");
    assert_eq!(posts[0].2["origin"]["orgId"], scope.config.org_id);
    assert_eq!(
        posts[0].2["origin"]["relayPubkey"],
        scope.config.relay_pubkey
    );
    assert!(posts[0].2.get("ownerId").is_none());
    assert!(posts[0].2.get("actorId").is_none());
}

#[tokio::test]
async fn current_consent_invalidation_overrides_old_running_checkpoint() {
    for state in ["pending", "declined", "revoked", "expired", "stale"] {
        let (f, url, client, session, scope, thread) = fixture().await;
        {
            let mut data = f.0.lock().unwrap();
            data.consent["state"] = json!(state);
            data.consent["version"] = json!(3);
            data.consent["termsDigest"] = json!("b".repeat(64));
        }
        let result =
            serde_json::to_value(run(&client, &session, &url, &scope, &thread).await.unwrap())
                .unwrap();
        let current = &result["lookup"]["statuses"][0];
        assert_eq!(current["state"], state);
        assert_eq!(current["consentVersion"], 3);
        assert_eq!(current["termsDigest"], "b".repeat(64));
        assert_eq!(current["revision"], 0);
        assert!(current.get("leaseExpiresAt").is_none());
        assert!(current.get("updatedAt").is_none());
    }
}

#[tokio::test]
async fn owner_work_page_and_approved_incarnation_mismatches_are_rejected() {
    for case in [
        "owner",
        "org",
        "work",
        "consent",
        "version",
        "digest",
        "foreign_consent",
        "cursor",
    ] {
        let (f, url, client, session, scope, thread) = fixture().await;
        {
            let mut data = f.0.lock().unwrap();
            match case {
                "owner" => data.status["ownerId"] = json!("usr_other"),
                "org" => data.status["orgId"] = json!("org_other"),
                "work" => data.status["workId"] = json!("work_other"),
                "consent" => data.status["statuses"][0]["consentId"] = json!("consent_other_page"),
                "version" => data.status["statuses"][0]["consentVersion"] = json!(1),
                "digest" => data.status["statuses"][0]["termsDigest"] = json!("d".repeat(64)),
                "foreign_consent" => data.consent["terms"]["grantorId"] = json!("usr_other"),
                _ => {
                    data.status["next"] =
                        json!({"createdAt":"2026-09-17T12:00:00Z","id":"consent_other"})
                }
            }
        }
        assert!(
            run(&client, &session, &url, &scope, &thread).await.is_err(),
            "{case}"
        );
    }
}

#[tokio::test]
async fn strict_status_shapes_bounds_and_timestamp_semantics_are_enforced() {
    for case in [
        "unknown",
        "private",
        "null",
        "duplicate",
        "count",
        "revision",
        "revision_time",
        "loss_revision",
        "missing_lease",
        "terminal_lease",
        "long_lease",
        "old_lease",
        "future",
        "offset",
        "invalid_date",
        "leap_second",
        "cursor_null",
    ] {
        let (f, url, client, session, scope, thread) = fixture().await;
        {
            let mut data = f.0.lock().unwrap();
            let observed = instant(data.status["observedAt"].as_str().unwrap()).unwrap();
            match case {
                "unknown" => data.status["peers"] = json!([]),
                "private" => data.status["statuses"][0]["artifactPath"] = json!("private/path"),
                "null" => data.status["statuses"][0]["updatedAt"] = Value::Null,
                "duplicate" => {
                    data.status["statuses"] =
                        json!([data.status["statuses"][0], data.status["statuses"][0]])
                }
                "count" => {
                    data.status["statuses"] = json!(vec![data.status["statuses"][0].clone(); 101])
                }
                "revision" => {
                    data.status["statuses"][0]["revision"] = json!(9_007_199_254_740_990_u64)
                }
                "revision_time" => data.status["statuses"][0]["revision"] = json!(0),
                "loss_revision" => data.status["statuses"][0]["state"] = json!("revoked"),
                "missing_lease" => {
                    data.status["statuses"][0]
                        .as_object_mut()
                        .unwrap()
                        .remove("leaseExpiresAt");
                }
                "terminal_lease" => data.status["statuses"][0]["state"] = json!("candidate_ready"),
                "long_lease" => {
                    data.status["statuses"][0]["leaseExpiresAt"] =
                        json!(at(observed + chrono::Duration::seconds(121)))
                }
                "old_lease" => data.status["statuses"][0]["leaseExpiresAt"] = json!(at(observed)),
                "future" => {
                    data.status["observedAt"] =
                        json!(at(Utc::now() + chrono::Duration::seconds(60)))
                }
                "offset" => data.status["observedAt"] = json!("2026-09-17T12:00:00+00:00"),
                "invalid_date" => data.status["observedAt"] = json!("2026-02-30T12:00:00Z"),
                "leap_second" => data.status["observedAt"] = json!("2026-09-17T12:00:60Z"),
                _ => data.status["next"] = Value::Null,
            }
        }
        assert!(
            matches!(
                run(&client, &session, &url, &scope, &thread).await,
                Err(Failure::Invalid)
            ),
            "{case}"
        );
    }
}

#[tokio::test]
async fn queued_and_running_leases_expire_during_native_postflight() {
    for state in ["queued", "running"] {
        let (f, url, client, session, scope, thread) = fixture().await;
        {
            let mut data = f.0.lock().unwrap();
            data.status["statuses"][0]["state"] = json!(state);
            data.status["statuses"][0]["leaseExpiresAt"] =
                json!(at(Utc::now() + chrono::Duration::milliseconds(350)));
            data.postflight_delay_ms = 500;
        }
        let result =
            serde_json::to_value(run(&client, &session, &url, &scope, &thread).await.unwrap())
                .unwrap();
        assert_eq!(result["lookup"]["statuses"][0]["state"], "unconfirmed");
        assert!(result["lookup"]["statuses"][0]
            .get("leaseExpiresAt")
            .is_none());
        assert_eq!(result["lookup"]["statuses"][0]["revision"], 1);
    }
}

#[tokio::test]
async fn status_never_implies_execution_without_a_confirmed_checkpoint() {
    for state in ["unconfirmed", "candidate_ready", "failed"] {
        let (f, url, client, session, scope, thread) = fixture().await;
        {
            let mut data = f.0.lock().unwrap();
            let status = &mut data.status["statuses"][0];
            status["state"] = json!(state);
            status.as_object_mut().unwrap().remove("leaseExpiresAt");
            if state == "unconfirmed" {
                status["revision"] = json!(0);
                status.as_object_mut().unwrap().remove("updatedAt");
            }
        }
        let result =
            serde_json::to_value(run(&client, &session, &url, &scope, &thread).await.unwrap())
                .unwrap();
        assert_eq!(result["lookup"]["statuses"][0]["state"], state);
        assert!(!result.to_string().contains("publication"));
    }
}

#[tokio::test]
async fn status_reads_observe_current_human_signer_generation_and_server_gate() {
    for case in [
        "owner_before",
        "owner_after",
        "signer_after",
        "generation",
        "disabled",
        "http",
    ] {
        let (f, url, client, session, scope, thread) = fixture().await;
        {
            let mut data = f.0.lock().unwrap();
            match case {
                "owner_before" => data.owner = "usr_other",
                "owner_after" => data.lose_owner = true,
                "signer_after" => data.lose_signer = true,
                "disabled" => data.enabled = false,
                "http" => data.status_code = 503,
                _ => (),
            }
        }
        let current = || {
            if case == "generation" && f.0.lock().unwrap().status_read {
                Err(Failure::AccessLost)
            } else {
                Ok(())
            }
        };
        let result = perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::TaskStatus(&thread),
            &SpacesWorkConsent::default(),
            current,
        )
        .await;
        match case {
            "disabled" => assert!(matches!(result, Ok(CommandResult::Unsupported))),
            "http" => assert!(matches!(result, Err(Failure::Unavailable))),
            _ => assert!(matches!(result, Err(Failure::AccessLost)), "{case}"),
        }
        let data = f.0.lock().unwrap();
        if matches!(case, "owner_before" | "disabled") {
            assert!(!data.status_read);
        }
        if case == "generation" {
            assert!(!data
                .requests
                .iter()
                .any(|(_, route, _)| route == "/v1/space/work-consents/query"));
        }
    }
}

#[cfg(not(feature = "spaces-work-consent-candidate"))]
#[tokio::test]
async fn actual_tauri_status_command_remains_hard_gated_before_session_access() {
    let (_, _, _, _, _, input) = fixture().await;
    let app = tauri::test::mock_builder()
        .manage(SpacesAuth::default())
        .manage(SpacesCommunity::default())
        .manage(crate::app_state::build_app_state())
        .manage(SpacesWorkConsent::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let result = spaces_query_work_consent_task_status(
        app.handle().clone(),
        app.state(),
        app.state(),
        app.state(),
        app.state(),
        input,
    )
    .await
    .unwrap();
    assert!(matches!(result, CommandResult::Unsupported));
}
