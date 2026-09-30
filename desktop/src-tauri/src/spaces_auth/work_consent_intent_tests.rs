//! Exercise production dispatcher, fixed HTTP adapters and command bodies.
use super::*;
struct Context {
    f: Fixture,
    url: String,
    client: Client,
    session: oauth::Session,
    scope: native_scope::Scope,
    thread: ThreadInput,
    operations: SpacesWorkConsent,
}
impl Context {
    async fn new() -> Self {
        let (f, url, client, session, scope, thread) = fixture().await;
        Self {
            f,
            url,
            client,
            session,
            scope,
            thread,
            operations: SpacesWorkConsent::default(),
        }
    }
    fn read(&self) -> IntentReadInput {
        let mut thread = self.thread.clone();
        thread.expected_scope_token = Some(scope_token(&self.scope));
        IntentReadInput {
            thread,
            intent_id: "intent_one".into(),
            expected_consent_id: None,
        }
    }
    fn select(&self) -> SelectInput {
        SelectInput {
            read: self.read(),
            selection: SelectionInput {
                operation_id: "selection_original".into(),
                expected_version: 1,
                intent_digest: "e".repeat(64),
                account_id: "account_one".into(),
                account_version: 1,
            },
        }
    }
    async fn run(&self, action: Action<'_>) -> Result<Value, Failure> {
        perform(
            &self.client,
            &self.session,
            &self.url,
            &self.scope,
            &action,
            &self.operations,
            || Ok(()),
        )
        .await
        .map(|v| serde_json::to_value(v).unwrap())
    }
    fn selections(&self) -> Vec<Value> {
        self.f
            .data
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, p, _)| p.ends_with("/select"))
            .map(|(_, _, b)| b.clone())
            .collect()
    }
}

#[tokio::test]
async fn intent_adapters_use_exact_origin_owner_routes_without_catalog_or_decision() {
    let t = Context::new().await;
    let query = t.run(Action::IntentQuery(&t.thread)).await.unwrap();
    assert_eq!(query["lookup"]["intents"][0]["id"], "intent_one");
    assert_eq!(
        query["intentDisplays"]["intent_one"]["initiatorLabel"],
        "The requester"
    );
    let owner = t.run(Action::IntentRead(&t.read())).await.unwrap();
    assert_eq!(owner["ownerResult"]["accounts"][0]["accountVersion"], 1);
    let selected = t.run(Action::Select(&t.select())).await.unwrap();
    assert_eq!(selected["state"], "confirmed");
    assert_eq!(selected["consent"]["state"], "pending");
    assert_eq!(selected["consent"]["executionEnabled"], false);
    assert_eq!(
        selected["consent"]["terms"]["task"]["requesterId"],
        "usr_initiator"
    );
    assert!(selected.get("receipt").is_none());
    assert_eq!(
        t.selections(),
        vec![
            json!({"operationId":"selection_original","expectedVersion":1,"intentDigest":"e".repeat(64),"accountId":"account_one","accountVersion":1})
        ]
    );
    let data = t.f.data.lock().unwrap();
    assert!(
        data.requests
            .iter()
            .all(|(_, path, _)| !path.contains("connection-accounts")
                && !path.ends_with("/decisions"))
    );
    let body = &data
        .requests
        .iter()
        .find(|(_, path, _)| path.ends_with("/intents/query"))
        .unwrap()
        .2;
    assert_eq!(body["origin"]["channelId"], t.thread.channel_id);
    assert_eq!(body["origin"]["rootEventId"], t.thread.root_event_id);
    assert_eq!(body["origin"]["orgId"], "org_symmitri");
    assert!(body.get("actorId").is_none());
}

#[tokio::test]
async fn bound_cleanup_survives_exclusion_rotation_and_disconnect_without_reselection() {
    let t = Context::new().await;
    {
        let mut d = t.f.data.lock().unwrap();
        d.intent_bound = true;
        d.record["state"] = json!("revoked");
        d.intent_accounts[0]["accountVersion"] = json!(2);
        d.intent_accounts[0]["label"] = json!("Replacement account");
    }
    assert_eq!(
        t.run(Action::IntentQuery(&t.thread)).await.unwrap()["lookup"]["intents"],
        json!([])
    );
    let value = t.run(Action::IntentRead(&t.read())).await.unwrap();
    assert_eq!(value["ownerResult"]["consent"]["state"], "revoked");
    assert!(value["displays"]["consent_one"]
        .get("accountLabel")
        .is_none());
    let mut replacement = t.select();
    replacement.selection.account_version = 2;
    assert!(matches!(
        t.run(Action::Select(&replacement)).await,
        Err(Failure::Conflict)
    ));
    let mut changed_version = t.select();
    changed_version.selection.expected_version = 2;
    assert!(matches!(
        t.run(Action::Select(&changed_version)).await,
        Err(Failure::Conflict)
    ));
    t.f.data.lock().unwrap().intent_accounts.clear();
    assert_eq!(
        t.run(Action::Select(&t.select())).await.unwrap()["consent"]["state"],
        "revoked"
    );
    assert!(t.selections().is_empty());
}

#[tokio::test]
async fn known_bound_omission_or_substitution_never_reopens_account_selection() {
    for substitute in [false, true] {
        let t = Context::new().await;
        {
            let mut d = t.f.data.lock().unwrap();
            d.intent_bound = true;
            if substitute {
                d.record["id"] = json!("consent_replacement");
            } else {
                d.omit_bound = true;
            }
        }
        let mut read = t.read();
        read.expected_consent_id = Some("consent_one".into());
        assert!(matches!(
            t.run(Action::IntentRead(&read)).await,
            Err(Failure::Conflict)
        ));
        let mut selection = t.select();
        selection.read = read;
        assert!(matches!(
            t.run(Action::Select(&selection)).await,
            Err(Failure::Conflict)
        ));
        assert!(t.selections().is_empty());
    }
}

#[tokio::test]
async fn unknown_selection_is_recovered_even_when_intent_disappears_after_lost_success() {
    let t = Context::new().await;
    t.f.data.lock().unwrap().post_status = 503;
    assert!(matches!(
        t.run(Action::Select(&t.select())).await,
        Err(Failure::Uncertain)
    ));
    t.operations.cancel(&t.thread.client_id).unwrap();
    let query = t.run(Action::IntentQuery(&t.thread)).await.unwrap();
    assert_eq!(query["lookup"]["intents"], json!([]));
    assert_eq!(
        query["pendingSelections"]["intent_one"]["operationId"],
        "selection_original"
    );
    let owner = t.run(Action::IntentRead(&t.read())).await.unwrap();
    assert_eq!(owner["ownerResult"]["consent"]["state"], "pending");
    assert_eq!(owner["pendingSelections"], json!({}));
    assert_eq!(t.selections().len(), 1);
}

#[tokio::test]
async fn absent_binding_keeps_exact_unknown_selection_for_explicit_retry_after_rotation() {
    let t = Context::new().await;
    {
        let mut d = t.f.data.lock().unwrap();
        d.post_status = 503;
        d.commit = false;
    }
    assert!(matches!(
        t.run(Action::Select(&t.select())).await,
        Err(Failure::Uncertain)
    ));
    {
        let mut d = t.f.data.lock().unwrap();
        d.intent_accounts[0]["accountVersion"] = json!(2);
        d.intent["state"] = json!("expired");
        d.intent["version"] = json!(2);
        d.intent_hidden = true;
    }
    let owner = t.run(Action::IntentRead(&t.read())).await.unwrap();
    assert_eq!(
        owner["pendingSelections"]["intent_one"]["accountVersion"],
        1
    );
    let mut contradictory = t.select();
    contradictory.selection.account_version = 2;
    assert!(matches!(
        t.run(Action::Select(&contradictory)).await,
        Err(Failure::Conflict)
    ));
    assert_eq!(t.selections().len(), 1);
    let mut retry = t.select();
    retry.selection.operation_id = "new_candidate".into();
    t.f.data.lock().unwrap().post_status = 409;
    assert!(matches!(
        t.run(Action::Select(&retry)).await,
        Err(Failure::Conflict)
    ));
    assert_eq!(t.selections().len(), 2);
    assert_eq!(t.selections()[0], t.selections()[1]);
    assert_eq!(
        t.run(Action::IntentQuery(&t.thread)).await.unwrap()["pendingSelections"],
        json!({})
    );
}

#[tokio::test]
async fn selection_never_crosses_work_thread_or_auth_generation() {
    let mut t = Context::new().await;
    {
        let mut d = t.f.data.lock().unwrap();
        d.post_status = 503;
        d.commit = false;
    }
    assert!(matches!(
        t.run(Action::Select(&t.select())).await,
        Err(Failure::Uncertain)
    ));
    let mut other = t.thread.clone();
    other.channel_id = "channel_other".into();
    assert_eq!(
        t.run(Action::IntentQuery(&other)).await.unwrap()["pendingSelections"],
        json!({})
    );
    t.f.data.lock().unwrap().intent_work_id = "work_other".into();
    t.f.data.lock().unwrap().intent_hidden = true;
    assert_eq!(
        t.run(Action::IntentQuery(&t.thread)).await.unwrap()["pendingSelections"],
        json!({})
    );
    t.f.data.lock().unwrap().intent_work_id = "work_one".into();
    t.scope.generation += 1;
    assert_eq!(
        t.run(Action::IntentQuery(&t.thread)).await.unwrap()["pendingSelections"],
        json!({})
    );
}

#[tokio::test]
async fn selection_response_must_match_owner_frozen_request_and_exact_account_incarnation() {
    for case in [
        "owner",
        "requester",
        "scope",
        "account",
        "accountVersion",
        "execution",
    ] {
        let t = Context::new().await;
        let mut record = record();
        match case {
            "owner" => record["terms"]["grantorId"] = json!("usr_other"),
            "requester" => record["terms"]["task"]["requesterId"] = json!("usr_owner"),
            "scope" => record["terms"]["scope"]["maxProviderCalls"] = json!(64),
            "account" => record["terms"]["accountId"] = json!("other_account"),
            "accountVersion" => record["terms"]["accountVersion"] = json!(2),
            _ => record["executionEnabled"] = json!(true),
        }
        t.f.data.lock().unwrap().intent_result = Some(record);
        let result = t.run(Action::Select(&t.select())).await;
        assert!(
            matches!(result, Err(Failure::AccessLost)) && case == "owner"
                || matches!(result, Err(Failure::Uncertain)) && case != "owner",
            "{case}"
        );
        assert_eq!(t.selections().len(), 1);
    }
}

#[tokio::test]
async fn owner_projection_validates_every_frozen_shared_term_and_account_limits() {
    for case in [
        "requester",
        "work",
        "application",
        "workload",
        "summary",
        "audience",
        "scope",
        "expiry",
        "unknown",
        "accounts",
        "label",
    ] {
        let t = Context::new().await;
        {
            let mut d = t.f.data.lock().unwrap();
            d.intent_bound = true;
            match case {
                "requester" => d.record["terms"]["task"]["requesterId"] = json!("usr_owner"),
                "work" => d.record["terms"]["task"]["workId"] = json!("other_work"),
                "application" => d.record["terms"]["applicationId"] = json!("other_app"),
                "workload" => d.record["terms"]["workloadIdentityId"] = json!("other_runtime"),
                "summary" => d.record["terms"]["taskSummary"] = json!("Other work"),
                "audience" => d.record["terms"]["audience"]["revision"] = json!("f".repeat(64)),
                "scope" => d.record["terms"]["scope"]["maxProviderCalls"] = json!(64),
                "expiry" => d.record["terms"]["expiresAt"] = json!("2050-09-17T17:00:00Z"),
                "unknown" => d.intent["terms"]["privateCredential"] = json!("must not cross IPC"),
                "accounts" => {
                    let account = d.intent_accounts[0].clone();
                    d.intent_accounts.push(account);
                }
                _ => d.intent_accounts[0]["label"] = json!("bad\nlabel"),
            }
        }
        assert!(
            matches!(
                t.run(Action::IntentRead(&t.read())).await,
                Err(Failure::Invalid)
            ),
            "{case}"
        );
        assert!(t.selections().is_empty());
    }
}

#[tokio::test]
async fn fresh_selection_rejects_changed_incarnation_digest_version_and_expired_intent() {
    for case in [
        "accountVersion",
        "version",
        "digest",
        "expired",
        "noAccount",
    ] {
        let t = Context::new().await;
        let mut selection = t.select();
        match case {
            "accountVersion" => selection.selection.account_version = 2,
            "version" => selection.selection.expected_version = 2,
            "digest" => selection.selection.intent_digest = "f".repeat(64),
            "expired" => t.f.data.lock().unwrap().intent["state"] = json!("expired"),
            _ => t.f.data.lock().unwrap().intent_accounts.clear(),
        }
        assert!(
            matches!(
                t.run(Action::Select(&selection)).await,
                Err(Failure::Conflict)
            ),
            "{case}"
        );
        assert!(t.selections().is_empty());
    }
}

#[tokio::test]
async fn bound_source_recovers_historical_consent_and_unknown_revoke_outside_both_pages() {
    let t = Context::new().await;
    {
        let mut d = t.f.data.lock().unwrap();
        d.intent_bound = true;
        d.intent_accounts.clear();
        d.intent["state"] = json!("stale");
        d.intent["version"] = json!(2);
        d.record["state"] = json!("stale");
        d.request_count = 0;
        d.post_status = 503;
        d.commit = false;
    }
    let mut decision = decision(&t.scope, t.thread.clone(), Decision::Revoke);
    decision.read.source_intent_id = Some("intent_one".into());
    decision.read.source_intent_before = Some(Cursor {
        created_at: "2050-09-17T12:30:00Z".into(),
        id: "intent_newer".into(),
    });
    assert!(matches!(
        t.run(Action::Decide(&decision)).await,
        Err(Failure::Uncertain)
    ));
    let owner = t.run(Action::IntentRead(&t.read())).await.unwrap();
    assert_eq!(
        owner["pendingDecisions"]["consent_one"]["operationId"],
        "operation_one"
    );
    assert!(t
        .f
        .data
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(_, p, b)| p.ends_with("intents/query") && b["before"]["id"] == "intent_newer"));
    {
        let mut d = t.f.data.lock().unwrap();
        d.post_status = 200;
        d.commit = true;
    }
    assert_eq!(
        t.run(Action::Decide(&decision)).await.unwrap()["result"]["consent"]["state"],
        "revoked"
    );
    assert_eq!(posts(&t.f).len(), 2);
    assert_eq!(posts(&t.f)[0], posts(&t.f)[1]);
    assert!(t.selections().is_empty());
}

#[tokio::test]
async fn owner_or_current_signer_loss_discards_intent_data_and_mutation_outcomes() {
    for signer in [false, true] {
        let t = Context::new().await;
        {
            let mut d = t.f.data.lock().unwrap();
            if signer {
                d.lose_signer_after_read = true;
            } else {
                d.change_owner_after_query = true;
            }
        }
        assert!(matches!(
            t.run(Action::IntentRead(&t.read())).await,
            Err(Failure::AccessLost)
        ));
    }
    let t = Context::new().await;
    t.f.data.lock().unwrap().lose_signer_after_read = true;
    assert!(matches!(
        t.run(Action::Select(&t.select())).await,
        Err(Failure::AccessLost)
    ));
}

#[tokio::test]
async fn uncertain_postflight_retains_original_selection_until_verified_owner_read() {
    let t = Context::new().await;
    t.f.data.lock().unwrap().fail_postflight = true;
    assert!(matches!(
        t.run(Action::Select(&t.select())).await,
        Err(Failure::Uncertain)
    ));
    t.f.data.lock().unwrap().fail_postflight = false;
    assert_eq!(
        t.run(Action::IntentQuery(&t.thread)).await.unwrap()["pendingSelections"]["intent_one"]
            ["operationId"],
        "selection_original"
    );
    assert_eq!(
        t.run(Action::IntentRead(&t.read())).await.unwrap()["pendingSelections"],
        json!({})
    );
    assert_eq!(t.selections().len(), 1);
}

#[cfg(not(feature = "spaces-work-consent-candidate"))]
#[tokio::test]
async fn new_tauri_commands_remain_disabled_before_auth_state_or_network_access() {
    let t = Context::new().await;
    let app = tauri::test::mock_builder()
        .manage(SpacesAuth::default())
        .manage(SpacesCommunity::default())
        .manage(crate::app_state::build_app_state())
        .manage(SpacesWorkConsent::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    assert!(matches!(
        intent_commands::spaces_query_work_consent_intents(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            t.thread.clone()
        )
        .await
        .unwrap(),
        CommandResult::Unsupported
    ));
    assert!(matches!(
        intent_commands::spaces_read_work_consent_intent(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            t.read()
        )
        .await
        .unwrap(),
        CommandResult::Unsupported
    ));
    assert!(matches!(
        intent_commands::spaces_select_work_consent_account(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            app.state(),
            t.select()
        )
        .await
        .unwrap(),
        CommandResult::Unsupported
    ));
    assert!(t.f.data.lock().unwrap().requests.is_empty());
}

#[tokio::test]
async fn published_owner_fixture_keeps_replaced_account_separate_from_revoked_binding() {
    let t = Context::new().await;
    let owner: OwnerResult = serde_json::from_str(include_str!(
        "../../../tests/fixtures/work-consent-intent.json"
    ))
    .unwrap();
    let mut scope = t.scope;
    scope.config.org_id = "org_fixture".into();
    intent::validate_owner(&owner, &scope).unwrap();
    assert_eq!(owner.accounts[0].account_version, 2);
    assert!(owner.consent.as_ref().unwrap().state == ConsentState::Revoked);
    let hints = intent::bound_display(&display::Directory::default(), &owner);
    assert!(hints["consent_fixture"].account_label.is_none());
    let mut null_consent = serde_json::to_value(&owner).unwrap();
    null_consent["consent"] = Value::Null;
    assert!(serde_json::from_value::<OwnerResult>(null_consent).is_err());
    let mut null_label = serde_json::to_value(&owner).unwrap();
    null_label["accounts"][0]["label"] = Value::Null;
    assert!(serde_json::from_value::<OwnerResult>(null_label).is_err());
}
