use super::*;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Uri},
    routing::any,
    Json, Router,
};
use nostr::{EventBuilder, Tag};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

const CHANNEL: &str = "11111111-1111-4111-8111-111111111111";
#[derive(Clone)]
struct Fixture {
    data: Arc<Mutex<Data>>,
    relay: Keys,
    human: Keys,
    agent: Keys,
}
struct Data {
    native: Value,
    registry: Value,
    grants: Value,
    admin: bool,
    joined: bool,
    kind: &'static str,
    publish_commits: bool,
    put_commits: bool,
    ambiguous: bool,
    unknown_member: bool,
    extra_members: Vec<String>,
    conflict: bool,
    delay_writes: bool,
    human_joined: bool,
    foreign_snapshot: bool,
    tamper_snapshot: bool,
    after_query: Option<fn(&mut Data)>,
    metadata_mutation: Option<fn(&mut Vec<Tag>)>,
    requests: Vec<(String, String, Value)>,
}
async fn serve(
    State(f): State<Fixture>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let write = method == Method::PUT || uri.path() == "/events";
    let delay = f.data.lock().unwrap().delay_writes;
    let result = serve_now(f, method, uri, headers, body);
    if write && delay {
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    result
}
fn serve_now(
    f: Fixture,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> (StatusCode, Json<Value>) {
    let input: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let mut d = f.data.lock().unwrap();
    d.requests
        .push((method.to_string(), uri.path().into(), input.clone()));
    if uri.path().starts_with("/v1/")
        && headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer synthetic")
    {
        return (StatusCode::UNAUTHORIZED, Json(json!({})));
    }
    let value = match (method.as_str(), uri.path()) {
        ("GET", "/v1/agents") => d.registry.clone(),
        ("GET", "/v1/space/buzz/config") => d.native.clone(),
        ("GET", "/v1/admin/workspace") => {
            json!({"schema_version":1,"principal":{"id":"usr_test"},"company":{"id":"org_symmitri"},"permissions":{"manage_gateway":d.admin}})
        }
        ("GET", "/v1/agents/agent_company/grants") => {
            if !d.admin {
                return (StatusCode::FORBIDDEN, Json(json!({})));
            }
            d.grants.clone()
        }
        ("POST", "/query") => {
            assert!(headers
                .get("authorization")
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("Nostr "));
            let channel = if d.foreign_snapshot {
                "22222222-2222-4222-8222-222222222222"
            } else {
                CHANNEL
            };
            let mut tags = vec![Tag::parse(["d", channel]).unwrap()];
            if d.human_joined {
                tags.push(Tag::parse(["p", &f.human.public_key().to_hex(), "", "owner"]).unwrap());
            }
            for key in &d.extra_members {
                tags.push(Tag::parse(["p", key, "", "member"]).unwrap());
            }
            if d.unknown_member {
                tags.push(
                    Tag::parse(["p", &Keys::generate().public_key().to_hex(), "", "member"])
                        .unwrap(),
                );
            }
            if d.joined {
                tags.push(Tag::parse(["p", &f.agent.public_key().to_hex(), "", "member"]).unwrap());
            }
            let mut metadata_tags = vec![Tag::parse(["d", channel]).unwrap(), Tag::parse(["t", d.kind]).unwrap(), Tag::parse(["name", "Customers"]).unwrap()];
            if d.kind == "dm" {
                metadata_tags.push(Tag::parse(["private"]).unwrap());
                for tag in tags.iter().filter(|tag| tag.as_slice()[0] == "p") {
                    metadata_tags.push(Tag::parse(["p", &tag.as_slice()[1]]).unwrap());
                }
            }
            if let Some(change) = d.metadata_mutation { change(&mut metadata_tags); }
            let metadata = EventBuilder::new(Kind::Custom(39000), "").tags(metadata_tags).sign_with_keys(&f.relay).unwrap();
            let membership = EventBuilder::new(Kind::Custom(39002), "")
                .tags(tags)
                .sign_with_keys(&f.relay)
                .unwrap();
            let mut result = json!([metadata, membership]);
            if d.tamper_snapshot {
                result[0]["content"] = json!("forged");
            }
            if let Some(change) = d.after_query.take() {
                change(&mut d);
            }
            result
        }
        ("POST", "/events") => {
            let event: Event = serde_json::from_value(input).unwrap();
            assert!(event.verify().is_ok());
            assert_eq!(event.kind, Kind::Custom(9000));
            assert_eq!(event.pubkey, f.human.public_key());
            assert_eq!(single(&event, "role").unwrap().as_deref(), Some("bot"));
            assert_eq!(single(&event, "h").unwrap().as_deref(), Some(CHANNEL));
            assert_eq!(
                single(&event, "p").unwrap(),
                Some(f.agent.public_key().to_hex())
            );
            if d.publish_commits {
                d.joined = true;
            }
            if d.ambiguous {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"private provider details"})),
                );
            }
            json!({"accepted":d.publish_commits})
        }
        ("PUT", "/v1/agents/agent_company/grants") => {
            assert!(d.admin);
            assert_eq!(input["expected_version"], d.grants["version"]);
            if d.conflict {
                d.grants["version"] = json!(8);
                return (
                    StatusCode::CONFLICT,
                    Json(json!({"error":"agent_grants_changed"})),
                );
            }
            if d.put_commits {
                d.grants["version"] = json!(d.grants["version"].as_i64().unwrap() + 1);
                d.grants["connections"] = input["connections"].clone();
                d.grants["skills"] = Value::Array(
                    input["skill_release_ids"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|r| json!({"release_id":r}))
                        .collect(),
                );
                d.grants["audiences"] = input["audiences"].clone();
            }
            if d.ambiguous {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"error":"private provider details"})),
                );
            }
            d.grants.clone()
        }
        _ => return (StatusCode::NOT_FOUND, Json(json!({}))),
    };
    (StatusCode::OK, Json(value))
}

async fn fixture() -> (
    Fixture,
    oauth::Session,
    Configuration,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let relay = Keys::generate();
    let human = Keys::generate();
    let agent = Keys::generate();
    let native = json!({"enabled":true,"environment":"alpha","org_id":"org_symmitri","identity_id":"usr_test","tenant_id":"synthetic_alpha", "relay_url":url,"relay_pubkey":relay.public_key().to_hex(),"pubkey":human.public_key().to_hex(), "people":[{"pubkey":human.public_key().to_hex()}],"company_agent_ids":["agent_company"],"agents":[{"agent_id":"agent_company","identity_id":"idn_company","owner_id":"usr_other","pubkey":agent.public_key().to_hex()}]});
    let registry = json!({"agents":[{"id":"agent_company","identity_id":"idn_company","org_id":"org_symmitri","name":"Symi","description":"Shared company agent","directory_visibility":"organisation","owner_identity_id":"usr_other","status":"active"}]});
    let grants = json!({"agent_id":"agent_company","org_id":"org_symmitri","workload_id":"app_company","version":7,
        "connections":[{"connection_id":"conn_company"},{"connection_id":"conn_agent","credential_identity_id":"idn_company"}],
        "skills":[{"release_id":"release_one"}],
        "audiences":[{"provider":"slack","tenant_id":"T1","channel_id":"C1","display_name":"Original immutable label","visibility":"shared"}],
        "audience_options":[{"provider":"buzz","tenant_id":"synthetic_alpha","visibility":"shared"}]});
    let session = serde_json::from_value(json!({"access_token":"synthetic","token_type":"Bearer","expires_at":"2099-01-01T00:00:00Z","identity_id":"usr_test","org_id":"org_symmitri"})).unwrap();
    let config = serde_json::from_value(native.clone()).unwrap();
    let f = Fixture {
        data: Arc::new(Mutex::new(Data {
            native,
            registry,
            grants,
            admin: true,
            joined: false,
            kind: "stream",
            publish_commits: true,
            put_commits: true,
            ambiguous: false,
            unknown_member: false,
            extra_members: Vec::new(),
            conflict: false,
            delay_writes: false,
            human_joined: true,
            foreign_snapshot: false,
            tamper_snapshot: false,
            after_query: None,
            metadata_mutation: None,
            requests: vec![],
        })),
        relay,
        human,
        agent,
    };
    let app = Router::new().fallback(any(serve)).with_state(f.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (f, session, config, server)
}
fn writes(f: &Fixture) -> Vec<(String, String, Value)> {
    f.data
        .lock()
        .unwrap()
        .requests
        .iter()
        .filter(|(m, p, _)| m == "PUT" || p == "/events")
        .cloned()
        .collect()
}
async fn attach(
    f: &Fixture,
    session: &oauth::Session,
    config: &Configuration,
) -> Result<AddResult, String> {
    add(
        &oauth::client().unwrap(),
        session,
        &config.relay_url,
        config,
        &f.human,
        CHANNEL,
        "agent_company",
        &f.agent.public_key().to_hex(),
        || Ok(()),
    )
    .await
}

#[tokio::test]
async fn canonical_company_attach_preserves_every_existing_grant_and_confirms_native_membership() {
    let (f, s, c, server) = fixture().await;
    let before = f.data.lock().unwrap().grants.clone();
    let result = attach(&f, &s, &c).await.unwrap();
    assert_eq!(result.state, "confirmed");
    let writes = writes(&f);
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0].1, "/events");
    let put = &writes[1].2;
    assert_eq!(put["connections"], before["connections"]);
    assert_eq!(put["skill_release_ids"], json!(["release_one"]));
    assert_eq!(put["audiences"][0], before["audiences"][0]);
    assert_eq!(
        put["audiences"][1],
        json!({"provider":"buzz","tenant_id":"synthetic_alpha","channel_id":CHANNEL,"display_name":"Customers","visibility":"shared"})
    );
    let view = list(
        &oauth::client().unwrap(),
        &s,
        &c.relay_url,
        &c,
        &f.human,
        CHANNEL,
    )
    .await
    .unwrap();
    assert!(view.agents[0].ready);
    assert!(!view.agents[0].can_add);
    let output = serde_json::to_string(&view).unwrap();
    assert!(!output.contains("access_token") && !output.contains("credential_identity_id"));
    server.abort();
}

#[tokio::test]
async fn existing_member_can_enable_replies_without_republishing_membership() {
    let (f, s, c, server) = fixture().await;
    f.data.lock().unwrap().joined = true;
    let view = list(
        &oauth::client().unwrap(),
        &s,
        &c.relay_url,
        &c,
        &f.human,
        CHANNEL,
    )
    .await
    .unwrap();
    assert!(view.agents[0].in_channel && view.agents[0].can_add && !view.agents[0].ready);
    assert_eq!(attach(&f, &s, &c).await.unwrap().state, "confirmed");
    assert_eq!(writes(&f).len(), 1);
    assert_eq!(writes(&f)[0].0, "PUT");
    server.abort();
}

#[tokio::test]
async fn unconfirmed_writes_are_read_back_and_never_repeated() {
    for (publish, put, confirmed, count) in [
        (true, true, true, 2),
        (false, true, false, 1),
        (true, false, false, 2),
    ] {
        let (f, s, c, server) = fixture().await;
        {
            let mut d = f.data.lock().unwrap();
            d.ambiguous = true;
            d.publish_commits = publish;
            d.put_commits = put;
        }
        let result = attach(&f, &s, &c).await.unwrap();
        assert_eq!(result.state == "confirmed", confirmed);
        assert_eq!(writes(&f).len(), count);
        server.abort();
    }
}

#[tokio::test]
async fn nonadmin_private_agent_rebound_key_conflicting_audience_and_nonchannel_never_write() {
    for case in 0..9 {
        let (f, s, c, server) = fixture().await;
        {
            let mut d = f.data.lock().unwrap();
            match case {
            0=>d.admin=false,
            1=>{d.registry["agents"][0]["directory_visibility"]=json!("private");d.registry["agents"][0]["owner_identity_id"]=json!("usr_test");d.registry["agents"][0]["paired_identity_id"]=json!("usr_test");},
            2=>d.native["agents"][0]["pubkey"]=json!(Keys::generate().public_key().to_hex()),
            3=>d.grants["audiences"].as_array_mut().unwrap().push(json!({"provider":"buzz","tenant_id":"synthetic_alpha","channel_id":CHANNEL,"display_name":"Private","visibility":"private","identity_id":"usr_test"})),
            4=>d.kind="dm",
            5=>d.grants["audience_options"]=json!([]),
            6=>d.kind="forum",
            7=>d.unknown_member=true,
            _=>{ d.grants["audience_options"]=json!([]); d.grants["audiences"].as_array_mut().unwrap().push(json!({"provider":"buzz","tenant_id":"synthetic_alpha","channel_id":CHANNEL,"display_name":"Existing","visibility":"shared"})); },
        }
        }
        assert!(attach(&f, &s, &c).await.is_err(), "case {case}");
        assert!(writes(&f).is_empty(), "case {case}");
        server.abort();
    }
}

#[tokio::test]
async fn stale_native_generation_stops_before_any_external_mutation() {
    let (f, s, c, server) = fixture().await;
    let checks = AtomicUsize::new(0);
    let result = add(
        &oauth::client().unwrap(),
        &s,
        &c.relay_url,
        &c,
        &f.human,
        CHANNEL,
        "agent_company",
        &f.agent.public_key().to_hex(),
        || {
            if checks.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(CANCELLED.into())
            }
        },
    )
    .await;
    assert!(result.is_err());
    assert!(writes(&f).is_empty());
    server.abort();
}

#[tokio::test]
async fn cas_conflict_does_not_retry_or_revoke_the_native_member() {
    let (f, s, c, server) = fixture().await;
    f.data.lock().unwrap().conflict = true;
    assert_eq!(attach(&f, &s, &c).await.unwrap().state, "not_confirmed");
    assert_eq!(writes(&f).len(), 2);
    assert!(f.data.lock().unwrap().joined);
    server.abort();
}

#[tokio::test]
async fn lost_native_and_gateway_write_responses_are_confirmed_only_by_readback() {
    let (f, s, c, server) = fixture().await;
    f.data.lock().unwrap().delay_writes = true;
    let client = Client::builder()
        .timeout(Duration::from_millis(100))
        .build()
        .unwrap();
    let result = add(
        &client,
        &s,
        &c.relay_url,
        &c,
        &f.human,
        CHANNEL,
        "agent_company",
        &f.agent.public_key().to_hex(),
        || Ok(()),
    )
    .await
    .unwrap();
    assert_eq!(result.state, "confirmed");
    assert_eq!(writes(&f).len(), 2);
    server.abort();
}

#[tokio::test]
async fn full_gateway_audience_cannot_be_expanded_beyond_supported_membership() {
    let (f, s, c, server) = fixture().await;
    {
        let mut d = f.data.lock().unwrap();
        d.extra_members = (0..127)
            .map(|_| Keys::generate().public_key().to_hex())
            .collect();
        let people = d
            .extra_members
            .iter()
            .map(|key| json!({"pubkey":key}))
            .collect::<Vec<_>>();
        d.native["people"].as_array_mut().unwrap().extend(people);
    }
    let view = list(
        &oauth::client().unwrap(),
        &s,
        &c.relay_url,
        &c,
        &f.human,
        CHANNEL,
    )
    .await
    .unwrap();
    assert!(!view.agents[0].can_add);
    assert!(attach(&f, &s, &c).await.is_err());
    assert!(writes(&f).is_empty());
    server.abort();
}

async fn mention_view(
    f: &Fixture,
    s: &oauth::Session,
    c: &Configuration,
    selected: Option<&HashSet<String>>,
) -> Result<Value, String> {
    super::super::company_mentions::project(
        &oauth::client().unwrap(),
        s,
        &c.relay_url,
        c,
        &f.human,
        CHANNEL,
        selected,
        || Ok(()),
    )
    .await
    .map(|view| serde_json::to_value(view).unwrap())
}

#[tokio::test]
async fn company_mentions_use_current_membership_without_admin_or_legacy_owner_policy() {
    let (f, s, c, server) = fixture().await;
    f.data.lock().unwrap().admin = false;
    let empty = mention_view(&f, &s, &c, None).await.unwrap();
    assert_eq!(
        empty["agents"],
        json!([]),
        "a human-only stream has no eligible agent yet"
    );
    f.data.lock().unwrap().joined = true;
    let view = mention_view(&f, &s, &c, None).await.unwrap();
    assert_eq!(view["channel_id"], CHANNEL);
    assert_eq!(view["human_pubkey"], f.human.public_key().to_hex());
    assert_eq!(view["relay_url"], c.relay_url);
    assert_eq!(view["agents"][0]["company_agent_id"], "agent_company");
    assert_eq!(view["agents"][0]["pubkey"], f.agent.public_key().to_hex());
    assert_eq!(view["agents"][0]["status"], "unknown");
    assert_eq!(view["agents"][0]["owner_pubkey"], Value::Null);
    assert_eq!(view["agents"][0]["respond_to"], Value::Null);
    assert_eq!(view["agents"][0]["channel_ids"], json!([CHANNEL]));
    let keys = HashSet::from([f.agent.public_key().to_hex()]);
    assert_eq!(mention_view(&f, &s, &c, Some(&keys)).await.unwrap(), view);
    let d = f.data.lock().unwrap();
    assert!(d.requests.iter().all(|(method, path, body)| method == "GET"
        && matches!(path.as_str(), "/v1/agents" | "/v1/space/buzz/config")
        || method == "POST"
            && path == "/query"
            && body
                .as_array()
                .unwrap()
                .iter()
                .all(|filter| filter["#d"] == json!([CHANNEL]))));
    assert!(!view.to_string().contains("synthetic") && !view.to_string().contains("access_token"));
    server.abort();
}

#[tokio::test]
async fn selected_company_mentions_fail_closed_on_removal_revocation_rebinding_or_private_visibility(
) {
    for case in 0..7 {
        let (f, s, c, server) = fixture().await;
        let keys = HashSet::from([f.agent.public_key().to_hex()]);
        f.data.lock().unwrap().joined = true;
        assert!(mention_view(&f, &s, &c, Some(&keys)).await.is_ok());
        {
            let mut d = f.data.lock().unwrap();
            match case {
                0 => d.joined = false,
                1 => d.native["company_agent_ids"] = json!([]),
                2 => {
                    d.native["agents"][0]["pubkey"] = json!(Keys::generate().public_key().to_hex())
                }
                3 => d.registry["agents"][0]["directory_visibility"] = json!("private"),
                4 => d.registry["agents"][0]["status"] = json!("disabled"),
                5 => d.registry["agents"][0]["org_id"] = json!("another_org"),
                _ => d.native["enabled"] = json!(false),
            }
        }
        assert!(
            mention_view(&f, &s, &c, Some(&keys)).await.is_err(),
            "case {case}"
        );
        assert!(writes(&f).is_empty());
        server.abort();
    }
}

#[tokio::test]
async fn owned_dm_mentions_use_exact_canonical_members_without_enabling_channel_attachment() {
    let (f, s, c, server) = fixture().await;
    {
        let mut d = f.data.lock().unwrap();
        d.kind = "dm";
        d.joined = true;
        d.native["company_agent_ids"] = json!([]);
        d.native["private_owner_dms"] = json!(true);
        d.native["owned_conversations"] = json!(true);
        d.native["agents"][0]["owner_id"] = json!(s.identity_id);
        d.registry["agents"][0]["directory_visibility"] = json!("private");
        d.registry["agents"][0]["owner_identity_id"] = json!(s.identity_id);
        d.registry["agents"][0]["paired_identity_id"] = json!(s.identity_id);
    }
    let keys = HashSet::from([f.agent.public_key().to_hex()]);
    let view = mention_view(&f, &s, &c, Some(&keys)).await.unwrap();
    assert_eq!(view["agents"][0]["pubkey"], f.agent.public_key().to_hex());
    assert!(attach(&f, &s, &c).await.is_err(), "mention discovery cannot enable the stream attachment path for a DM");
    f.data.lock().unwrap().joined = false;
    assert!(mention_view(&f, &s, &c, Some(&keys)).await.is_err());
    f.data.lock().unwrap().joined = true;
    f.data.lock().unwrap().registry["agents"][0]["paired_identity_id"] = json!("another_owner");
    assert!(mention_view(&f, &s, &c, Some(&keys)).await.is_err());
    assert!(writes(&f).is_empty());
    server.abort();
}

#[tokio::test]
async fn dm_mentions_reject_inconsistent_signed_participants_and_mid_read_type_change() {
    for case in 0..7 {
        let (f, s, c, server) = fixture().await;
        {
            let mut d=f.data.lock().unwrap(); d.kind="dm"; d.joined=true;
            match case {
                0 => d.metadata_mutation=Some(|tags| tags.retain(|tag| tag.as_slice()[0]!="private")),
                1 => d.metadata_mutation=Some(|tags| {tags.push(Tag::parse(["private","true"]).unwrap());}),
                2 => d.metadata_mutation=Some(|tags| {tags.push(tags.iter().find(|tag|tag.as_slice()[0]=="p").unwrap().clone());}),
                3 => d.metadata_mutation=Some(|tags| {tags.retain(|tag|tag.as_slice()[0]!="p");}),
                4 => d.metadata_mutation=Some(|tags| {tags.push(Tag::parse(["p", &Keys::generate().public_key().to_hex()]).unwrap());}),
                5 => { for _ in 0..8 {let key=Keys::generate().public_key().to_hex();d.extra_members.push(key.clone());d.native["people"].as_array_mut().unwrap().push(json!({"pubkey":key}));} },
                _ => d.after_query=Some(|data|data.kind="stream"),
            }
        }
        assert!(mention_view(&f,&s,&c,None).await.is_err(),"case {case}");
        assert!(writes(&f).is_empty());server.abort();
    }
}

#[tokio::test]
async fn company_mentions_reject_foreign_forged_unsupported_and_unknown_audiences() {
    for case in 0..5 {
        let (f, s, c, server) = fixture().await;
        {
            let mut d = f.data.lock().unwrap();
            d.joined = true;
            match case {
                0 => d.foreign_snapshot = true,
                1 => d.tamper_snapshot = true,
                2 => d.kind = "forum",
                3 => d.human_joined = false,
                _ => d.unknown_member = true,
            }
        }
        assert!(mention_view(&f, &s, &c, None).await.is_err(), "case {case}");
        assert!(writes(&f).is_empty());
        server.abort();
    }
}

#[tokio::test]
async fn company_mention_revalidation_requires_every_selected_key_in_the_exact_destination() {
    let (f, s, c, server) = fixture().await;
    f.data.lock().unwrap().joined = true;
    let selected = HashSet::from([
        f.agent.public_key().to_hex(),
        Keys::generate().public_key().to_hex(),
    ]);
    assert!(
        mention_view(&f, &s, &c, Some(&selected)).await.is_err(),
        "missing recipients cannot silently disappear"
    );
    let foreign = "22222222-2222-4222-8222-222222222222";
    let value = super::super::company_mentions::project(
        &oauth::client().unwrap(),
        &s,
        &c.relay_url,
        &c,
        &f.human,
        foreign,
        None,
        || Ok(()),
    )
    .await;
    assert!(
        value.is_err(),
        "signed membership in another destination does not authorize this send"
    );
    assert!(writes(&f).is_empty());
    server.abort();
}

#[tokio::test]
async fn company_mention_reads_recheck_current_binding_and_membership_after_network_io() {
    for revoke in [false, true] {
        let (f, s, c, server) = fixture().await;
        {
            let mut d = f.data.lock().unwrap();
            d.joined = true;
            d.after_query = Some(if revoke {
                |data: &mut Data| data.native["company_agent_ids"] = json!([])
            } else {
                |data: &mut Data| data.joined = false
            });
        }
        let selected = HashSet::from([f.agent.public_key().to_hex()]);
        assert!(mention_view(&f, &s, &c, Some(&selected)).await.is_err());
        assert!(writes(&f).is_empty());
        server.abort();
    }
}

#[tokio::test]
async fn company_mention_reads_do_not_return_after_native_identity_generation_changes() {
    let (f, s, c, server) = fixture().await;
    f.data.lock().unwrap().joined = true;
    let checks = AtomicUsize::new(0);
    let result = super::super::company_mentions::project(
        &oauth::client().unwrap(),
        &s,
        &c.relay_url,
        &c,
        &f.human,
        CHANNEL,
        None,
        || {
            if checks.fetch_add(1, Ordering::SeqCst) < 2 {
                Ok(())
            } else {
                Err(CANCELLED.into())
            }
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(
        f.data
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|(_, path, _)| path == "/query")
            .count(),
        1
    );
    assert!(writes(&f).is_empty());
    server.abort();
}
