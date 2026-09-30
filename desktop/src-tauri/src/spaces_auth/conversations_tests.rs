use super::*;
use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
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
    response: Option<(u16, String)>,
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
) -> Response {
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
    if let Some((status, body)) = &state.response {
        return (
            axum::http::StatusCode::from_u16(*status).unwrap(),
            body.clone(),
        )
            .into_response();
    }
    Json(
        serde_json::json!({"channel_id":"11111111-1111-4111-8111-111111111111","agents":[{
            "agent_id":"agent-symi-internal","version":2,"audience_id":"synthetic-audience","visibility":state.visibility
        }]}),
    ).into_response()
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
        response: None,
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
    // Exercise the actual consent request, including signed audience and native
    // headers. Only fixed safe errors reach the UI; no failed POST is replayed.
    for (status, body, expected_error) in [
        (
            403,
            r#"{"error":"buzz_identity_denied","detail":"private-provider-data"}"#,
            ACCESS_DENIED,
        ),
        (
            401,
            "private-provider-data",
            "Your company sign-in needs attention. Reconnect before enabling agent replies.",
        ),
        (409, r#"{"error":"buzz_agent_not_ready"}"#, SETUP_REQUIRED),
        (409, r#"{"error":"buzz_identity_conflict"}"#, SETUP_CHANGED),
        (
            503,
            r#"{"error":"buzz_owned_conversations_unavailable"}"#,
            SETUP_REQUIRED,
        ),
        (503, r#"{"error":"buzz_unavailable"}"#, UNAVAILABLE),
        (502, "private-provider-data", UNAVAILABLE),
        (429, "private-provider-data", UNAVAILABLE),
        (409, r#"{"error":"private-provider-data"}"#, UNCONFIRMED),
        (400, r#"{"error":"invalid_buzz_conversation"}"#, UNCONFIRMED),
        (200, "private-provider-data", UNCONFIRMED),
        // A mismatched code must never turn an unknown 409 into denial/setup.
        (409, r#"{"error":"buzz_identity_denied"}"#, UNCONFIRMED),
    ] {
        let previous = state.lock().unwrap().posts.len();
        state.lock().unwrap().response = Some((status, body.into()));
        let error = approve(
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
        .unwrap_err();
        assert_eq!(error, expected_error, "HTTP {status}");
        assert!(!error.contains("private-provider-data"));
        assert_eq!(state.lock().unwrap().posts.len(), previous + 1);
    }
    state.lock().unwrap().response = None;
    let attempts = state.lock().unwrap().posts.len();
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
            attempts,
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
    assert_eq!(state.lock().unwrap().posts.len(), attempts + 1);
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
    assert_eq!(state.lock().unwrap().posts.len(), attempts + 1);
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
    assert_eq!(state.lock().unwrap().posts.len(), attempts + 1);
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
    assert_eq!(state.lock().unwrap().posts.len(), attempts + 1);
}

#[tokio::test]
async fn self_dm_requires_exact_private_single_member_relay_proof_without_consent() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let human = Keys::parse(&"01".repeat(32)).unwrap();
    let own = human.public_key().to_hex();
    let peer = Keys::parse(&"02".repeat(32)).unwrap().public_key().to_hex();
    let relay = Keys::parse(&"04".repeat(32)).unwrap();
    let channel = "11111111-1111-4111-8111-111111111111";
    let valid_metadata = event(
        &relay,
        39000,
        vec![
            vec!["d".into(), channel.into()],
            vec!["t".into(), "dm".into()],
            vec!["private".into()],
            vec!["p".into(), own.clone()],
        ],
    );
    let valid_membership = event(
        &relay,
        39002,
        vec![
            vec!["d".into(), channel.into()],
            vec!["p".into(), own.clone(), "".into(), "owner".into()],
        ],
    );
    let value = serde_json::json!({"environment":"alpha","org_id":"org_symmitri","identity_id":"synthetic-human","tenant_id":"synthetic-alpha","relay_url":origin,"relay_pubkey":relay.public_key().to_hex(),"pubkey":own,"people":[{"pubkey":own}],"agents":[],"company_agent_ids":[]});
    let expected: Configuration = serde_json::from_value(value.clone()).unwrap();
    let state = Arc::new(Mutex::new(Fixture {
        config: value,
        membership: valid_membership.clone(),
        posts: vec![],
        queries: 0,
        visibility: "shared".into(),
        response: None,
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
    let recipients = vec![own.clone()];

    approve(
        &client,
        &session,
        &origin,
        &expected,
        &human,
        channel,
        &valid_metadata,
        &recipients,
    )
    .await
    .unwrap();
    assert_eq!(state.lock().unwrap().queries, 1);
    assert!(state.lock().unwrap().posts.is_empty());

    let malformed_metadata = [
        event(
            &relay,
            39000,
            vec![
                vec!["d".into(), channel.into()],
                vec!["t".into(), "dm".into()],
                vec!["p".into(), own.clone()],
            ],
        ),
        event(
            &relay,
            39000,
            vec![
                vec!["d".into(), channel.into()],
                vec!["t".into(), "stream".into()],
                vec!["private".into()],
                vec!["p".into(), own.clone()],
            ],
        ),
        event(
            &relay,
            39000,
            vec![
                vec!["d".into(), channel.into()],
                vec!["t".into(), "dm".into()],
                vec!["private".into()],
                vec!["p".into(), own.clone()],
                vec!["p".into(), peer.clone()],
            ],
        ),
        event(
            &relay,
            39000,
            vec![
                vec!["d".into(), channel.into()],
                vec!["t".into(), "dm".into()],
                vec!["private".into()],
                vec!["p".into(), own.clone(), "".into(), "owner".into()],
            ],
        ),
    ];
    for (case, metadata) in malformed_metadata.iter().enumerate() {
        state.lock().unwrap().membership = valid_membership.clone();
        assert!(
            approve(
                &client,
                &session,
                &origin,
                &expected,
                &human,
                channel,
                metadata,
                &recipients,
            )
            .await
            .is_err(),
            "metadata case {case}"
        );
    }

    for (case, tags) in [
        vec![
            vec!["d".into(), channel.into()],
            vec!["p".into(), own.clone(), "".into(), "owner".into()],
            vec!["p".into(), peer.clone(), "".into(), "member".into()],
        ],
        vec![
            vec!["d".into(), channel.into()],
            vec!["p".into(), own.clone(), "".into(), "owner".into()],
            vec!["p".into(), own.clone(), "".into(), "owner".into()],
        ],
    ]
    .into_iter()
    .enumerate()
    {
        state.lock().unwrap().membership = event(&relay, 39002, tags);
        assert!(
            approve(
                &client,
                &session,
                &origin,
                &expected,
                &human,
                channel,
                &valid_metadata,
                &recipients,
            )
            .await
            .is_err(),
            "membership case {case}"
        );
    }
    assert!(state.lock().unwrap().posts.is_empty());
}

#[tokio::test]
async fn unreadable_or_ambiguous_consent_receipts_never_claim_denial_or_retry() {
    use futures_util::{stream, StreamExt};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new().fallback(post(move |uri: axum::http::Uri, headers: HeaderMap| {
        let observed = observed.clone();
        async move {
            observed.fetch_add(1, Ordering::SeqCst);
            assert_eq!(headers["cache-control"], "no-store");
            match uri.path() {
                "/large-error" => (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    "x".repeat(4097),
                )
                    .into_response(),
                "/large-receipt" => "x".repeat(64_001).into_response(),
                "/large-stream" => (
                    axum::http::StatusCode::SERVICE_UNAVAILABLE,
                    axum::body::Body::from_stream(stream::iter([
                        Ok::<_, std::io::Error>(vec![b'x'; 2500]),
                        Ok(vec![b'x'; 2500]),
                    ])),
                )
                    .into_response(),
                "/interrupted" => axum::body::Body::from_stream(
                    stream::once(async { Ok::<_, std::io::Error>(b"{\"channel_id\":".as_slice()) })
                        .chain(stream::once(async {
                            tokio::time::sleep(Duration::from_millis(10)).await;
                            Err(std::io::Error::other("synthetic private transport detail"))
                        })),
                )
                .into_response(),
                "/slow" => {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    "private-response".into_response()
                }
                "/redirect" => (
                    axum::http::StatusCode::TEMPORARY_REDIRECT,
                    [("location", "/must-not-follow")],
                    "private-response",
                )
                    .into_response(),
                _ => panic!("unexpected request"),
            }
        }
    }));
    let _server = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    }));
    let client = oauth::client().unwrap();
    for path in [
        "large-error",
        "large-receipt",
        "large-stream",
        "interrupted",
        "slow",
        "redirect",
    ] {
        let previous = calls.load(Ordering::SeqCst);
        let result = consent_receipt(
            client
                .post(format!("{origin}/{path}?private=synthetic"))
                .timeout(Duration::from_millis(100))
                .bearer_auth("synthetic-only"),
        )
        .await;
        assert_eq!(result.err().as_deref(), Some(UNCONFIRMED), "{path}");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            previous + 1,
            "{path} must not replay"
        );
    }
}
