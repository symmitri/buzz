use super::*;
use axum::{
    extract::State,
    http::{HeaderMap, Method, Uri},
    routing::any,
    Json, Router,
};
use serde_json::{json, Value};
use std::{collections::VecDeque, sync::Arc};

fn session() -> oauth::Session {
    serde_json::from_value(json!({ "access_token": format!("sym_{}", "t".repeat(43)), "token_type": "Bearer",
        "expires_at": "2099-01-01T00:00:00Z", "identity_id": "usr_test", "org_id": "org_symmitri" })).unwrap()
}

fn capability() -> GitHubCapability {
    serde_json::from_value(json!({ "configured": true, "administrator_id": "usr_test", "organisation_id": "org_symmitri",
        "account_login": "symmitri", "repositories": ["symmitri/axis"], "read_tools": ["github_read"],
        "in_progress": false, "can_start": true })).unwrap()
}

fn saved_session() -> Value {
    json!({ "id": format!("ghon_{}", "a".repeat(32)), "phase": "registration", "account_login": "symmitri",
        "repositories": ["symmitri/axis"], "read_tools": ["github_read"], "expires_at": "2099-01-01T00:00:00Z",
        "can_resume": true, "agent_access_granted": false, "provider_read_verified": false })
}

fn input() -> GitHubChangeInput {
    GitHubChangeInput {
        request_id: "request-one".into(),
        action: "start".into(),
        expected_revision: view(capability()).unwrap().revision,
        expected_administrator_id: "usr_test".into(),
        expected_organisation_id: "org_symmitri".into(),
        session_id: None,
    }
}

#[derive(Clone)]
struct Fixture {
    responses: Arc<Mutex<VecDeque<(StatusCode, Value)>>>,
    requests: Arc<Mutex<Vec<(String, String)>>>,
}

async fn serve(
    State(fixture): State<Fixture>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    assert_eq!(
        headers.get("authorization").unwrap(),
        &format!("Bearer sym_{}", "t".repeat(43))
    );
    fixture
        .requests
        .lock()
        .unwrap()
        .push((method.to_string(), uri.path().into()));
    let (status, body) = fixture
        .responses
        .lock()
        .unwrap()
        .pop_front()
        .unwrap_or((StatusCode::INTERNAL_SERVER_ERROR, json!({})));
    (status, Json(body))
}

async fn fixture(
    responses: Vec<(StatusCode, Value)>,
) -> (String, Fixture, tokio::task::JoinHandle<()>) {
    let fixture = Fixture {
        responses: Arc::new(Mutex::new(responses.into())),
        requests: Arc::default(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .fallback(any(serve))
        .with_state(fixture.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (origin, fixture, server)
}

#[tokio::test]
async fn capability_is_exact_owner_only_and_optional_failure_is_not_global_authority() {
    for (status, expected) in [
        (StatusCode::FORBIDDEN, Failure::Denied),
        (StatusCode::NOT_FOUND, Failure::Unsupported),
        (StatusCode::UNAUTHORIZED, Failure::AccessLost),
    ] {
        let (gateway, fixture, server) =
            fixture(vec![(status, json!({ "can_manage_agent_accounts": true }))]).await;
        let result = read_capability(&oauth::client().unwrap(), &session(), &gateway).await;
        assert!(matches!(result, Err(error) if error == expected));
        assert_eq!(
            *fixture.requests.lock().unwrap(),
            vec![("GET".into(), PATH.into())]
        );
        server.abort();
    }
    let mut wrong_owner = capability();
    wrong_owner.administrator_id = "usr_other".into();
    assert_eq!(
        validate_capability(&wrong_owner, &session()),
        Err(Failure::AccessLost)
    );
    wrong_owner.administrator_id = "usr_test".into();
    wrong_owner.organisation_id = "org_other".into();
    assert_eq!(
        validate_capability(&wrong_owner, &session()),
        Err(Failure::AccessLost)
    );
}

#[tokio::test]
async fn a_changed_company_scope_or_caller_precondition_never_posts() {
    for changed_identity in [false, true] {
        let mut cap = capability();
        let mut request = input();
        if changed_identity {
            request.expected_administrator_id = "usr_other".into();
        } else {
            cap.scope.repositories.push("symmitri/another".into());
        }
        let (gateway, fixture, server) =
            fixture(vec![(StatusCode::OK, serde_json::to_value(cap).unwrap())]).await;
        assert!(
            change_with_recovery(&oauth::client().unwrap(), &session(), &gateway, &request)
                .await
                .is_err()
        );
        assert_eq!(
            *fixture.requests.lock().unwrap(),
            vec![("GET".into(), PATH.into())]
        );
        server.abort();
    }
}

#[tokio::test]
async fn uncertain_post_recovers_saved_session_with_one_get_and_never_replays() {
    let mut recovered = serde_json::to_value(capability()).unwrap();
    recovered["can_start"] = json!(false);
    recovered["in_progress"] = json!(true);
    recovered["session"] = saved_session();
    let (gateway, fixture, server) = fixture(vec![
        (StatusCode::OK, serde_json::to_value(capability()).unwrap()),
        (
            StatusCode::BAD_GATEWAY,
            json!({ "private_error": "not exported" }),
        ),
        (StatusCode::OK, recovered),
    ])
    .await;
    let result =
        change_with_recovery(&oauth::client().unwrap(), &session(), &gateway, &input()).await;
    match result {
        Err(GitHubResult::Uncertain {
            view: Some(view), ..
        }) => assert_eq!(
            view.capability.session.unwrap().id,
            format!("ghon_{}", "a".repeat(32))
        ),
        _ => panic!("uncertain POST must retain recovered metadata"),
    }
    assert_eq!(
        *fixture.requests.lock().unwrap(),
        vec![
            ("GET".into(), PATH.into()),
            ("POST".into(), PATH.into()),
            ("GET".into(), PATH.into())
        ]
    );
    server.abort();
}

#[test]
fn browser_handoff_is_phase_bound_and_never_projects_url_or_credentials() {
    let gateway = "https://gateway.symmitri.ai";
    let state = "s".repeat(43);
    let token = session().access_token.clone();
    let registration = format!("{gateway}{PATH}/register?state={state}");
    let installation =
        format!("https://github.com/apps/symmitri-spaces/installations/new?state={state}");
    assert!(authorization_url(&registration, "registration", gateway, &token).is_ok());
    assert!(authorization_url(&installation, "installation", gateway, &token).is_ok());
    for url in [
        registration.replace("https:", "http:"),
        registration.replace("gateway.symmitri.ai", "example.test"),
        format!("{registration}&token={token}"),
        format!("{registration}&state={state}"),
        format!("{registration}#fragment"),
        installation.replace("github.com", "github.com.evil.test"),
    ] {
        assert!(authorization_url(&url, "registration", gateway, &token).is_err());
    }
    assert!(authorization_url(&installation, "registration", gateway, &token).is_err());
    let mut metadata = saved_session();
    metadata["open_url"] = json!(registration);
    metadata["access_token"] = json!(token);
    let projected: GitHubSession = serde_json::from_value(metadata).unwrap();
    let output = serde_json::to_string(&projected).unwrap();
    assert!(
        !output.contains("open_url")
            && !output.contains("access_token")
            && !output.contains(&state)
    );
}

#[test]
fn resume_is_exact_saved_session_and_scope_bound() {
    let mut cap = capability();
    cap.can_start = false;
    cap.in_progress = true;
    cap.session = Some(serde_json::from_value(saved_session()).unwrap());
    let current = view(cap).unwrap();
    let mut request = input();
    request.action = "resume".into();
    request.expected_revision = current.revision.clone();
    request.session_id = Some(format!("ghon_{}", "a".repeat(32)));
    assert!(authorize_change(&current, &request, &session()).is_ok());
    request.session_id = Some(format!("ghon_{}", "b".repeat(32)));
    assert_eq!(
        authorize_change(&current, &request, &session()),
        Err(Failure::Conflict)
    );
    let mut invalid = serde_json::from_value::<GitHubSession>(saved_session()).unwrap();
    invalid.provider_read_verified = true;
    assert_eq!(
        validate_session(&invalid, &current.capability.scope),
        Err(Failure::Invalid)
    );
}

#[test]
fn cancellation_is_bound_to_own_request_and_old_cleanup_cannot_cancel_new_work() {
    let requests = SpacesGitHubRequests::default();
    let first = requests.begin("first").unwrap();
    requests.cancel("other").unwrap();
    assert!(!first.cancel.is_cancelled());
    requests.cancel("first").unwrap();
    assert!(first.cancel.is_cancelled());
    let next = requests.begin("next").unwrap();
    drop(first);
    assert!(!next.cancel.is_cancelled());
}
