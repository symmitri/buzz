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
struct Fixture {
    data: Arc<Mutex<Data>>,
}
struct Data {
    config: Value,
    record: Value,
    requests: Vec<(String, String, Value)>,
    enabled: bool,
    owner: &'static str,
    change_owner_after_query: bool,
    lose_signer_after_read: bool,
    post_status: u16,
    commit: bool,
    replay: Option<Value>,
    oversized: bool,
    participant_count: usize,
    request_count: usize,
    intent: Value,
    intent_accounts: Vec<Value>,
    intent_bound: bool,
    intent_hidden: bool,
    omit_bound: bool,
    intent_work_id: String,
    intent_result: Option<Value>,
    fail_postflight: bool,
    revoke_auth_after_query: Option<Arc<Mutex<super::super::Operation>>>,
}

async fn serve(
    State(f): State<Fixture>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let mut data = f.data.lock().unwrap();
    assert_eq!(
        headers.get("authorization").unwrap().to_str().unwrap(),
        format!("Bearer sym_{}", "s".repeat(43))
    );
    assert_eq!(headers.get("x-axis-buzz-environment").unwrap(), "alpha");
    assert_eq!(headers.get_all("x-axis-buzz-environment").iter().count(), 1);
    let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    data.requests
        .push((method.to_string(), uri.path().into(), input.clone()));
    if uri.path().ends_with("/query") {
        if let Some(auth) = &data.revoke_auth_after_query {
            auth.lock().unwrap().cancel.cancel();
        }
    }
    let value = match (method.as_str(), uri.path()) {
        ("GET", "/v1/me") => {
            if data.fail_postflight
                && data
                    .requests
                    .iter()
                    .any(|(_, path, _)| path.ends_with("/select"))
            {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"unavailable"})),
                );
            }
            json!({"identity":{"id":data.owner,"org_id":"org_symmitri","type":"user","email_verified":true}})
        }
        ("GET", "/v1/space/buzz/config") => data.config.clone(),
        ("GET", "/v1/space/work-consents/capabilities") => {
            json!({"enabled":data.enabled,"schemaVersion":1,"lookup":"native_origin"})
        }
        ("POST", "/v1/space/work-consents/intents/query") => {
            if data.change_owner_after_query {
                data.owner = "usr_other";
            }
            json!({"workId":data.intent_work_id,"intents": if data.intent_bound || data.intent_hidden { vec![] } else { vec![data.intent.clone()] }})
        }
        ("GET", "/v1/space/work-consents/intents/intent_one") => {
            if data.lose_signer_after_read {
                data.config["pubkey"] = json!(Keys::generate().public_key().to_hex());
            }
            let mut result = json!({"intent":data.intent,"accounts":data.intent_accounts});
            if data.intent_bound && !data.omit_bound {
                result["consent"] = data.record.clone();
            }
            result
        }
        ("POST", "/v1/space/work-consents/intents/intent_one/select") => {
            if data.post_status == 409 {
                return (StatusCode::CONFLICT, Json(json!({"error":"conflict"})));
            }
            if data.commit {
                data.intent_bound = true;
                data.record["terms"]["accountId"] = input["accountId"].clone();
                data.record["terms"]["accountVersion"] = input["accountVersion"].clone();
            }
            if data.post_status != 200 {
                return (
                    StatusCode::from_u16(data.post_status).unwrap(),
                    Json(json!({"error":"unavailable"})),
                );
            }
            data.intent_result
                .clone()
                .unwrap_or_else(|| data.record.clone())
        }
        ("POST", "/v1/space/work-consents/query") => {
            if data.change_owner_after_query {
                data.owner = "usr_other";
            }
            if data.oversized {
                return (
                    StatusCode::OK,
                    Json(json!({"private":"x".repeat(LIMIT + 1)})),
                );
            }
            let participants: Vec<_> = (0..data.participant_count).map(|index| json!({
                "grantorId": if index == 0 { "usr_other".into() } else { format!("usr_other_{index}") },
                "state": "pending",
            })).collect();
            let requests: Vec<_> = (0..data.request_count)
                .map(|index| {
                    let mut record = data.record.clone();
                    if index != 0 {
                        record["id"] = json!(format!("consent_one_{index}"));
                    }
                    record
                })
                .collect();
            json!({"workId":"work_one","requests":requests,"participants":participants})
        }
        ("POST", "/v1/space/work-consents/task-status/query") => {
            let now = chrono::Utc::now();
            let approved = data.record["state"] == "approved";
            let mut status = json!({"consentId":data.record["id"],"consentVersion":data.record["version"],"termsDigest":data.record["termsDigest"],"state":data.record["state"],"revision":0});
            if approved {
                status["state"] = json!("queued");
                status["revision"] = json!(1);
                status["updatedAt"] = json!(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
                status["leaseExpiresAt"] = json!((now + chrono::Duration::seconds(60)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            }
            json!({"orgId":"org_symmitri","ownerId":data.owner,"workId":"work_one","observedAt":now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),"statuses":[status]})
        }
        ("GET", "/v1/space/work-consents/consent_one") => {
            if data.lose_signer_after_read {
                data.config["pubkey"] = json!(Keys::generate().public_key().to_hex());
            }
            data.record.clone()
        }
        ("GET", "/v1/connection-accounts") => json!({"accounts":[
            {"id":"account_one","connection_id":"conn_granola","provider":"granola","credential_owner_type":"personal","credential_owner_id":"usr_other","account_label":"PRIVATE OTHER ACCOUNT"},
            {"id":"account_one","connection_id":"conn_granola","provider":"granola","credential_owner_type":"personal","credential_owner_id":"usr_owner","account_label":"My meetings","account_email":"owner@example.test"}
        ]}),
        ("POST", "/v1/space/work-consents/consent_one/decisions") => {
            if data.post_status == 409 {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({"private":"sensitive error"})),
                );
            }
            if data.commit {
                data.record["version"] = json!(input["expectedVersion"].as_u64().unwrap() + 1);
                data.record["state"] = json!(match input["decision"].as_str().unwrap() {
                    "approve" => "approved",
                    "decline" => "declined",
                    _ => "revoked",
                });
            }
            if data.post_status != 200 {
                return (
                    StatusCode::from_u16(data.post_status).unwrap(),
                    Json(json!({"private":"sensitive error"})),
                );
            }
            let receipt = data.replay.clone().unwrap_or_else(|| json!({"receiptId":"receipt_one","operationId":input["operationId"],"actorId":"usr_owner","consentId":"consent_one","termsDigest":input["termsDigest"],"version":input["expectedVersion"].as_u64().unwrap() + 1,"decision":input["decision"],"decidedAt":"2050-09-17T13:00:00Z"}));
            json!({"receipt":receipt,"consent":data.record})
        }
        _ => panic!("unexpected request {method} {uri}"),
    };
    (StatusCode::OK, Json(value))
}
fn record() -> Value {
    json!({"id":"consent_one","terms":{
        "orgId":"org_symmitri","grantorId":"usr_owner","applicationId":"app_spaces","workloadIdentityId":"workload_symi",
        "task":{"workId":"work_one","requestId":"request_one","requesterId":"usr_initiator","agentId":"agent_symi","conversationId":"conversation_one","sessionId":"session_one","bindingVersion":1,"audienceVersion":1,"audienceDigest":"a".repeat(64),"authorizationEpoch":1},
        "accountId":"account_one","accountVersion":1,"connectionId":"conn_granola","provider":"granola","taskSummary":"Find roadmap proposals from two morning meetings",
        "scope":{"mechanicsVersion":1,"allowRecordingTimeProbes":true,"maxProbePagesPerNote":8,"maxProviderCalls":128,"maxTranscriptPagesPerNote":32,"maxBytes":16777216,"timeZone":"America/New_York","meetingStart":"2050-09-17T12:00:00Z","meetingEnd":"2050-09-17T16:00:00Z","selection":"latest_meetings","noteIds":[],"maxNotes":2,"maxListPages":5,"pageSize":30,"allowedTools":["list_notes","get_note"],"includeTranscript":true},
        "audience":{"digest":"a".repeat(64),"revision":"b".repeat(64),"version":1},"outputAudience":{"kind":"private_contribution","ownerId":"usr_owner"},"sharing":"owner_review_required","expiresAt":"2050-09-17T18:00:00Z"
    },"termsDigest":"c".repeat(64),"version":1,"state":"pending","createdAt":"2050-09-17T12:00:00Z","executionEnabled":false})
}
fn intent_record() -> Value {
    let record = record();
    let mut terms = record["terms"].clone();
    for key in [
        "grantorId",
        "accountId",
        "accountVersion",
        "connectionId",
        "provider",
        "outputAudience",
        "sharing",
    ] {
        terms.as_object_mut().unwrap().remove(key);
    }
    json!({"id":"intent_one","version":1,"digest":"e".repeat(64),"createdAt":record["createdAt"],"state":"select_account","terms":terms})
}
async fn fixture() -> (
    Fixture,
    String,
    Client,
    oauth::Session,
    native_scope::Scope,
    ThreadInput,
) {
    let keys = Keys::generate();
    let config = json!({"enabled":true,"org_id":"org_symmitri","identity_id":"usr_owner","tenant_id":"tenant_alpha","relay_url":"https://relay.example.test","relay_pubkey":Keys::generate().public_key().to_hex(),"environment":"alpha","pubkey":keys.public_key().to_hex(),"people":[{"identity_id":"usr_initiator","name":"The requester"}],"agents":[{"agent_id":"agent_symi","name":"Symi"}]});
    let scope = native_scope::Scope {
        generation: 1,
        cancel: tokio_util::sync::CancellationToken::new(),
        config: serde_json::from_value(config.clone()).unwrap(),
        keys,
    };
    let fixture = Fixture {
        data: Arc::new(Mutex::new(Data {
            config,
            record: record(),
            requests: vec![],
            enabled: true,
            owner: "usr_owner",
            change_owner_after_query: false,
            lose_signer_after_read: false,
            post_status: 200,
            commit: true,
            replay: None,
            oversized: false,
            participant_count: 1,
            request_count: 1,
            intent: intent_record(),
            intent_accounts: vec![
                json!({"accountId":"account_one","accountVersion":1,"connectionId":"conn_granola","provider":"granola","label":"My meetings","email":"owner@example.test"}),
            ],
            intent_bound: false,
            intent_hidden: false,
            omit_bound: false,
            intent_work_id: "work_one".into(),
            intent_result: None,
            fail_postflight: false,
            revoke_auth_after_query: None,
        })),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .fallback(any(serve))
        .with_state(fixture.clone());
    tokio::spawn(async {
        axum::serve(listener, app).await.unwrap();
    });
    let session = serde_json::from_value(json!({"access_token":format!("sym_{}", "s".repeat(43)),"token_type":"Bearer","identity_id":"usr_owner","org_id":"org_symmitri","expires_at":"2099-01-01T00:00:00Z"})).unwrap();
    let thread = ThreadInput {
        client_id: "view_one".into(),
        channel_id: "channel_one".into(),
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
fn read_input(scope: &native_scope::Scope, mut thread: ThreadInput) -> ReadInput {
    thread.expected_scope_token = Some(scope_token(scope));
    ReadInput {
        thread,
        consent_id: "consent_one".into(),
        source_intent_id: None,
        source_intent_before: None,
    }
}
fn decision(scope: &native_scope::Scope, thread: ThreadInput, choice: Decision) -> DecideInput {
    DecideInput {
        read: read_input(scope, thread),
        decision: DecisionInput {
            operation_id: "operation_one".into(),
            expected_version: 1,
            terms_digest: "c".repeat(64),
            decision: choice,
        },
    }
}
fn posts(fixture: &Fixture) -> Vec<Value> {
    fixture
        .data
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|(_, path, _)| path.ends_with("/decisions"))
        .map(|(_, _, body)| body.clone())
        .collect()
}

#[tokio::test]
async fn production_query_only_returns_owner_records_safe_status_and_exact_labels() {
    let (f, url, client, session, scope, thread) = fixture().await;
    let result = perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Query(&thread),
        &SpacesWorkConsent::default(),
        || Ok(()),
    )
    .await
    .unwrap();
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["state"], "ready");
    assert_eq!(
        value["displays"]["consent_one"]["accountLabel"],
        "My meetings"
    );
    assert_eq!(value["displays"]["consent_one"]["agentLabel"], "Symi");
    assert_eq!(
        value["lookup"]["participants"][0],
        json!({"grantorId":"usr_other","state":"pending"})
    );
    assert!(!value.to_string().contains("PRIVATE OTHER ACCOUNT"));
    assert!(!value.to_string().contains("must never cross IPC"));
    let data = f.data.lock().unwrap();
    let body = &data
        .requests
        .iter()
        .find(|(_, path, _)| path.ends_with("/query"))
        .unwrap()
        .2;
    assert_eq!(body["origin"]["orgId"], "org_symmitri");
    assert!(body.get("admissionRequestId").is_none());
    assert!(posts_after_lock(&data).is_empty());
}
fn posts_after_lock(data: &Data) -> Vec<&Value> {
    data.requests
        .iter()
        .filter(|(_, path, _)| path.ends_with("/decisions"))
        .map(|(_, _, body)| body)
        .collect()
}

#[tokio::test]
async fn disabled_server_does_not_read_requests_or_accounts() {
    let (f, url, client, session, scope, thread) = fixture().await;
    f.data.lock().unwrap().enabled = false;
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Query(&thread),
            &SpacesWorkConsent::default(),
            || Ok(())
        )
        .await
        .unwrap(),
        CommandResult::Unsupported
    ));
    assert!(!f
        .data
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(_, path, _)| path.ends_with("/query") || path.ends_with("/connection-accounts")));
}

#[tokio::test]
async fn changed_person_and_native_signer_discard_otherwise_valid_reads() {
    for change_signer in [false, true] {
        let (f, url, client, session, scope, thread) = fixture().await;
        if change_signer {
            f.data.lock().unwrap().lose_signer_after_read = true;
        } else {
            f.data.lock().unwrap().change_owner_after_query = true;
        }
        let input = read_input(&scope, thread);
        assert!(matches!(
            perform(
                &client,
                &session,
                &url,
                &scope,
                &Action::Read(&input),
                &SpacesWorkConsent::default(),
                || Ok(())
            )
            .await,
            Err(Failure::AccessLost)
        ));
        assert!(posts(&f).is_empty());
    }
}

#[tokio::test]
async fn wrong_owner_and_wrong_work_never_cross_the_adapter() {
    for field in ["owner", "work"] {
        let (f, url, client, session, scope, thread) = fixture().await;
        if field == "owner" {
            f.data.lock().unwrap().record["terms"]["grantorId"] = json!("usr_other");
        } else {
            f.data.lock().unwrap().record["terms"]["task"]["workId"] = json!("work_other");
        }
        assert!(perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Query(&thread),
            &SpacesWorkConsent::default(),
            || Ok(())
        )
        .await
        .is_err());
        assert!(posts(&f).is_empty());
    }
}

#[tokio::test]
async fn changed_terms_send_exact_preconditions_once_and_surface_conflict() {
    let (f, url, client, session, scope, thread) = fixture().await;
    f.data.lock().unwrap().post_status = 409;
    let input = decision(&scope, thread, Decision::Approve);
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&input),
            &SpacesWorkConsent::default(),
            || Ok(())
        )
        .await,
        Err(Failure::Conflict)
    ));
    assert_eq!(
        posts(&f),
        vec![
            json!({"operationId":"operation_one","expectedVersion":1,"termsDigest":"c".repeat(64),"decision":"approve"})
        ]
    );
}

#[tokio::test]
async fn uncertain_decision_survives_hidden_view_and_reuses_exact_operation() {
    let (f, url, client, session, scope, thread) = fixture().await;
    {
        let mut data = f.data.lock().unwrap();
        data.post_status = 503;
        data.commit = false;
    }
    let operations = SpacesWorkConsent::default();
    let mut input = decision(&scope, thread.clone(), Decision::Approve);
    operations.begin(&thread.client_id, &scope).unwrap();
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&input),
            &operations,
            || Ok(())
        )
        .await,
        Err(Failure::Uncertain)
    ));
    operations.cancel(&thread.client_id).unwrap();
    let value = serde_json::to_value(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Query(&thread),
            &operations,
            || Ok(()),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        value["pendingDecisions"]["consent_one"]["operationId"],
        "operation_one"
    );
    input.decision.decision = Decision::Decline;
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&input),
            &operations,
            || Ok(())
        )
        .await,
        Err(Failure::Conflict)
    ));
    assert_eq!(posts(&f).len(), 1);
    input.decision.decision = Decision::Approve;
    input.decision.operation_id = "new_renderer_candidate".into();
    {
        let mut data = f.data.lock().unwrap();
        data.post_status = 200;
        data.commit = true;
    }
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&input),
            &operations,
            || Ok(())
        )
        .await
        .unwrap(),
        CommandResult::Confirmed { .. }
    ));
    assert_eq!(posts(&f).len(), 2);
    assert!(posts(&f)
        .iter()
        .all(|body| body["operationId"] == "operation_one"));
}

#[tokio::test]
async fn lost_success_is_reconciled_by_read_without_post_and_old_receipt_does_not_reactivate() {
    let (f, url, client, session, scope, thread) = fixture().await;
    f.data.lock().unwrap().post_status = 503;
    let operations = SpacesWorkConsent::default();
    let input = decision(&scope, thread.clone(), Decision::Approve);
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&input),
            &operations,
            || Ok(())
        )
        .await,
        Err(Failure::Uncertain)
    ));
    let value = serde_json::to_value(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Query(&thread),
            &operations,
            || Ok(()),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(value["lookup"]["requests"][0]["state"], "approved");
    assert_eq!(value["pendingDecisions"], json!({}));
    assert_eq!(posts(&f).len(), 1);
    {
        let mut data = f.data.lock().unwrap();
        data.record["version"] = json!(3);
        data.record["state"] = json!("revoked");
        data.commit = false;
        data.post_status = 200;
        data.replay = Some(
            json!({"receiptId":"receipt_one","operationId":"operation_one","actorId":"usr_owner","consentId":"consent_one","termsDigest":"c".repeat(64),"version":2,"decision":"approve","decidedAt":"2050-09-17T13:00:00Z"}),
        );
    }
    let value = serde_json::to_value(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&input),
            &operations,
            || Ok(()),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(value["result"]["receipt"]["decision"], "approve");
    assert_eq!(value["result"]["consent"]["state"], "revoked");
    assert_eq!(value["result"]["consent"]["executionEnabled"], false);
}

#[tokio::test]
async fn decline_and_revoke_use_the_same_fixed_decision_boundary() {
    for choice in [Decision::Decline, Decision::Revoke] {
        let (f, url, client, session, scope, thread) = fixture().await;
        let input = decision(&scope, thread, choice.clone());
        let value = serde_json::to_value(
            perform(
                &client,
                &session,
                &url,
                &scope,
                &Action::Decide(&input),
                &SpacesWorkConsent::default(),
                || Ok(()),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            value["result"]["consent"]["state"],
            if choice == Decision::Decline {
                "declined"
            } else {
                "revoked"
            }
        );
        assert_eq!(posts(&f).len(), 1);
    }
}

#[tokio::test]
async fn stale_scope_and_bounded_response_fail_closed() {
    let (f, url, client, session, scope, thread) = fixture().await;
    let mut input = read_input(&scope, thread.clone());
    input.thread.expected_scope_token = Some("stale".into());
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Read(&input),
            &SpacesWorkConsent::default(),
            || Ok(())
        )
        .await,
        Err(Failure::AccessLost)
    ));
    assert!(f.data.lock().unwrap().requests.is_empty());
    f.data.lock().unwrap().oversized = true;
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Query(&thread),
            &SpacesWorkConsent::default(),
            || Ok(())
        )
        .await,
        Err(Failure::Invalid)
    ));
    assert!(!serde_json::to_string(&Failure::Invalid.public())
        .unwrap()
        .contains("private"));
}

#[tokio::test]
async fn view_cancellation_isolated_and_new_identity_cannot_recover_old_journal() {
    let (_, _, _, _, mut scope, thread) = fixture().await;
    let operations = SpacesWorkConsent::default();
    let input = decision(&scope, thread, Decision::Approve);
    let (old, old_cancel) = operations.begin("one", &scope).unwrap();
    let (two, _) = operations.begin("two", &scope).unwrap();
    operations
        .reserve(&scope, "consent_one", &input.decision)
        .unwrap();
    operations.cancel("one").unwrap();
    let (new, _) = operations.begin("one", &scope).unwrap();
    assert!(old_cancel.is_cancelled());
    assert_ne!(old, new);
    assert!(operations.current("one", old).is_err());
    assert!(operations.current("two", two).is_ok());
    scope.generation += 1;
    assert!(operations
        .observe(&scope, &[&serde_json::from_value(record()).unwrap()])
        .unwrap()
        .is_empty());
}

#[cfg(not(feature = "spaces-work-consent-candidate"))]
#[tokio::test]
async fn tauri_command_bodies_keep_all_entry_points_disabled() {
    let (_, _, _, _, scope, thread) = fixture().await;
    let app = tauri::test::mock_builder()
        .manage(SpacesAuth::default())
        .manage(SpacesCommunity::default())
        .manage(crate::app_state::build_app_state())
        .manage(SpacesWorkConsent::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    // Real Tauri in the repository lane. Portable harnesses must explicitly
    // disclose any Runtime/macro shell substituted for unavailable platform libs.
    let input:commands::ContextInput=serde_json::from_value(json!({"channelId":thread.channel_id,"rootEventId":thread.root_event_id,"expectedSignerPubkey":thread.expected_signer_pubkey})).unwrap();
    assert!(matches!(
        commands::spaces_work_consent_context(app.state(), app.state(), app.state(), input)
            .await
            .unwrap(),
        commands::ContextResult::Unsupported
    ));
    assert!(matches!(
        commands::spaces_query_work_consents(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            thread.clone()
        )
        .await
        .unwrap(),
        CommandResult::Unsupported
    ));
    assert!(matches!(
        commands::spaces_read_work_consent(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            read_input(&scope, thread.clone())
        )
        .await
        .unwrap(),
        CommandResult::Unsupported
    ));
    assert!(matches!(
        commands::spaces_decide_work_consent(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            decision(&scope, thread, Decision::Approve)
        )
        .await
        .unwrap(),
        CommandResult::Unsupported
    ));
}

#[tokio::test]
async fn exact_native_scope_guard_discards_a_signer_swap_after_query() {
    let (f, url, client, session, scope, thread) = fixture().await;
    let auth = SpacesAuth::default();
    auth.0.lock().unwrap().generation = scope.generation;
    let community = SpacesCommunity::default();
    *community.ready.lock().unwrap() = Some((
        scope.generation,
        super::super::community::PreparedCommunity {
            config: scope.config.clone(),
            keys: scope.keys.clone(),
        },
    ));
    let state = crate::app_state::build_app_state();
    *state.keys.lock().unwrap() = scope.keys.clone();
    *state.relay_url_override.lock().unwrap() = Some(scope.config.relay_url.clone());
    let calls = std::cell::Cell::new(0);
    let current = || {
        calls.set(calls.get() + 1);
        if calls.get() == 5 {
            *state.keys.lock().unwrap() = Keys::generate();
        }
        native_scope::current(&auth, &community, &scope, &state).map_err(|_| Failure::AccessLost)
    };
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Query(&thread),
            &SpacesWorkConsent::default(),
            current
        )
        .await,
        Err(Failure::AccessLost)
    ));
    assert!(f
        .data
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(_, path, _)| path.ends_with("/query")));
}

#[tokio::test]
async fn unknown_scope_fields_and_outside_budgets_are_rejected() {
    for case in [
        "unknown",
        "pages",
        "summary",
        "audience",
        "utc",
        "probes",
        "transcript",
        "bytes",
    ] {
        let (_, _, _, _, scope, _) = fixture().await;
        let mut value = record();
        match case {
            "unknown" => value["terms"]["scope"]["allowTranscriptProbe"] = json!(true),
            "pages" => value["terms"]["scope"]["pageSize"] = json!(31),
            "summary" => value["terms"]["taskSummary"] = json!("x".repeat(513)),
            "audience" => value["terms"]["audience"]["version"] = json!(2),
            "probes" => value["terms"]["scope"]["allowRecordingTimeProbes"] = json!(false),
            "transcript" => value["terms"]["scope"]["includeTranscript"] = json!(false),
            "bytes" => value["terms"]["scope"]["maxBytes"] = json!(16777217),
            _ => value["terms"]["scope"]["meetingStart"] = json!("2050-09-17T08:00:00-04:00"),
        }
        assert!(serde_json::from_value::<Record>(value)
            .map(|record| validate_record(&record, &scope))
            .map_or(true, |result| result.is_err()));
    }
}

#[tokio::test]
async fn ipc_deserialization_and_owner_cursor_keep_exact_page_scope() {
    let (f, url, client, session, scope, thread) = fixture().await;
    let value = json!({"clientId":thread.client_id,"channelId":thread.channel_id,"rootEventId":thread.root_event_id,"expectedRelayUrl":thread.expected_relay_url,"expectedSignerPubkey":thread.expected_signer_pubkey,"before":{"createdAt":"2050-09-17T12:00:00Z","id":"consent_older"},"expectedScopeToken":scope_token(&scope),"consentId":"consent_one","operationId":"operation_one","expectedVersion":1,"termsDigest":"c".repeat(64),"decision":"approve"});
    let input: DecideInput = serde_json::from_value(value).unwrap();
    perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Decide(&input),
        &SpacesWorkConsent::default(),
        || Ok(()),
    )
    .await
    .unwrap();
    assert!(f
        .data
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|(_, path, _)| path.ends_with("/query"))
        .all(|(_, _, body)| body["before"]["id"] == "consent_older"));
}

#[tokio::test]
async fn timestamp_probes_and_transcript_disclosure_are_independent_frozen_permissions() {
    let (_, _, _, _, scope, _) = fixture().await;
    let mut value = record();
    value["terms"]["scope"]["includeTranscript"] = json!(false);
    value["terms"]["scope"]["maxTranscriptPagesPerNote"] = json!(0);
    let record: Record = serde_json::from_value(value.clone()).unwrap();
    assert!(validate_record(&record, &scope).is_ok());
    assert!(record.terms.scope.allow_recording_time_probes);
    assert!(!record.terms.scope.include_transcript);
    value["terms"]["scope"]["allowRecordingTimeProbes"] = json!(false);
    value["terms"]["scope"]["maxProbePagesPerNote"] = json!(0);
    value["terms"]["scope"]["selection"] = json!("exact_notes");
    value["terms"]["scope"]["noteIds"] = json!(["not_12345678901234"]);
    assert!(validate_record(&serde_json::from_value(value).unwrap(), &scope).is_ok());
}

#[tokio::test]
async fn peer_summary_accepts_128_and_rejects_129_without_changing_owner_page_limit() {
    for (owners, peers, accepted) in [(100, 128, true), (100, 129, false), (101, 128, false)] {
        let (f, url, client, session, scope, thread) = fixture().await;
        {
            let mut data = f.data.lock().unwrap();
            data.participant_count = peers;
            data.request_count = owners;
        }
        let result = perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Query(&thread),
            &SpacesWorkConsent::default(),
            || Ok(()),
        )
        .await;
        if accepted {
            let value = serde_json::to_value(result.unwrap()).unwrap();
            assert_eq!(
                value["lookup"]["participants"].as_array().unwrap().len(),
                128
            );
            assert_eq!(value["lookup"]["requests"].as_array().unwrap().len(), 100);
        } else {
            assert!(matches!(result, Err(Failure::Invalid)));
        }
        assert!(posts(&f).is_empty());
    }
}

#[tokio::test]
async fn same_version_expiry_releases_unknown_approval_so_the_owner_can_revoke() {
    let (f, url, client, session, scope, thread) = fixture().await;
    {
        let mut data = f.data.lock().unwrap();
        data.post_status = 503;
        data.commit = false;
    }
    let operations = SpacesWorkConsent::default();
    let approve = decision(&scope, thread.clone(), Decision::Approve);
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&approve),
            &operations,
            || Ok(())
        )
        .await,
        Err(Failure::Uncertain)
    ));
    {
        let mut data = f.data.lock().unwrap();
        data.record["state"] = json!("expired");
        assert_eq!(data.record["version"], 1);
    }
    let refreshed = serde_json::to_value(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Query(&thread),
            &operations,
            || Ok(()),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(refreshed["lookup"]["requests"][0]["state"], "expired");
    assert_eq!(refreshed["pendingDecisions"], json!({}));
    let mut revoke = decision(&scope, thread, Decision::Revoke);
    revoke.decision.operation_id = "operation_revoke".into();
    {
        let mut data = f.data.lock().unwrap();
        data.post_status = 200;
        data.commit = true;
    }
    let result = serde_json::to_value(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&revoke),
            &operations,
            || Ok(()),
        )
        .await
        .unwrap(),
    )
    .unwrap();
    assert_eq!(result["result"]["consent"]["state"], "revoked");
    assert_eq!(
        posts(&f)
            .iter()
            .map(|body| body["decision"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["approve", "revoke"]
    );
}

#[tokio::test]
async fn same_version_uncertain_revoke_survives_until_authoritative_stop() {
    for (state, retained) in [
        ("approved", true),
        ("stale", true),
        ("expired", true),
        ("declined", false),
        ("revoked", false),
    ] {
        let (f, url, client, session, scope, thread) = fixture().await;
        let operations = SpacesWorkConsent::default();
        let revoke = decision(&scope, thread.clone(), Decision::Revoke);
        operations
            .reserve(&scope, "consent_one", &revoke.decision)
            .unwrap();
        f.data.lock().unwrap().record["state"] = json!(state);
        let result = serde_json::to_value(
            perform(
                &client,
                &session,
                &url,
                &scope,
                &Action::Query(&thread),
                &operations,
                || Ok(()),
            )
            .await
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            result["pendingDecisions"].get("consent_one").is_some(),
            retained,
            "{state}"
        );
        assert!(posts(&f).is_empty());
    }
}

#[path = "work_consent_intent_tests.rs"]
mod intents;

#[cfg(feature = "spaces-work-consent-candidate")]
#[path = "work_consent_candidate_tests.rs"]
mod candidate;
