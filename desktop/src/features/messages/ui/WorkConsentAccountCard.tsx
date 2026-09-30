import * as React from "react";
import { LockKeyhole, RefreshCw } from "lucide-react";

import { ConnectionProviderLogo } from "@/features/settings/ui/ConnectionProviderLogo";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

/** Presentation options mapped from the authenticated owner's eligible accounts. */
export interface WorkConsentAccountCardProps {
  /** Change with the authenticated owner/generation and frozen intent/version/digest. */
  scopeKey: string;
  phase:
    | "loading"
    | "ready"
    | "uncertain"
    | "no-account"
    | "access-lost"
    | "unavailable"
    | "stale"
    | "expired";
  taskSummary: string;
  requesterLabel: string;
  accounts: readonly {
    /** Exact account and version selection key; the native adapter retains the wire IDs. */
    key: string;
    provider: string;
    providerLabel: string;
    label: string;
    email?: string;
  }[];
  busy?: boolean;
  /** Select the exact account for review. This callback is never an approval. */
  onReview: (accountKey: string) => void;
  onRefresh: () => void;
  /** Retry the unchanged journaled selection, never a newly chosen account. */
  onRetry?: () => void;
  onOpenConnections: () => void;
}

/** Owner-private account choice before the existing personal-access review card. */
export function WorkConsentAccountCard({
  scopeKey,
  phase,
  taskSummary,
  requesterLabel,
  accounts,
  busy = false,
  onReview,
  onRefresh,
  onRetry,
  onOpenConnections,
}: WorkConsentAccountCardProps) {
  const headingId = React.useId();
  const radioName = React.useId();
  const [choice, setChoice] = React.useState<{
    scopeKey: string;
    key: string;
  } | null>(null);
  React.useEffect(() => {
    setChoice((current) =>
      phase === "access-lost" ||
      phase === "loading" ||
      current?.scopeKey !== scopeKey
        ? null
        : current,
    );
  }, [phase, scopeKey]);
  // Fence retained state synchronously before effects on an owner or intent change.
  const options = phase === "ready" ? accounts : [];
  const chosen =
    choice?.scopeKey === scopeKey
      ? options.find((account) => account.key === choice.key)
      : undefined;
  const selected = chosen ?? (options.length === 1 ? options[0] : undefined);
  const noAccount =
    phase === "no-account" || (phase === "ready" && options.length === 0);
  const showTask = phase !== "access-lost" && phase !== "loading";
  const disabled = busy || phase !== "ready";

  return (
    <section
      aria-busy={busy || phase === "loading" || undefined}
      aria-labelledby={headingId}
      className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background/80 text-sm shadow-xs"
      data-testid="work-consent-account-card"
      data-preserve-composer-focus=""
    >
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <LockKeyhole aria-hidden="true" className="size-3.5" />
          <span>Just for you</span>
        </div>
        <div className="space-y-1.5">
          <h3
            className="font-semibold text-foreground"
            id={headingId}
            tabIndex={-1}
          >
            {phase === "loading"
              ? "Checking your accounts…"
              : phase === "access-lost"
                ? "Check your account access"
                : phase === "unavailable"
                  ? "Accounts are unavailable"
                  : phase === "expired"
                    ? "Access request expired"
                    : phase === "stale"
                      ? "Access request changed"
                      : noAccount
                        ? "Connect an account for this task"
                        : "Choose an account for this task"}
          </h3>
          {showTask ? (
            <>
              <p className="break-words leading-relaxed text-muted-foreground">
                {taskSummary}
              </p>
              <p className="break-words text-xs text-muted-foreground">
                Requested by {requesterLabel}
              </p>
            </>
          ) : null}
        </div>

        {options.length > 0 ? (
          <fieldset className="space-y-2" disabled={disabled}>
            <legend className="sr-only">Choose an account</legend>
            {options.map((account) => (
              <label
                className={cn(
                  "flex min-w-0 cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 transition-colors focus-within:ring-1 focus-within:ring-ring",
                  selected?.key === account.key
                    ? "border-primary/40 bg-muted/50"
                    : "border-border/60 bg-muted/20",
                  disabled && "cursor-default opacity-60",
                )}
                key={account.key}
              >
                <ConnectionProviderLogo provider={account.provider} />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block break-words font-medium text-foreground">
                    {account.label}
                  </span>{" "}
                  {account.email && account.email !== account.label ? (
                    <span className="block break-all text-xs text-muted-foreground">
                      {account.email}
                    </span>
                  ) : null}{" "}
                  <span className="block text-xs text-muted-foreground">
                    {account.providerLabel}
                  </span>
                </span>
                <input
                  checked={selected?.key === account.key}
                  className="size-4 shrink-0 accent-primary"
                  name={radioName}
                  onChange={() => setChoice({ scopeKey, key: account.key })}
                  type="radio"
                  value={account.key}
                />
              </label>
            ))}
          </fieldset>
        ) : null}

        <p
          className="text-xs leading-relaxed text-muted-foreground"
          role={
            phase === "uncertain" ||
            phase === "access-lost" ||
            phase === "stale" ||
            phase === "expired"
              ? "status"
              : undefined
          }
        >
          {phase === "loading"
            ? "Your conversation is ready while we check your accounts."
            : phase === "access-lost"
              ? "Your account access changed. Refresh to check this request."
              : phase === "unavailable"
                ? "We couldn’t check your accounts. Refresh to try again."
                : phase === "uncertain"
                  ? "We couldn’t confirm your selection. Check status to continue."
                  : phase === "expired"
                    ? "The time to choose an account for this request has ended."
                    : phase === "stale"
                      ? "The request changed. Refresh to check its current status."
                      : noAccount
                        ? "Open Connections in your profile, then return to this task."
                        : "You’ll review the exact access before deciding."}
        </p>
      </div>

      {phase !== "loading" ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-muted/20 px-4 py-3">
          {phase === "uncertain" && onRetry ? (
            <Button disabled={busy} onClick={onRetry} size="sm" type="button">
              {busy ? "Checking selection…" : "Retry selection"}
            </Button>
          ) : null}
          {phase === "ready" && !noAccount ? (
            <Button
              disabled={disabled || !selected}
              onClick={() => {
                if (selected && !disabled) onReview(selected.key);
              }}
              size="sm"
              type="button"
            >
              {busy ? "Preparing review…" : "Review access"}
            </Button>
          ) : null}
          {noAccount ? (
            <Button
              disabled={busy}
              onClick={onOpenConnections}
              size="sm"
              type="button"
            >
              Open Connections
            </Button>
          ) : null}
          <Button
            aria-label={
              phase === "uncertain"
                ? "Check account selection"
                : "Refresh eligible accounts"
            }
            className="ml-auto"
            disabled={busy}
            onClick={onRefresh}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            {phase === "uncertain" ? "Check status" : "Refresh"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
