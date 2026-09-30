import * as React from "react";
import {
  Building2,
  ChevronDown,
  KeyRound,
  Plug,
  UserRound,
} from "lucide-react";
import {
  connectionStateLabels,
  type ConnectionAccount,
  type ConnectionEntry,
} from "@/features/settings/lib/profileConnections";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import { SettingsOptionGroup } from "./SettingsOptionGroup";
import { ConnectionProviderLogo } from "./ConnectionProviderLogo";

export type ConnectionMutation = (
  command: string,
  connectionId: string,
  input: Record<string, unknown>,
  success: string,
) => Promise<boolean>;

export function ProfileConnectionRow({
  accounts,
  accountsAvailable,
  busy,
  disabled,
  entry,
  mutate,
  startOAuth,
  accessRequestId,
}: {
  accounts: ConnectionAccount[];
  accountsAvailable: boolean;
  busy: boolean;
  disabled: boolean;
  entry: ConnectionEntry;
  mutate: ConnectionMutation;
  accessRequestId: (connectionId: string) => string;
  startOAuth: (
    connectionId: string,
    input: { connectionId: string; access?: "read_only" | "drafts" },
  ) => Promise<boolean>;
}) {
  const [secret, setSecret] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [googleAccess, setGoogleAccess] = React.useState<
    "read_only" | "drafts"
  >("read_only");
  const [confirmDisconnect, setConfirmDisconnect] = React.useState<
    string | null
  >(null);
  const labels = connectionStateLabels(entry, accounts, accountsAvailable);
  const displayedAccounts = entry.credential_scope === "none" ? [] : accounts;
  const personalAccounts = accounts.filter(
    (account) => account.owner_type === "personal",
  );
  const oauthSupported = entry.setup.browser_supported;

  const requestAccess = async () => {
    const id = accessRequestId(entry.connection_id);
    const confirmed = await mutate(
      "spaces_request_connection_access",
      entry.connection_id,
      {
        connectionId: entry.connection_id,
        idempotencyKey: id,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      "Access request sent.",
    );
    if (confirmed) {
      setReason("");
    }
  };

  const connectKey = async (event: React.FormEvent) => {
    event.preventDefault();
    const value = secret.trim();
    if (!value) return;
    setSecret("");
    await mutate(
      "spaces_connect_connection_key",
      entry.connection_id,
      { connectionId: entry.connection_id, secret: value },
      "Account saved. Provider access has not been tested by Spaces.",
    );
  };

  return (
    <SettingsOptionGroup
      data-testid={"profile-connection-" + entry.connection_id}
      title={
        <span className="flex items-center gap-2 text-foreground">
          <ConnectionProviderLogo
            provider={entry.provider}
            connectorId={entry.setup.connector_id || entry.alias}
          />
          <span>{entry.name}</span>
        </span>
      }
    >
      <details className="group">
        <summary className="flex min-h-20 cursor-pointer list-none items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="sr-only">{entry.name}. </span>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted/60">
            {entry.credential_scope === "identity" ? (
              <UserRound className="h-4 w-4" />
            ) : entry.credential_scope === "organisation" ? (
              <Building2 className="h-4 w-4" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {labels.ownership}
              {displayedAccounts[0]?.email
                ? ` · ${displayedAccounts[0].email}`
                : ""}
            </span>
            <span className="mt-1 flex flex-wrap gap-1.5">
              <Badge
                variant={
                  entry.entitlement === "allowed"
                    ? "success"
                    : entry.entitlement === "requestable"
                      ? "warning"
                      : "secondary"
                }
              >
                {labels.entitlement}
              </Badge>
              <Badge variant="outline">{labels.account}</Badge>
              <Badge variant="outline">{labels.activation}</Badge>
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>

        <div className="space-y-5 border-t border-border/55 px-4 py-4">
          {displayedAccounts.map((account) => {
            const accountLabel =
              account.email || account.label || account.connector_name;
            return (
              <div
                className="rounded-lg border border-border/60 bg-muted/15 p-3"
                key={account.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {accountLabel}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {account.owner_type === "personal"
                        ? "Your saved account"
                        : (account.owner_name || "Company") +
                          " · Company configured"}
                      {" · "}
                      {account.status.replaceAll("_", " ")}
                    </p>
                  </div>
                  {entry.credential_scope === "identity" &&
                  account.can_disconnect ? (
                    confirmDisconnect === account.id ? (
                      <div className="flex gap-2">
                        <Button
                          disabled={disabled}
                          onClick={async () => {
                            const confirmed = await mutate(
                              "spaces_disconnect_connection_account",
                              entry.connection_id,
                              { accountId: account.id },
                              "Account disconnected.",
                            );
                            if (confirmed) setConfirmDisconnect(null);
                          }}
                          size="sm"
                          type="button"
                          variant="destructive"
                        >
                          {busy ? "Disconnecting…" : "Confirm disconnect"}
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => setConfirmDisconnect(null)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        disabled={disabled}
                        onClick={() => setConfirmDisconnect(account.id)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Disconnect
                      </Button>
                    )
                  ) : null}
                </div>
              </div>
            );
          })}

          <p className="text-sm text-muted-foreground">{labels.provider}.</p>

          {entry.entitlement === "allowed" ? (
            <label className="flex items-center justify-between gap-4 rounded-lg border border-border/60 px-3 py-2">
              <span>
                <span className="block text-sm font-medium">
                  Enabled for me
                </span>
                <span className="block text-sm text-muted-foreground">
                  Choose whether this connection is available for your work.
                </span>
              </span>
              <Switch
                aria-label={"Enable " + entry.name + " for me"}
                checked={entry.activation.enabled}
                disabled={disabled}
                onCheckedChange={(enabled) =>
                  void mutate(
                    "spaces_set_connection_enabled",
                    entry.connection_id,
                    {
                      connectionId: entry.connection_id,
                      enabled,
                      expectedVersion: entry.activation.version,
                    },
                    entry.name +
                      " is now " +
                      (enabled ? "enabled" : "disabled") +
                      " for you.",
                  )
                }
              />
            </label>
          ) : null}

          {entry.entitlement === "requestable" ? (
            entry.request?.status === "pending" ? (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                Your access request is pending company review.
              </p>
            ) : (
              <div className="space-y-3 rounded-lg border border-border/60 p-3">
                <div>
                  <p className="text-sm font-medium">Request company access</p>
                  <p className="text-sm text-muted-foreground">
                    Your company will review your request.
                  </p>
                </div>
                <Textarea
                  aria-label={"Reason for requesting " + entry.name}
                  disabled={disabled}
                  maxLength={1000}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Reason · optional"
                  value={reason}
                />
                <Button
                  disabled={disabled}
                  onClick={() => void requestAccess()}
                  size="sm"
                  type="button"
                >
                  {busy ? "Requesting…" : "Request access"}
                </Button>
              </div>
            )
          ) : null}

          {entry.entitlement === "allowed" &&
          entry.credential_scope === "identity" &&
          entry.setup.kind === "key" ? (
            <form
              className="space-y-3 rounded-lg border border-border/60 p-3"
              onSubmit={connectKey}
            >
              <div>
                <p className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="h-4 w-4" />
                  {personalAccounts.length > 0
                    ? "Replace account key"
                    : "Connect with an account key"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Your key is saved securely for your account. It is cleared
                  from this form when you submit.
                </p>
              </div>
              <Input
                aria-label={entry.name + " API key or access token"}
                autoComplete="off"
                disabled={disabled}
                maxLength={64000}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="API key or access token"
                type="password"
                value={secret}
              />
              <Button
                disabled={disabled || !secret.trim()}
                size="sm"
                type="submit"
              >
                {busy
                  ? "Saving…"
                  : personalAccounts.length
                    ? "Replace key"
                    : "Connect"}
              </Button>
            </form>
          ) : null}

          {entry.entitlement === "allowed" &&
          entry.credential_scope === "identity" &&
          (entry.setup.kind === "oauth" ||
            entry.setup.kind === "google_oauth") ? (
            <div className="space-y-3 rounded-lg border border-border/60 p-3">
              <div>
                <p className="text-sm font-medium">
                  {personalAccounts.length > 0
                    ? "Reconnect provider account"
                    : "Connect provider account"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Choose an account and approve access in your browser. Then
                  return here and refresh.
                </p>
              </div>
              {entry.setup.kind === "google_oauth" ? (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium">Google access</span>
                  <select
                    className="h-9 rounded-lg border border-input/40 bg-background px-3 text-sm"
                    disabled={disabled}
                    onChange={(event) =>
                      setGoogleAccess(
                        event.target.value as "read_only" | "drafts",
                      )
                    }
                    value={googleAccess}
                  >
                    <option value="read_only">Read only</option>
                    <option value="drafts">Read and create drafts</option>
                  </select>
                </label>
              ) : null}
              {oauthSupported ? (
                <Button
                  disabled={disabled}
                  onClick={() =>
                    void startOAuth(entry.connection_id, {
                      connectionId: entry.connection_id,
                      ...(entry.setup.kind === "google_oauth"
                        ? { access: googleAccess }
                        : {}),
                    })
                  }
                  size="sm"
                  type="button"
                >
                  {busy
                    ? "Opening browser…"
                    : personalAccounts.length
                      ? "Reconnect"
                      : "Connect"}
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  This provider cannot be connected from Spaces yet.
                </p>
              )}
            </div>
          ) : null}

          {entry.credential_scope === "organisation" ? (
            <p className="rounded-lg bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Account setup is managed by your company.
            </p>
          ) : null}

          {entry.credential_scope !== "none" &&
          entry.setup.kind === "none" &&
          entry.readiness !== "ready" &&
          entry.entitlement === "allowed" ? (
            <p className="rounded-lg bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Setup is not available for this connection yet.
            </p>
          ) : null}
        </div>
      </details>
    </SettingsOptionGroup>
  );
}
