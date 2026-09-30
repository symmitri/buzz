//! Enabled command-function lane: isolated HTTP and native session storage only.
//! No replacement for native_scope::current, Gateway validation or the journal.
use super::*;

struct Native {
    f: Fixture,
    app: tauri::App<tauri::test::MockRuntime>,
    scope: native_scope::Scope,
    thread: ThreadInput,
}
impl Native {
    async fn new() -> Self {
        Self::owner("usr_owner").await
    }
    async fn owner(owner: &'static str) -> Self {
        let (f, url, _, mut session, mut scope, thread) = fixture().await;
        session.identity_id = owner.into();
        scope.config.identity_id = owner.into();
        {
            let mut data = f.data.lock().unwrap();
            data.owner = owner;
            data.config["identity_id"] = json!(owner);
            if owner != "usr_owner" {
                data.participant_count = 0;
            }
        }
        let auth = SpacesAuth::default();
        {
            let mut operation = auth.0.lock().unwrap();
            operation.generation = scope.generation;
            operation.cancel = scope.cancel.clone();
            operation.test_host = Some(native_scope::TestHost::new(&session, &url));
        }
        let community = SpacesCommunity::default();
        *community.ready.lock().unwrap() = Some((
            scope.generation,
            super::super::super::community::PreparedCommunity {
                config: scope.config.clone(),
                keys: scope.keys.clone(),
            },
        ));
        let state = crate::app_state::build_app_state();
        *state.keys.lock().unwrap() = scope.keys.clone();
        *state.relay_url_override.lock().unwrap() = Some(scope.config.relay_url.clone());
        let app = tauri::test::mock_builder()
            .manage(auth)
            .manage(community)
            .manage(state)
            .manage(SpacesWorkConsent::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        Self {
            f,
            app,
            scope,
            thread,
        }
    }
    fn intent_read(&self) -> IntentReadInput {
        let mut thread = self.thread.clone();
        thread.expected_scope_token = Some(scope_token(&self.scope));
        IntentReadInput {
            thread,
            intent_id: "intent_one".into(),
            expected_consent_id: None,
        }
    }
    fn selection(&self) -> SelectInput {
        SelectInput {
            read: self.intent_read(),
            selection: SelectionInput {
                operation_id: "selection_original".into(),
                expected_version: 1,
                intent_digest: "e".repeat(64),
                account_id: "account_one".into(),
                account_version: 1,
            },
        }
    }
    async fn context(&self) -> Result<commands::ContextResult, String> {
        let input = serde_json::from_value(json!({"channelId":self.thread.channel_id,
            "rootEventId":self.thread.root_event_id,"expectedSignerPubkey":self.thread.expected_signer_pubkey})).unwrap();
        commands::spaces_work_consent_context(
            self.app.state(),
            self.app.state(),
            self.app.state(),
            input,
        )
        .await
    }
}

// Invoke the functions registered in lib.rs, including their native entry gate.
// A portable Tauri Runtime/macro shell must be disclosed by that test runner.
macro_rules! call {
    ($native:expr, $command:path, $input:expr) => {{
        let n = &$native;
        $command(
            n.app.handle().clone(),
            n.app.state(),
            n.app.state(),
            n.app.state(),
            n.app.state(),
            $input,
        )
        .await
        .map(|value| serde_json::to_value(value).unwrap())
    }};
}

#[tokio::test]
async fn candidate_command_build_identity_is_enforced() {
    let n = Native::new().await;
    if crate::build_identity::demo_slug() == Some("spaces-alpha") {
        assert!(matches!(
            n.context().await.unwrap(),
            commands::ContextResult::Ready { .. }
        ));
        return;
    }
    let expected = "Company sign-in is available only in Spaces Alpha.";
    assert!(matches!(n.context().await, Err(message) if message == expected));
    for result in [
        call!(
            n,
            intent_commands::spaces_query_work_consent_intents,
            n.thread.clone()
        ),
        call!(
            n,
            intent_commands::spaces_read_work_consent_intent,
            n.intent_read()
        ),
        call!(
            n,
            intent_commands::spaces_select_work_consent_account,
            n.selection()
        ),
        call!(n, commands::spaces_query_work_consents, n.thread.clone()),
        call!(
            n,
            commands::spaces_read_work_consent,
            read_input(&n.scope, n.thread.clone())
        ),
        call!(
            n,
            commands::spaces_decide_work_consent,
            decision(&n.scope, n.thread.clone(), Decision::Approve)
        ),
        call!(
            n,
            task_status::spaces_query_work_consent_task_status,
            n.thread.clone()
        ),
    ] {
        assert!(matches!(result, Err(message) if message == expected));
    }
    assert!(n.f.data.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn candidate_commands_select_pending_then_deliberate_allow_revoke_and_decline() {
    crate::build_identity::require_spaces_alpha().unwrap();
    for first in [Decision::Approve, Decision::Decline] {
        let n = Native::new().await;
        assert!(matches!(
            n.context().await.unwrap(),
            commands::ContextResult::Ready { .. }
        ));
        let intents = call!(
            n,
            intent_commands::spaces_query_work_consent_intents,
            n.thread.clone()
        )
        .unwrap();
        assert_eq!(intents["lookup"]["intents"][0]["id"], "intent_one");
        let intent = call!(
            n,
            intent_commands::spaces_read_work_consent_intent,
            n.intent_read()
        )
        .unwrap();
        assert_eq!(intent["ownerResult"]["accounts"][0]["accountVersion"], 1);
        let selected = call!(
            n,
            intent_commands::spaces_select_work_consent_account,
            n.selection()
        )
        .unwrap();
        assert_eq!(selected["state"], "confirmed");
        assert_eq!(selected["consent"]["state"], "pending");
        assert_eq!(selected["consent"]["executionEnabled"], false);
        assert_eq!(selected["consent"]["terms"]["grantorId"], "usr_owner");
        assert_eq!(
            selected["consent"]["terms"]["task"]["requesterId"],
            "usr_initiator"
        );
        assert!(selected.get("receipt").is_none());
        assert!(posts(&n.f).is_empty());
        let query = call!(n, commands::spaces_query_work_consents, n.thread.clone()).unwrap();
        assert_eq!(query["lookup"]["requests"][0]["state"], "pending");
        assert!(!query.to_string().contains("PRIVATE OTHER ACCOUNT"));
        let review = call!(
            n,
            commands::spaces_read_work_consent,
            read_input(&n.scope, n.thread.clone())
        )
        .unwrap();
        assert_eq!(review["consent"]["termsDigest"], "c".repeat(64));
        let pending = call!(
            n,
            task_status::spaces_query_work_consent_task_status,
            n.thread.clone()
        )
        .unwrap();
        assert_eq!(pending["lookup"]["statuses"][0]["state"], "pending");
        let result = call!(
            n,
            commands::spaces_decide_work_consent,
            decision(&n.scope, n.thread.clone(), first.clone())
        )
        .unwrap();
        let expected = if first == Decision::Approve {
            "approved"
        } else {
            "declined"
        };
        assert_eq!(result["state"], "confirmed");
        assert_eq!(result["result"]["consent"]["state"], expected);
        assert_eq!(result["result"]["receipt"]["actorId"], "usr_owner");
        let status = call!(
            n,
            task_status::spaces_query_work_consent_task_status,
            n.thread.clone()
        )
        .unwrap();
        assert_eq!(
            status["lookup"]["statuses"][0]["state"],
            if first == Decision::Approve {
                "queued"
            } else {
                "declined"
            }
        );
        if first == Decision::Approve {
            let mut revoke = decision(&n.scope, n.thread.clone(), Decision::Revoke);
            revoke.decision.operation_id = "operation_revoke".into();
            revoke.decision.expected_version = 2;
            let revoked = call!(n, commands::spaces_decide_work_consent, revoke).unwrap();
            assert_eq!(revoked["result"]["consent"]["state"], "revoked");
            assert_eq!(revoked["result"]["consent"]["version"], 3);
            let status = call!(
                n,
                task_status::spaces_query_work_consent_task_status,
                n.thread.clone()
            )
            .unwrap();
            assert_eq!(status["lookup"]["statuses"][0]["state"], "revoked");
        }
        assert!(n
            .f
            .data
            .lock()
            .unwrap()
            .requests
            .iter()
            .all(|(_, path, _)| path == "/v1/me"
                || path == "/v1/space/buzz/config"
                || path == "/v1/connection-accounts"
                || path.starts_with("/v1/space/work-consents/")));
    }
}

#[tokio::test]
async fn candidate_commands_recheck_current_owner_native_generation_and_signer() {
    crate::build_identity::require_spaces_alpha().unwrap();
    for (change, selection) in ["owner", "generation", "signer", "relay"]
        .into_iter()
        .flat_map(|change| [(change, false), (change, true)])
    {
        let n = Native::new().await;
        assert!(matches!(
            n.context().await.unwrap(),
            commands::ContextResult::Ready { .. }
        ));
        match change {
            "owner" => n.f.data.lock().unwrap().change_owner_after_query = true,
            "generation" => {
                n.f.data.lock().unwrap().revoke_auth_after_query =
                    Some(n.app.state::<SpacesAuth>().0.clone())
            }
            "signer" => *n.app.state::<AppState>().keys.lock().unwrap() = Keys::generate(),
            _ => {
                *n.app.state::<AppState>().relay_url_override.lock().unwrap() =
                    Some("https://other.example.test".into())
            }
        }
        let result = if selection {
            call!(
                n,
                intent_commands::spaces_select_work_consent_account,
                n.selection()
            )
        } else {
            call!(
                n,
                commands::spaces_decide_work_consent,
                decision(&n.scope, n.thread.clone(), Decision::Approve)
            )
        }
        .unwrap();
        assert_eq!(result["state"], "access_lost", "{change}");
        assert!(!result.to_string().contains("consent_one"));
        assert!(!result.to_string().contains("My meetings"));
        assert!(posts(&n.f).is_empty(), "{change}");
        assert!(
            n.f.data
                .lock()
                .unwrap()
                .requests
                .iter()
                .all(|(_, path, _)| !path.ends_with("/select")),
            "{change}"
        );
    }
}

#[tokio::test]
async fn candidate_commands_reject_account_incarnation_and_cross_consent_mutation() {
    crate::build_identity::require_spaces_alpha().unwrap();
    let n = Native::new().await;
    let mut replaced = n.selection();
    replaced.selection.account_version = 2;
    assert_eq!(
        call!(
            n,
            intent_commands::spaces_select_work_consent_account,
            replaced
        )
        .unwrap()["state"],
        "conflict"
    );
    let mut foreign = decision(&n.scope, n.thread.clone(), Decision::Approve);
    foreign.read.consent_id = "consent_other".into();
    assert_eq!(
        call!(n, commands::spaces_decide_work_consent, foreign).unwrap()["state"],
        "access_lost"
    );
    assert!(n
        .f
        .data
        .lock()
        .unwrap()
        .requests
        .iter()
        .all(|(_, p, _)| !p.ends_with("/select") && !p.ends_with("/decisions")));
    for owner in ["usr_initiator", "usr_other"] {
        let other = Native::owner(owner).await;
        let query = call!(
            other,
            commands::spaces_query_work_consents,
            other.thread.clone()
        )
        .unwrap();
        assert_eq!(query["state"], "access_lost");
        let status = call!(
            other,
            task_status::spaces_query_work_consent_task_status,
            other.thread.clone()
        )
        .unwrap();
        assert_eq!(status["state"], "access_lost");
        let result = call!(
            other,
            commands::spaces_decide_work_consent,
            decision(&other.scope, other.thread.clone(), Decision::Approve)
        )
        .unwrap();
        assert_eq!(result["state"], "access_lost");
        assert!(!result.to_string().contains("consent_one"));
        assert!(posts(&other.f).is_empty());
    }
}

#[tokio::test]
async fn candidate_commands_keep_server_gate_and_exact_unknown_write_reconciliation() {
    crate::build_identity::require_spaces_alpha().unwrap();
    let n = Native::new().await;
    n.f.data.lock().unwrap().enabled = false;
    assert!(matches!(
        n.context().await.unwrap(),
        commands::ContextResult::Unsupported
    ));
    assert_eq!(
        call!(
            n,
            intent_commands::spaces_select_work_consent_account,
            n.selection()
        )
        .unwrap()["state"],
        "unsupported"
    );
    assert!(posts(&n.f).is_empty());
    n.f.data.lock().unwrap().enabled = true;
    n.f.data.lock().unwrap().post_status = 503;
    let uncertain = call!(
        n,
        commands::spaces_decide_work_consent,
        decision(&n.scope, n.thread.clone(), Decision::Approve)
    )
    .unwrap();
    assert_eq!(uncertain["state"], "uncertain");
    n.f.data.lock().unwrap().post_status = 200;
    let confirmed = call!(
        n,
        commands::spaces_decide_work_consent,
        decision(&n.scope, n.thread.clone(), Decision::Approve)
    )
    .unwrap();
    assert_eq!(confirmed["state"], "confirmed");
    let sent = posts(&n.f);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0], sent[1]);
    assert_eq!(sent[0]["operationId"], "operation_one");
}
