import type {
  ConnectionEntry,
  ConnectionsSnapshot,
} from "../../src/features/settings/lib/profileConnections";

export function connectionEntry(
  overrides: Partial<ConnectionEntry> = {},
): ConnectionEntry {
  return {
    connection_id: "google-workspace",
    alias: "google_workspace",
    name: "Google Workspace",
    provider: "google_workspace",
    credential_scope: "identity",
    auth_mode: "oauth",
    visibility: "discoverable",
    entitlement: "allowed",
    activation: { enabled: true, source: "user", version: 2 },
    readiness: "ready",
    setup: {
      kind: "google_oauth",
      connector_id: "google-workspace",
      browser_supported: true,
    },
    ...overrides,
  };
}

export function connectionsFixture(): ConnectionsSnapshot {
  return {
    schema_version: 1,
    principal: { id: "sample-user", type: "user" },
    organisation: { id: "sample-company" },
    accounts_state: "ready",
    entries: [
      connectionEntry(),
      connectionEntry({
        connection_id: "slack",
        alias: "slack",
        name: "Slack",
        provider: "slack",
        readiness: "account_required",
        setup: {
          kind: "oauth",
          connector_id: "slack",
          browser_supported: true,
        },
      }),
      connectionEntry({
        connection_id: "linear",
        alias: "linear",
        name: "Linear",
        provider: "linear",
        credential_scope: "organisation",
        entitlement: "requestable",
        activation: { enabled: false, source: "default", version: 0 },
        setup: {
          kind: "none",
          connector_id: "linear",
          browser_supported: false,
        },
      }),
      connectionEntry({
        connection_id: "notion",
        alias: "notion",
        name: "Notion",
        provider: "notion",
        auth_mode: "key",
        readiness: "account_required",
        activation: { enabled: false, source: "user", version: 1 },
        setup: {
          kind: "key",
          connector_id: "notion",
          browser_supported: false,
        },
      }),
    ],
    accounts: [
      {
        id: "account-google",
        connection_id: "google-workspace",
        connector_id: "google-workspace",
        connector_name: "Google Workspace",
        provider: "google_workspace",
        owner_type: "personal",
        owner_name: "Alex Morgan",
        email: "alex@example.test",
        status: "active",
        connected_at: "2026-09-17T00:00:00Z",
        updated_at: "2026-09-17T00:00:00Z",
        can_disconnect: true,
      },
    ],
  };
}
