use super::*;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    routing::any,
    Json, Router,
};
use std::sync::{Arc, Mutex};
const FIXTURE: &str = include_str!("../../../tests/fixtures/work-release.json");
#[derive(Clone)]
struct Fixture(Arc<Mutex<Data>>);
struct Data {
    config: Value,
    preview: Value,
    requests: Vec<(String, String, Value)>,
    owner: String,
    lose_owner_after_preview: bool,
    post_status: u16,
    commit: bool,
    substitute_preview: bool,
    empty: bool,
}
async fn serve(
    State(f): State<Fixture>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let mut d = f.0.lock().unwrap();
    assert_eq!(
        headers.get("authorization").unwrap().to_str().unwrap(),
        format!("Bearer sym_{}", "s".repeat(43))
    );
    assert_eq!(headers.get("cache-control").unwrap(), "no-store");
    let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    d.requests
        .push((method.to_string(), uri.path().into(), input.clone()));
    let v = match (method.as_str(), uri.path()) {
        ("GET", "/v1/me") => {
            json!({"identity":{"id":d.owner,"org_id":"org_symmitri","type":"user","email_verified":true}})
        }
        ("GET", "/v1/space/buzz/config") => d.config.clone(),
        ("GET", "/v1/space/work-releases/capabilities") => {
            json!({"enabled":true,"schemaVersion":1,"publicationEnabled":false,"releaseBlocker":"review-required"})
        }
        ("POST", "/v1/space/work-releases/query") => {
            json!({"workId":"work_synthetic","releases":if d.empty{vec![]}else{vec![d.preview["release"].clone()]},"truncated":false})
        }
        ("GET", "/v1/space/work-releases/release_synthetic") => d.preview["release"].clone(),
        ("GET", "/v1/space/work-releases/release_synthetic/preview") => {
            let mut v = d.preview.clone();
            if d.lose_owner_after_preview {
                d.owner = "human_requester".into();
            }
            if d.substitute_preview {
                v["markdown"] = json!("PRIVATE_SUBSTITUTED_SUFFIX");
            }
            v
        }
        ("POST", "/v1/space/work-releases/release_synthetic/decisions") => {
            if d.commit {
                d.preview["release"]["version"] = json!(2);
                d.preview["release"]["state"] = json!(match input["decision"].as_str().unwrap() {
                    "approve" => "approved",
                    "decline" => "declined",
                    _ => "revoked",
                });
            }
            if d.post_status != 200 {
                return (
                    StatusCode::from_u16(d.post_status).unwrap(),
                    Json(json!({"private":"PRIVATE_ERROR_SENTINEL"})),
                );
            }
            json!({"release":d.preview["release"],"receipt":{"receiptId":"receipt_synthetic","operationId":input["operationId"],"actorId":"human_owner","releaseId":"release_synthetic","termsDigest":input["termsDigest"],"payloadDigest":input["payloadDigest"],"version":2,"decision":input["decision"],"decidedAt":"2027-01-15T08:05:00Z"}})
        }
        _ => panic!("unexpected fixed route {method} {uri}"),
    };
    (StatusCode::OK, Json(v))
}
async fn fixture() -> (
    Fixture,
    String,
    Client,
    oauth::Session,
    native_scope::Scope,
    ThreadInput,
) {
    let v: Value = serde_json::from_str(&FIXTURE.replace("org_synthetic", "org_symmitri")).unwrap();
    let origin = &v["expected"]["origin"];
    let keys = nostr::Keys::generate();
    let config = json!({"enabled":true,"org_id":"org_symmitri","identity_id":"human_owner","tenant_id":origin["tenantId"],"relay_url":origin["relayUrl"],"relay_pubkey":origin["relayPubkey"],"environment":"alpha","pubkey":keys.public_key().to_hex()});
    let scope = native_scope::Scope {
        generation: 1,
        cancel: tokio_util::sync::CancellationToken::new(),
        config: serde_json::from_value(config.clone()).unwrap(),
        keys,
    };
    let f = Fixture(Arc::new(Mutex::new(Data {
        config,
        preview: v["preview"].clone(),
        requests: vec![],
        owner: "human_owner".into(),
        lose_owner_after_preview: false,
        post_status: 200,
        commit: true,
        substitute_preview: false,
        empty: false,
    })));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().fallback(any(serve)).with_state(f.clone());
    tokio::spawn(async {
        axum::serve(listener, app).await.unwrap();
    });
    let session=serde_json::from_value(json!({"access_token":format!("sym_{}","s".repeat(43)),"token_type":"Bearer","identity_id":"human_owner","org_id":"org_symmitri","expires_at":"2099-01-01T00:00:00Z"})).unwrap();
    let thread = ThreadInput {
        client_id: "view_synthetic".into(),
        channel_id: origin["channelId"].as_str().unwrap().into(),
        root_event_id: origin["rootEventId"].as_str().unwrap().into(),
        admission_request_id: None,
        expected_scope_token: Some(scope_token(&scope)),
        expected_relay_url: scope.config.relay_url.replacen("https://", "wss://", 1),
        expected_signer_pubkey: scope.keys.public_key().to_hex(),
    };
    (f, url, Client::new(), session, scope, thread)
}
fn decision(record: &Value, choice: &str) -> DecisionInput {
    DecisionInput {
        operation_id: "decision_synthetic".into(),
        expected_version: record["version"].as_u64().unwrap(),
        terms_digest: record["termsDigest"].as_str().unwrap().into(),
        payload_digest: record["terms"]["payloadDigest"].as_str().unwrap().into(),
        decision: choice.into(),
    }
}
#[tokio::test]
async fn preview_requires_current_owner_before_and_after_private_io() {
    let (f, url, client, session, scope, thread) = fixture().await;
    let ops = SpacesWorkRelease::default();
    let input = ReadInput {
        thread: thread.clone(),
        release_id: "release_synthetic".into(),
    };
    f.0.lock().unwrap().lose_owner_after_preview = true;
    let result = perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Preview(&input),
        &ops,
        &|| Ok(()),
    )
    .await;
    assert!(matches!(result, Err(Failure::AccessLost)));
    assert!(ops
        .identity(&scope, &[f.0.lock().unwrap().preview["release"].clone()])
        .unwrap()
        .previews
        .is_empty());
    let requests = &f.0.lock().unwrap().requests;
    assert_eq!(
        requests
            .iter()
            .filter(|(_, p, _)| p.ends_with("/preview"))
            .count(),
        1
    );
    assert!(!format!("{:?}", result.err()).contains("PRIVATE"));
}
#[tokio::test]
async fn initiator_or_different_thread_cannot_fetch_owner_preview() {
    for mutation in ["owner", "root", "candidate_work"] {
        let (f, url, client, session, scope, thread) = fixture().await;
        let ops = SpacesWorkRelease::default();
        {
            let mut d = f.0.lock().unwrap();
            match mutation {
                "owner" => d.preview["release"]["terms"]["ownerId"] = json!("human_requester"),
                "root" => {
                    d.preview["release"]["terms"]["destination"]["rootEventId"] =
                        json!("f".repeat(64))
                }
                _ => {
                    d.preview["release"]["terms"]["candidate"]["task"]["workId"] =
                        json!("work_other")
                }
            }
        }
        let input = ReadInput {
            thread,
            release_id: "release_synthetic".into(),
        };
        assert!(perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Preview(&input),
            &ops,
            &|| Ok(())
        )
        .await
        .is_err());
        assert!(!f
            .0
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(_, p, _)| p.ends_with("/preview")));
    }
}
#[tokio::test]
async fn native_cache_restores_exact_bytes_after_fresh_lookup_and_clears_revoked_or_absent() {
    let (f, url, client, session, scope, thread) = fixture().await;
    let ops = SpacesWorkRelease::default();
    let input = ReadInput {
        thread: thread.clone(),
        release_id: "release_synthetic".into(),
    };
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Preview(&input),
            &ops,
            &|| Ok(())
        )
        .await,
        Ok(CommandResult::Ready {
            preview: Some(_),
            ..
        })
    ));
    ops.cancel(&thread.client_id).unwrap();
    let restored = perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Query(&thread),
        &ops,
        &|| Ok(()),
    )
    .await
    .unwrap();
    match restored {
        CommandResult::Ready { identity, .. } => assert_eq!(
            identity.previews["release_synthetic"]["markdown"],
            f.0.lock().unwrap().preview["markdown"]
        ),
        _ => panic!(),
    };
    f.0.lock().unwrap().preview["release"]["state"] = json!("revoked");
    let result = perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Query(&thread),
        &ops,
        &|| Ok(()),
    )
    .await
    .unwrap();
    match result {
        CommandResult::Ready { identity, .. } => assert!(identity.previews.is_empty()),
        _ => panic!(),
    };
    f.0.lock().unwrap().preview["release"]["state"] = json!("pending");
    let p = f.0.lock().unwrap().preview.clone();
    ops.cache(&scope, &p, ops.revision(&scope).unwrap())
        .unwrap();
    f.0.lock().unwrap().empty = true;
    perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Query(&thread),
        &ops,
        &|| Ok(()),
    )
    .await
    .unwrap();
    assert!(!ops.reviewed(&scope, &p["release"]).unwrap());
}
#[tokio::test]
async fn altered_content_digest_links_or_suffix_never_enter_preview_cache() {
    let (f, url, client, session, scope, thread) = fixture().await;
    let ops = SpacesWorkRelease::default();
    f.0.lock().unwrap().substitute_preview = true;
    let input = ReadInput {
        thread,
        release_id: "release_synthetic".into(),
    };
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Preview(&input),
            &ops,
            &|| Ok(())
        )
        .await,
        Err(Failure::Invalid)
    ));
    let record = f.0.lock().unwrap().preview["release"].clone();
    assert!(!ops.reviewed(&scope, &record).unwrap());
}
#[tokio::test]
async fn uncertain_decision_preserves_exact_body_id_across_remount_and_never_auto_posts() {
    let (f, url, client, session, scope, thread) = fixture().await;
    let ops = SpacesWorkRelease::default();
    {
        let mut d = f.0.lock().unwrap();
        d.post_status = 503;
        d.commit = false;
    }
    let input = DecideInput {
        read: ReadInput {
            thread: thread.clone(),
            release_id: "release_synthetic".into(),
        },
        decision: decision(&f.0.lock().unwrap().preview["release"], "decline"),
    };
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&input),
            &ops,
            &|| Ok(())
        )
        .await,
        Err(Failure::Uncertain)
    ));
    ops.cancel(&thread.client_id).unwrap();
    let restored = perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Query(&thread),
        &ops,
        &|| Ok(()),
    )
    .await
    .unwrap();
    match restored {
        CommandResult::Ready { identity, .. } => assert_eq!(
            identity.pending_decisions["release_synthetic"],
            input.decision
        ),
        _ => panic!(),
    };
    assert_eq!(
        f.0.lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, p, _)| p.ends_with("/decisions"))
            .count(),
        1
    );
    let mut changed = input.decision.clone();
    changed.operation_id = "different_operation".into();
    assert_eq!(
        ops.reserve(&scope, "release_synthetic", &changed),
        Err(Failure::Conflict)
    );
    {
        let mut d = f.0.lock().unwrap();
        d.post_status = 200;
        d.commit = true;
    }
    assert!(matches!(
        perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Decide(&input),
            &ops,
            &|| Ok(())
        )
        .await,
        Ok(CommandResult::Confirmed { .. })
    ));
    let d = f.0.lock().unwrap();
    let posts: Vec<_> = d
        .requests
        .iter()
        .filter(|(_, p, _)| p.ends_with("/decisions"))
        .collect();
    assert_eq!(posts[0].2, posts[1].2);
}
#[tokio::test]
async fn approval_requires_verified_native_preview_and_enabled_current_record() {
    let (f, url, client, session, scope, thread) = fixture().await;
    let ops = SpacesWorkRelease::default();
    let input = DecideInput {
        read: ReadInput {
            thread,
            release_id: "release_synthetic".into(),
        },
        decision: decision(&f.0.lock().unwrap().preview["release"], "approve"),
    };
    assert!(perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Decide(&input),
        &ops,
        &|| Ok(())
    )
    .await
    .is_err());
    f.0.lock().unwrap().preview["release"]["publicationEnabled"] = json!(true);
    assert!(perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Decide(&input),
        &ops,
        &|| Ok(())
    )
    .await
    .is_err());
    assert!(!f
        .0
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(_, p, _)| p.ends_with("/decisions")));
}
#[tokio::test]
async fn exact_shared_payload_digest_and_epoch_invalidation() {
    let (f, _, _, _, mut scope, thread) = fixture().await;
    let ops = SpacesWorkRelease::default();
    let preview = f.0.lock().unwrap().preview.clone();
    assert!(validate_preview(&preview, &preview["release"]).is_ok());
    ops.cache(&scope, &preview, ops.revision(&scope).unwrap())
        .unwrap();
    let (g, cancel) = ops.begin(&thread.client_id, &scope).unwrap();
    assert!(ops.current(&thread.client_id, g).is_ok());
    ops.invalidate().unwrap();
    assert!(cancel.is_cancelled());
    assert!(!ops.reviewed(&scope, &preview["release"]).unwrap());
    scope.generation += 1;
    ops.begin(&thread.client_id, &scope).unwrap();
    assert!(ops
        .identity(&scope, &[preview["release"].clone()])
        .unwrap()
        .previews
        .is_empty());
}
#[tokio::test]
async fn source_gate_keeps_all_native_commands_off_before_identity_or_network() {
    use tauri::Manager;
    let (_, _, _, _, _, thread) = fixture().await;
    let app = tauri::test::mock_builder()
        .manage(SpacesAuth::default())
        .manage(SpacesCommunity::default())
        .manage(crate::app_state::build_app_state())
        .manage(SpacesWorkRelease::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let result = commands::spaces_query_work_releases(
        app.handle().clone(),
        app.state(),
        app.state(),
        app.state(),
        app.state(),
        thread.clone(),
    )
    .await
    .unwrap();
    assert!(matches!(result, CommandResult::Unsupported));
    let input = ReadInput {
        thread: thread.clone(),
        release_id: "release_synthetic".into(),
    };
    assert!(matches!(
        commands::spaces_preview_work_release(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            input
        )
        .await
        .unwrap(),
        CommandResult::Unsupported
    ));
    let input = DecideInput {
        read: ReadInput {
            thread,
            release_id: "release_synthetic".into(),
        },
        decision: DecisionInput {
            operation_id: "disabled".into(),
            expected_version: 1,
            terms_digest: "a".repeat(64),
            payload_digest: "b".repeat(64),
            decision: "approve".into(),
        },
    };
    assert!(matches!(
        commands::spaces_decide_work_release(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            input
        )
        .await
        .unwrap(),
        CommandResult::Unsupported
    ));
}
#[tokio::test]
async fn audience_authentication_downgrade_and_changed_tags_fail_before_private_fetch() {
    for mutation in [
        "http_auth",
        "websocket_auth",
        "realm_membership",
        "mesh",
        "tags",
    ] {
        let (f, url, client, session, scope, thread) = fixture().await;
        let ops = SpacesWorkRelease::default();
        {
            let mut d = f.0.lock().unwrap();
            if mutation == "tags" {
                d.preview["release"]["terms"]["payloadTags"][0][1] = json!("another-channel");
            } else {
                d.preview["release"]["terms"]["publicationMaterial"]["reader_policy"][mutation] =
                    json!(mutation == "mesh");
            }
        }
        let input = ReadInput {
            thread,
            release_id: "release_synthetic".into(),
        };
        assert!(perform(
            &client,
            &session,
            &url,
            &scope,
            &Action::Preview(&input),
            &ops,
            &|| Ok(())
        )
        .await
        .is_err());
        assert!(!f
            .0
            .lock()
            .unwrap()
            .requests
            .iter()
            .any(|(_, p, _)| p.ends_with("/preview")));
    }
}
#[tokio::test]
async fn publication_reconciliation_state_clears_selected_bytes_without_private_authority_claim() {
    let (f, _, _, _, scope, thread) = fixture().await;
    let ops = SpacesWorkRelease::default();
    let preview = f.0.lock().unwrap().preview.clone();
    for state in ["publishing", "unknown", "delivered", "stale", "expired"] {
        ops.cache(&scope, &preview, ops.revision(&scope).unwrap())
            .unwrap();
        let mut record = preview["release"].clone();
        record["state"] = json!(state);
        ops.observe(&scope, &thread, &[record.clone()], false)
            .unwrap();
        assert!(ops.identity(&scope, &[record]).unwrap().previews.is_empty());
        assert!(!ops.reviewed(&scope, &preview["release"]).unwrap());
    }
}
#[tokio::test]
async fn late_preview_completion_cannot_repopulate_globally_invalidated_native_cache() {
    let (f, _, _, _, scope, thread) = fixture().await;
    let ops = SpacesWorkRelease::default();
    let preview = f.0.lock().unwrap().preview.clone();
    let old = ops.revision(&scope).unwrap();
    ops.invalidate().unwrap();
    // A benign new view at the same login generation must not revive the old read.
    ops.begin(&thread.client_id, &scope).unwrap();
    assert_eq!(ops.cache(&scope, &preview, old), Err(Failure::AccessLost));
    assert!(!ops.reviewed(&scope, &preview["release"]).unwrap());
}

#[tokio::test]
async fn hidden_direction_controls_preserve_bytes_but_cannot_authorize_native_sharing() {
    for control in [
        '\u{061c}', '\u{200e}', '\u{200f}', '\u{202a}', '\u{202b}', '\u{202c}', '\u{202d}',
        '\u{202e}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}', '\r', '\0', '\u{0085}',
    ] {
        assert!(!reviewable_text(&format!(
            "https://source.example/{control}private"
        )));
    }
    assert!(reviewable_text(
        "مرحبا שלום\nSource: https://source.synthetic.example\tComplete"
    ));
    let (f, url, client, session, scope, thread) = fixture().await;
    let body = "Source: https://source.synthetic.example/\u{202e}deceptive";
    let preview = {
        let mut d = f.0.lock().unwrap();
        let preview = &mut d.preview;
        preview["markdown"] = json!(body);
        preview["candidate"]["contentDigest"] = json!(hash(body.as_bytes()));
        preview["candidate"]["byteLength"] = json!(body.len());
        preview["release"]["terms"]["candidate"] = preview["candidate"].clone();
        preview["release"]["terms"]["payloadDigest"] =
            json!(payload_digest(&preview["release"], body).unwrap());
        preview["release"]["publicationEnabled"] = json!(true);
        preview.clone()
    };
    let ops = SpacesWorkRelease::default();
    ops.cache(&scope, &preview, ops.revision(&scope).unwrap())
        .unwrap();
    assert_eq!(
        ops.identity(&scope, &[preview["release"].clone()])
            .unwrap()
            .previews["release_synthetic"]["markdown"],
        body
    );
    assert!(!ops.reviewed(&scope, &preview["release"]).unwrap());
    let input = DecideInput {
        read: ReadInput {
            thread,
            release_id: "release_synthetic".into(),
        },
        decision: decision(&preview["release"], "approve"),
    };
    assert!(perform(
        &client,
        &session,
        &url,
        &scope,
        &Action::Decide(&input),
        &ops,
        &|| Ok(())
    )
    .await
    .is_err());
    assert!(!f
        .0
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(_, path, _)| path.ends_with("/decisions")));
}
