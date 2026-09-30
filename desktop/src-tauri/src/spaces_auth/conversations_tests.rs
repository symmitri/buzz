use super::*;
use axum::{
    extract::State,
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use nostr::{EventBuilder, Tag};
use std::sync::{Arc, Mutex};

struct Fixture {
    config: serde_json::Value,
    membership: Event,
    posts: Vec<serde_json::Value>,
    queries: usize,
    visibility: String,
}

fn header(headers: &HeaderMap) {
    assert_eq!(headers["x-axis-buzz-environment"], "alpha");
    assert_eq!(headers["authorization"], "Bearer synthetic-only");
}

async fn config(
    State(state): State<Arc<Mutex<Fixture>>>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    header(&headers);
    Json(state.lock().unwrap().config.clone())
}

async fn query(State(state): State<Arc<Mutex<Fixture>>>, headers: HeaderMap) -> Json<Vec<Event>> {
    use base64::Engine;
    let raw = headers["authorization"]
        .to_str()
        .unwrap()
        .strip_prefix("Nostr ")
        .unwrap();
    let event: Event = serde_json::from_slice(
        &base64::engine::general_purpose::STANDARD
            .decode(raw)
            .unwrap(),
    )
    .unwrap();
    event.verify().unwrap();
    assert_eq!(
        event.pubkey,
        Keys::parse(&"01".repeat(32)).unwrap().public_key()
    );
    let mut state = state.lock().unwrap();
    state.queries += 1;
    Json(vec![state.membership.clone()])
}

async fn consent(
    State(state): State<Arc<Mutex<Fixture>>>,
    headers: HeaderMap,
    Json(value): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    // Count arrival before validation: a rejected POST is still a dispatch.
    state.lock().unwrap().posts.push(value.clone());
    header(&headers);
    assert_eq!(
        value["agent_ids"],
        serde_json::json!(["agent-symi-internal"])
    );
    for name in ["metadata", "membership"] {
        let event: Event = serde_json::from_value(value[name].clone()).unwrap();
        event.verify().unwrap();
        assert_eq!(
            event.kind,
            Kind::Custom(if name == "metadata" { 39000 } else { 39002 })
        );
        let mut participants: Vec<_> = event
            .tags
            .iter()
            .filter(|tag| tag.as_slice().first().is_some_and(|name| name == "p"))
            .map(|tag| tag.as_slice()[1].clone())
            .collect();
        participants.sort();
        let mut expected = vec![
            Keys::parse(&"01".repeat(32)).unwrap().public_key().to_hex(),
            Keys::parse(&"02".repeat(32)).unwrap().public_key().to_hex(),
        ];
        expected.sort();
        assert_eq!(
            participants, expected,
            "both signed events must carry the exact DM audience"
        );
    }
    let state = state.lock().unwrap();
    Json(
        serde_json::json!({"channel_id":"11111111-1111-4111-8111-111111111111","agents":[{
            "agent_id":"agent-symi-internal","version":2,"audience_id":"synthetic-audience","visibility":state.visibility
        }]}),
    )
}

fn event(key: &Keys, kind: u16, tags: Vec<Vec<String>>) -> Event {
    EventBuilder::new(Kind::Custom(kind), "")
        .tags(tags.into_iter().map(|tag| Tag::parse(tag).unwrap()))
        .sign_with_keys(key)
        .unwrap()
}

#[tokio::test]
async fn explicit_company_dm_uses_native_proof_and_never_accepts_private_authority() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let human = Keys::parse(&"01".repeat(32)).unwrap();
    let peer = Keys::parse(&"02".repeat(32)).unwrap().public_key().to_hex();
    let relay = Keys::parse(&"04".repeat(32)).unwrap();
    let channel = "11111111-1111-4111-8111-111111111111";
    let metadata = event(
        &relay,
        39000,
        vec![
            vec!["d".into(), channel.into()],
            vec!["t".into(), "dm".into()],
            vec!["private".into()],
            vec!["p".into(), human.public_key().to_hex()],
            vec!["p".into(), peer.clone()],
        ],
    );
    let membership = event(
        &relay,
        39002,
        vec![
            vec!["d".into(), channel.into()],
            vec![
                "p".into(),
                human.public_key().to_hex(),
                "".into(),
                "owner".into(),
            ],
            vec!["p".into(), peer.clone(), "".into(), "member".into()],
        ],
    );
    let value = serde_json::json!({"environment":"alpha","org_id":"org_symmitri","identity_id":"synthetic-human","tenant_id":"synthetic-alpha","relay_url":origin,"relay_pubkey":relay.public_key().to_hex(),"pubkey":human.public_key().to_hex(),"people":[{"pubkey":human.public_key().to_hex()}],"agents":[{"agent_id":"agent-symi-internal","pubkey":peer}],"company_agent_ids":["agent-symi-internal"]});
    let expected: Configuration = serde_json::from_value(value.clone()).unwrap();
    let state = Arc::new(Mutex::new(Fixture {
        config: value,
        membership,
        posts: vec![],
        queries: 0,
        visibility: "shared".into(),
    }));
    let router = Router::new()
        .route("/v1/space/buzz/config", get(config))
        .route("/query", post(query))
        .route("/v1/space/buzz/conversations", post(consent))
        .with_state(state.clone());
    let _task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let session: oauth::Session=serde_json::from_value(serde_json::json!({"access_token":"synthetic-only","expires_at":"2099-01-01T00:00:00Z","identity_id":"synthetic-human","org_id":"org_symmitri","token_type":"Bearer"})).unwrap();
    let client = oauth::client().unwrap();
    approve(
        &client,
        &session,
        &origin,
        &expected,
        &human,
        channel,
        &metadata,
        std::slice::from_ref(&peer),
    )
    .await
    .unwrap();
    assert_eq!(state.lock().unwrap().posts.len(), 1);
    // Exercise actual signed relay membership shapes through approve, with
    // exactly one consent POST for the valid role-bearing two-person DM.
    let original_membership = state.lock().unwrap().membership.clone();
    let valid_tags: Vec<_> = original_membership
        .tags
        .iter()
        .map(|tag| tag.as_slice().to_vec())
        .collect();
    let mut invalid_sets = Vec::new();
    let mut duplicate = valid_tags.clone();
    duplicate.push(valid_tags[1].clone());
    invalid_sets.push(duplicate);
    let mut extra = valid_tags.clone();
    extra.push(vec![
        "p".into(),
        Keys::parse(&"03".repeat(32)).unwrap().public_key().to_hex(),
        "".into(),
        "member".into(),
    ]);
    invalid_sets.push(extra);
    for malformed in [
        vec!["p".into()],
        vec!["p".into(), peer.clone(), "".into()],
        vec![
            "p".into(),
            peer.clone(),
            "wss://unaccepted.test".into(),
            "member".into(),
        ],
        vec!["p".into(), peer.clone(), "".into(), "".into()],
        vec!["p".into(), "invalid".into()],
        vec![
            "p".into(),
            peer.clone(),
            "".into(),
            "member".into(),
            "extra".into(),
        ],
    ] {
        let mut tags = valid_tags.clone();
        tags.push(malformed);
        invalid_sets.push(tags);
    }
    for (case, tags) in invalid_sets.into_iter().enumerate() {
        state.lock().unwrap().membership = event(&relay, 39002, tags);
        assert!(
            approve(
                &client,
                &session,
                &origin,
                &expected,
                &human,
                channel,
                &metadata,
                std::slice::from_ref(&peer)
            )
            .await
            .is_err(),
            "membership case {case}"
        );
        assert_eq!(
            state.lock().unwrap().posts.len(),
            1,
            "bad membership must not consent"
        );
    }
    state.lock().unwrap().membership = original_membership;
    state.lock().unwrap().visibility = "private".into();
    assert!(approve(
        &client,
        &session,
        &origin,
        &expected,
        &human,
        channel,
        &metadata,
        std::slice::from_ref(&peer)
    )
    .await
    .is_err());
    assert_eq!(state.lock().unwrap().posts.len(), 2);
    let forged = event(
        &human,
        39000,
        metadata
            .tags
            .iter()
            .map(|tag| tag.as_slice().to_vec())
            .collect(),
    );
    assert!(approve(
        &client,
        &session,
        &origin,
        &expected,
        &human,
        channel,
        &forged,
        std::slice::from_ref(&peer)
    )
    .await
    .is_err());
    assert_eq!(state.lock().unwrap().posts.len(), 2);
    state.lock().unwrap().config["tenant_id"] = "different".into();
    assert!(approve(
        &client,
        &session,
        &origin,
        &expected,
        &human,
        channel,
        &metadata,
        std::slice::from_ref(&peer)
    )
    .await
    .is_err());
    assert_eq!(state.lock().unwrap().posts.len(), 2);
    {
        let mut data = state.lock().unwrap();
        data.config["tenant_id"] = "synthetic-alpha".into();
        data.config["agents"] = serde_json::json!([]);
    }
    assert!(approve(
        &client,
        &session,
        &origin,
        &expected,
        &human,
        channel,
        &metadata,
        std::slice::from_ref(&peer)
    )
    .await
    .is_err());
    {
        let mut data = state.lock().unwrap();
        data.config["people"] =
            serde_json::json!([{"pubkey":human.public_key().to_hex()},{"pubkey":peer}]);
        data.queries = 0;
    }
    approve(
        &client,
        &session,
        &origin,
        &expected,
        &human,
        channel,
        &metadata,
        std::slice::from_ref(&peer),
    )
    .await
    .unwrap();
    assert_eq!(
        state.lock().unwrap().queries,
        0,
        "human DM does not need agent proof or grants"
    );
    assert_eq!(state.lock().unwrap().posts.len(), 2);
}
