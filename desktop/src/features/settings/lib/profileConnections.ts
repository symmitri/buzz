export type ConnectionEntry = {
  connection_id: string;
  alias: string;
  name: string;
  provider: string;
  credential_scope: "identity" | "organisation" | "none";
  auth_mode: string;
  visibility: "discoverable" | "hidden";
  entitlement: "allowed" | "requestable" | "denied";
  activation: {
    enabled: boolean;
    source: "default" | "user";
    version: number;
  };
  readiness: "ready" | "account_required" | "unavailable";
  setup: {
    kind: "none" | "key" | "oauth" | "google_oauth";
    connector_id: string;
    browser_supported: boolean;
  };
  request?: {
    id: string;
    status: "pending" | "approved" | "rejected";
    version: number;
  };
};

export type ConnectionAccount = {
  id: string;
  connection_id: string;
  connector_id: string;
  connector_name: string;
  provider: string;
  owner_type: "personal" | "company";
  owner_name: string;
  label?: string;
  email?: string;
  status: string;
  connected_at: string;
  updated_at: string;
  can_disconnect: boolean;
};

export type ConnectionsSnapshot = {
  schema_version: 1;
  principal: { id: string; type: "user" };
  organisation: { id: string };
  entries: ConnectionEntry[];
  accounts: ConnectionAccount[];
  accounts_state: "ready" | "unavailable";
  message?: string;
};

export type ConnectionsReadResult =
  | { state: "ready"; snapshot: ConnectionsSnapshot }
  | {
      state: "unavailable" | "access_lost" | "invalid";
      message: string;
    };

export type ConnectionsMutationResult =
  | { state: "confirmed"; snapshot: ConnectionsSnapshot }
  | {
      state: "not_confirmed" | "conflict" | "denied";
      snapshot?: ConnectionsSnapshot;
      message: string;
    }
  | { state: "access_lost"; message: string };

export type ConnectionScope = "all" | "personal" | "company";

export function visibleConnectionEntries(snapshot: ConnectionsSnapshot) {
  return snapshot.entries.filter(
    (entry) =>
      entry.visibility === "discoverable" || entry.entitlement === "allowed",
  );
}

export function filterConnectionEntries(
  snapshot: ConnectionsSnapshot,
  scope: ConnectionScope,
  search: string,
) {
  const query = search.trim().toLocaleLowerCase();
  const accountsByConnection = new Map<string, ConnectionAccount[]>();
  const activeConnections = new Set<string>();
  for (const account of snapshot.accounts) {
    const accounts = accountsByConnection.get(account.connection_id);
    if (accounts) accounts.push(account);
    else accountsByConnection.set(account.connection_id, [account]);
    if (account.status === "active") {
      activeConnections.add(account.connection_id);
    }
  }
  return visibleConnectionEntries(snapshot)
    .filter((entry) => {
      const entryScope =
        entry.credential_scope === "identity" ? "personal" : "company";
      if (scope !== "all" && scope !== entryScope) return false;
      if (!query) return true;
      const accounts = accountsByConnection.get(entry.connection_id) ?? [];
      return [
        entry.name,
        entry.alias,
        entry.provider,
        ...accounts.flatMap((account) => [
          account.connector_name,
          account.owner_name,
          account.email ?? "",
          account.label ?? "",
        ]),
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    })
    .sort((left, right) => {
      const leftSaved = activeConnections.has(left.connection_id);
      const rightSaved = activeConnections.has(right.connection_id);
      return (
        Number(rightSaved) - Number(leftSaved) ||
        left.name.localeCompare(right.name)
      );
    });
}

export function connectionStateLabels(
  entry: ConnectionEntry,
  accounts: readonly ConnectionAccount[],
  accountsAvailable = true,
) {
  const active = accounts.filter((account) => account.status === "active");
  const personal = active.filter(
    (account) => account.owner_type === "personal",
  );
  const company = active.filter((account) => account.owner_type === "company");
  return {
    ownership:
      entry.credential_scope === "identity"
        ? "Personal connection"
        : entry.credential_scope === "organisation"
          ? "Company connection"
          : "Shared service",
    entitlement:
      entry.entitlement === "allowed"
        ? "Access allowed"
        : entry.entitlement === "requestable"
          ? "Access available by request"
          : "Access restricted",
    activation:
      entry.entitlement === "allowed"
        ? entry.activation.enabled
          ? "Enabled for me"
          : "Disabled for me"
        : "Not enabled",
    account:
      entry.credential_scope === "none"
        ? entry.readiness === "unavailable"
          ? "Connection unavailable"
          : "No account required"
        : !accountsAvailable
          ? "Account status unavailable"
          : personal.length > 0
            ? "Account saved"
            : company.length > 0
              ? "Company configured"
              : entry.readiness === "account_required"
                ? "Account required"
                : entry.readiness === "unavailable"
                  ? "Company setup needed"
                  : entry.credential_scope === "organisation"
                    ? "Company configured"
                    : "No saved account required",
    provider: "Provider access hasn’t been checked here",
  };
}

export function requestId(): string {
  return crypto.randomUUID();
}
