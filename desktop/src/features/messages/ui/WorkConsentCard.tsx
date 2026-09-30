import * as React from "react";
import {
  Check,
  Clock3,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Users,
} from "lucide-react";

import { ConnectionProviderLogo } from "@/features/settings/ui/ConnectionProviderLogo";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

/** Presentation only. The authenticated work-consent adapter owns these terms. */
export interface WorkConsentCardView {
  executionUnavailable?: boolean;
  phase:
    | "loading"
    | "ready"
    | "uncertain"
    | "access-lost"
    | "unavailable"
    | "no-account";
  consentState?:
    | "pending"
    | "approved"
    | "declined"
    | "revoked"
    | "expired"
    | "stale";
  terms?: {
    taskLabel: string;
    agentLabel: string;
    initiatorLabel: string;
    /** Verified work binding. This is not a statement about all channel readers. */
    executionScopeLabel: string;
    providerId: string;
    providerLabel: string;
    accountLabel: string;
    actions: readonly string[];
    windowLabel: string;
    selectionLabel: string;
    /** Owner-private results; any later sharing requires a separate reviewed audience. */
    outputPolicyLabel: string;
    expiresAt: string;
    expiresAtLabel: string;
    limits?: readonly string[];
  };
  /** Only the native adapter may offer decisions for the current authoritative record. */
  availableDecisions: readonly ("approve" | "decline" | "revoke")[];
  busyDecision?: "approve" | "decline" | "revoke" | null;
  /** Current owner-private task status; approval itself never implies progress. */
  taskStatusLabel?: string;
}

export interface WorkConsentCardProps {
  view: WorkConsentCardView;
  onDecision: (decision: "approve" | "decline" | "revoke") => void;
  onRefresh: () => void;
  onOpenConnections: () => void;
}

const STATE_COPY = {
  pending: [
    "Review personal access",
    "Authorize access for this task using the details below.",
  ],
  approved: [
    "Access approved",
    "Your approval is saved for this task. You can stop further access at any time.",
  ],
  declined: [
    "Access declined",
    "Your account access was not approved for this task.",
  ],
  revoked: [
    "Access stopped",
    "Your account can no longer be used for this task.",
  ],
  expired: ["Access expired", "This request has reached its expiry time."],
  stale: [
    "Access is no longer valid",
    "Required permissions are unavailable or have changed. This approval cannot be used. Review current access before authorizing again.",
  ],
} as const;

/** Owner-private access review mounted in the existing native message thread. */
export function WorkConsentCard({
  view,
  onDecision,
  onRefresh,
  onOpenConnections,
}: WorkConsentCardProps) {
  const headingId = React.useId();
  const sectionRef = React.useRef<HTMLElement>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [expanded, setExpanded] = React.useState(false);
  const decisionFocus = React.useRef<
    WorkConsentCardView["consentState"] | null
  >(null);
  const { phase, consentState = "pending", busyDecision } = view;
  React.useEffect(() => { setExpanded(false); }, [consentState]);
  // Do not render retained private props while identity or current access is unknown.
  const terms =
    view.consentState && (phase === "ready" || phase === "uncertain")
      ? view.terms
      : undefined;
  const busy = Boolean(busyDecision) || phase === "loading";
  const decisions = phase === "ready" && terms ? view.availableDecisions.filter(decision => !view.executionUnavailable || decision !== "approve") : [];
  const [savedTitle, savedDescription] = STATE_COPY[consentState];
  const approvalUnconfirmed = phase === "uncertain" && consentState === "approved";
  const title = view.executionUnavailable ? `${terms?.agentLabel ?? "The agent"} is not ready to use this account` : approvalUnconfirmed ? "Current access unconfirmed" : savedTitle;
  const description = view.executionUnavailable
    ? "Required execution access is unavailable. No approval was saved. You can decline this request or refresh it after setup is corrected."
    : approvalUnconfirmed
    ? "An approval was previously saved. Current access and task progress could not be confirmed."
    : savedDescription;
  React.useLayoutEffect(() => {
    if (
      busy ||
      decisionFocus.current === null ||
      (phase === "ready" && decisionFocus.current === consentState)
    )
      return;
    // Recover focus when the activated control disappears, but leave an active chat draft alone.
    const focused = document.activeElement;
    if (
      focused === document.body ||
      (focused && sectionRef.current?.contains(focused))
    )
      headingRef.current?.focus();
    decisionFocus.current = null;
  }, [busy, phase, consentState]);
  const decide = (decision: "approve" | "decline" | "revoke") => {
    decisionFocus.current = consentState;
    setExpanded(false);
    onDecision(decision);
  };

  return (
    <section
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-background/80 text-sm shadow-xs"
      data-testid="work-consent-card"
      data-preserve-composer-focus=""
      ref={sectionRef}
    >
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <LockKeyhole aria-hidden="true" className="size-3.5" />
          <span>Just for you</span>
        </div>

        {terms ? (
          <>
            <div className="space-y-1.5">
              <h3
                className="flex items-center gap-2 font-semibold text-foreground"
                id={headingId}
                ref={headingRef}
                tabIndex={-1}
              >
                {consentState === "approved" && !approvalUnconfirmed ? (
                  <Check aria-hidden="true" className="size-4 text-primary" />
                ) : null}
                {title}
              </h3>
              <p className="break-words text-xs text-muted-foreground">
                {terms.accountLabel} · {terms.providerLabel}
              </p>
            </div>
            <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
              <summary className="cursor-pointer rounded-sm text-xs font-medium text-muted-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring">
                {expanded ? "Hide details" : "See details"}
              </summary>
              <div className="mt-3 space-y-4">
              <p className="break-words leading-relaxed text-muted-foreground">
                {terms.taskLabel}
              </p>
              <p className="break-words text-xs leading-relaxed text-muted-foreground">
                Requested by {terms.initiatorLabel} ·{" "}
                {terms.executionScopeLabel}
              </p>

            <div className="flex min-w-0 items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
              <ConnectionProviderLogo provider={terms.providerId} />
              <div className="min-w-0 space-y-0.5">
                <p className="break-words font-medium text-foreground">
                  {terms.providerLabel}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {terms.accountLabel}
                </p>
              </div>
            </div>

            <dl className="space-y-3.5 text-xs leading-relaxed">
              <div className="flex gap-2.5">
                <ShieldCheck
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 space-y-1">
                  <dt className="font-medium text-foreground">
                    {approvalUnconfirmed ? "Previously approved reads" : consentState === "approved"
                      ? `${terms.agentLabel} can`
                      : `Requested for ${terms.agentLabel}`}
                  </dt>
                  <dd className="space-y-0.5 break-words text-muted-foreground">
                    {terms.actions.map((action) => (
                      <p key={action}>{action}</p>
                    ))}
                  </dd>
                </div>
              </div>
              <div className="flex gap-2.5">
                <Clock3
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 space-y-1">
                  <dt className="font-medium text-foreground">
                    {terms.selectionLabel}
                  </dt>
                  <dd className="break-words text-muted-foreground">
                    {terms.windowLabel}
                  </dd>
                </div>
              </div>
              <div className="flex gap-2.5">
                <Users
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 space-y-1">
                  <dt className="font-medium text-foreground">
                    You review before sharing
                  </dt>
                  <dd className="break-words text-muted-foreground">
                    {terms.outputPolicyLabel}
                  </dd>
                </div>
              </div>
            </dl>

            {terms.limits?.length ? (
              <details className="text-xs leading-relaxed text-muted-foreground">
                <summary className="cursor-pointer rounded-sm font-medium outline-hidden focus-visible:ring-1 focus-visible:ring-ring">
                  Access limits
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {terms.limits.map((limit) => (
                    <li className="break-words" key={limit}>
                      {limit}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
              </div>
            </details>

            <p className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
              {consentState === "pending" || consentState === "approved"
                ? "Access ends "
                : "Request expiry "}
              <time className="text-foreground" dateTime={terms.expiresAt}>
                {terms.expiresAtLabel}
              </time>
            </p>
            {consentState !== "pending" || view.executionUnavailable ? (
              <p
                className="text-xs leading-relaxed text-muted-foreground"
                role="status"
              >
                {description}
              </p>
            ) : null}
            {consentState === "approved" && view.taskStatusLabel ? (
              <p
                className="text-xs font-medium text-foreground"
                role="status"
                data-testid="work-consent-task-status"
              >
                {phase === "ready"
                  ? view.taskStatusLabel
                  : "Status unconfirmed"}
              </p>
            ) : null}
          </>
        ) : (
          <div className="space-y-1.5">
            <h3
              className="font-semibold text-foreground"
              id={headingId}
              ref={headingRef}
              tabIndex={-1}
            >
              {phase === "loading"
                ? "Checking personal access…"
                : phase === "no-account"
                  ? "Connect an account to continue"
                  : phase === "access-lost"
                    ? "Check your account access"
                    : "Personal access is unavailable"}
            </h3>
            <p
              className="text-xs leading-relaxed text-muted-foreground"
              role="status"
            >
              {phase === "loading"
                ? "Your conversation is ready while we check this request."
                : phase === "no-account"
                  ? "Open Connections in your profile, then return to this task."
                  : phase === "access-lost"
                    ? "Your account access changed. Refresh to check this request."
                    : "This request could not be checked. Refresh to try again."}
            </p>
          </div>
        )}

        {phase === "uncertain" ? (
          <p
            className="rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
            role="status"
          >
            We couldn’t confirm the result. Check status before trying again.
          </p>
        ) : null}
      </div>

      {phase !== "loading" ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-muted/20 px-4 py-3">
          {decisions.includes("approve") && consentState === "pending" ? (
            <Button
              disabled={busy}
              onClick={() => decide("approve")}
              size="sm"
              type="button"
            >
              {busyDecision === "approve" ? "Saving approval…" : "Authorize"}
            </Button>
          ) : null}
          {decisions.includes("decline") ? (
            <Button
              disabled={busy}
              onClick={() => decide("decline")}
              size="sm"
              type="button"
              variant="outline"
            >
              {busyDecision === "decline" ? "Saving decision…" : "Decline"}
            </Button>
          ) : null}
          {decisions.includes("revoke") ? (
            <Button
              disabled={busy}
              onClick={() => decide("revoke")}
              size="sm"
              type="button"
              variant="outline"
            >
              {busyDecision === "revoke" ? "Stopping access…" : "Stop access"}
            </Button>
          ) : null}
          {phase === "no-account" ? (
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
                ? "Check access status"
                : "Refresh personal access"
            }
            className={cn(decisions.length > 0 && "ml-auto")}
            disabled={busy}
            onClick={onRefresh}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
            {view.executionUnavailable ? "Refresh request" : phase === "uncertain" ? "Check status" : "Refresh"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
