use super::catalog::*;

pub(super) fn snapshot() -> ConnectionsSnapshot {
    ConnectionsSnapshot {
        schema_version: 1,
        principal: Principal {
            id: "usr_test".into(),
            kind: "user".into(),
        },
        organisation: Organisation {
            id: "org_symmitri".into(),
        },
        entries: vec![ConnectionEntry {
            connection_id: "conn_google".into(),
            alias: "google-workspace".into(),
            name: "Google Workspace".into(),
            provider: "google-workspace".into(),
            credential_scope: "identity".into(),
            auth_mode: "oauth".into(),
            visibility: "discoverable".into(),
            entitlement: "allowed".into(),
            activation: Activation {
                enabled: true,
                source: "user".into(),
                version: 2,
            },
            readiness: "ready".into(),
            setup: Setup {
                kind: "google_oauth".into(),
                connector_id: "google-workspace".into(),
                browser_supported: true,
            },
            request: None,
        }],
        accounts: vec![ConnectionAccount {
            id: "acc_mine".into(),
            connection_id: "conn_google".into(),
            connector_id: "google-workspace".into(),
            connector_name: "Google Workspace".into(),
            provider: "google-workspace".into(),
            owner_type: "personal".into(),
            owner_name: "Test Person".into(),
            label: "Work".into(),
            email: "test@example.test".into(),
            status: "active".into(),
            connected_at: "2026-09-17T00:00:00Z".into(),
            updated_at: "2026-09-17T00:00:00Z".into(),
            can_disconnect: true,
        }],
        accounts_state: "ready".into(),
        message: None,
    }
}
