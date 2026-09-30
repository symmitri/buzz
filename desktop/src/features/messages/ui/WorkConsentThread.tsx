import * as React from "react";
import type { WorkConsentIntentAccount } from "@axis/gateway-client";
import { currentWorkTaskStatus } from "@axis/gateway-client/work-task-status";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { Button } from "@/shared/ui/button";
import { IS_SPACES_ALPHA } from "@/shared/lib/product-brand";
import { useWorkConsent } from "../hooks/useWorkConsent";
import type { WorkConsentDisplay, WorkConsentRecord } from "../lib/workConsent";
import { WorkConsentCard, type WorkConsentCardView } from "./WorkConsentCard";
import { WorkConsentAccountCard } from "./WorkConsentAccountCard";

const accountKey = (account: WorkConsentIntentAccount) =>
  JSON.stringify([
    account.accountId,
    account.accountVersion,
    account.connectionId,
  ]);

function time(value: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

/** Mapping of already authenticated native terms; labels confer no permission. */
function review(
  record: WorkConsentRecord,
  principalId: string,
  display?: WorkConsentDisplay,
): WorkConsentCardView["terms"] {
  const { terms } = record;
  const { scope } = terms;
  let windowLabel: string;
  let expiresAtLabel: string;
  try {
    windowLabel = `${time(scope.meetingStart, scope.timeZone)} – ${time(scope.meetingEnd, scope.timeZone)} · ${scope.timeZone}`;
    expiresAtLabel = time(terms.expiresAt, scope.timeZone);
  } catch {
    return undefined;
  }
  return {
    taskLabel: terms.taskSummary,
    agentLabel: display?.agentLabel ?? terms.task.agentId,
    initiatorLabel:
      terms.task.requesterId === principalId
        ? "you"
        : (display?.initiatorLabel ?? terms.task.requesterId),
    executionScopeLabel: "For this task in the original conversation",
    providerId: terms.provider,
    providerLabel: "Granola",
    accountLabel:
      [
        ...new Set(
          [display?.accountLabel, display?.accountEmail].filter(Boolean),
        ),
      ].join(" · ") || "Your Granola account (account details unavailable)",
    actions: [
      ...(scope.allowRecordingTimeProbes
        ? ["Check recording timestamps to identify eligible meetings"]
        : []),
      ...(scope.allowedTools.includes("list_notes")
        ? [
            scope.selection === "day_meetings"
              ? "Find and read this day’s recordings, including duplicates, to identify the meetings requested"
              : scope.selection === "latest_meetings"
              ? `Find up to ${scope.maxNotes} meetings within this window`
              : "Find the selected notes",
          ]
        : []),
      ...(scope.allowedTools.includes("get_note")
        ? [
            scope.includeTranscript
              ? "Read their notes and transcripts"
              : "Read their notes",
          ]
        : []),
    ],
    windowLabel,
    selectionLabel:
      scope.selection === "day_meetings"
        ? "Meetings from this calendar day; the task determines which distinct meetings to use"
        : scope.selection === "latest_meetings"
        ? `Up to ${scope.maxNotes} latest meetings in this window, with verified recording-time evidence`
        : `Only the selected notes: ${scope.noteIds.join(", ")}`,
    outputPolicyLabel:
      "Notes and results stay private to you. You review any draft and who can see it before sharing.",
    limits: [
      ...(scope.selection === "day_meetings" ? ["Day-wide access does not change the task’s first/latest selection. Timestamp discovery may inspect recording pages outside the day; only eligible day recordings enter the private task.", `Up to ${scope.maxNotes} day recordings within the limits below; incomplete coverage is reported, never silently treated as all meetings.`] : []),
      `Search up to ${scope.maxListPages * scope.pageSize} meeting entries (${scope.maxListPages} pages of ${scope.pageSize})`,
      scope.allowRecordingTimeProbes
        ? `Recording-time checks: up to ${scope.maxProbePagesPerNote} pages per meeting; only timestamps are used`
        : "Recording-time checks are not included",
      scope.includeTranscript
        ? `Transcripts: up to ${scope.maxTranscriptPagesPerNote} pages per selected meeting; a recording may continue beyond the selection window`
        : "Transcript text is not included",
      `Up to ${scope.maxProviderCalls} account requests and ${scope.maxBytes.toLocaleString()} bytes in total`,
      "If these limits prevent verification, the result may be incomplete. Access never expands automatically.",
    ],
    expiresAt: terms.expiresAt,
    expiresAtLabel,
  };
}

/** Native thread attachment. The native/server capability gate defaults closed. */
export function WorkConsentThread({
  channelId,
  rootEventId,
  currentPubkey,
}: {
  channelId: string | null;
  rootEventId: string;
  currentPubkey?: string;
}) {
  const { goSettings } = useAppNavigation();
  const target = React.useMemo(
    () =>
      IS_SPACES_ALPHA && channelId && currentPubkey
        ? { channelId, rootEventId, expectedSignerPubkey: currentPubkey }
        : null,
    [channelId, rootEventId, currentPubkey],
  );
  const consent = useWorkConsent(target);
  const snapshot = consent.snapshot;
  const selectionFocus = React.useRef<{
    intentId: string;
    element: Element | null;
  } | null>(null);
  const consentElements = React.useRef(new Map<string, HTMLDivElement>());
  const intentElements = React.useRef(new Map<string, HTMLDivElement>());
  React.useLayoutEffect(() => {
    if (!snapshot) {
      selectionFocus.current = null;
      return;
    }
    const selected = selectionFocus.current;
    if (!selected || consent.busyIntentId) return;
    const bound = snapshot?.intentOwners?.[selected.intentId]?.consent;
    const result = bound
      ? consentElements.current.get(bound.id)
      : consent.intentPhase !== "ready"
        ? intentElements.current.get(selected.intentId)
        : undefined;
    if (!result) return;
    if (
      document.activeElement === document.body ||
      document.activeElement === selected.element
    )
      result.querySelector("h3")?.focus();
    selectionFocus.current = null;
  }, [snapshot, consent.busyIntentId, consent.intentPhase]);
  const connections = () => {
    void goSettings("profile", { profileTab: "connections" });
  };
  if (
    !target ||
    consent.phase === "idle" ||
    consent.phase === "unsupported"
  )
    return null;
  if (consent.phase === "loading" && !snapshot) {
    return <p className="mx-5 my-3 text-sm text-muted-foreground" role="status">Checking personal access requests…</p>;
  }
  if (!snapshot) {
    return (
      <div className="mx-5 my-3">
        <WorkConsentCard
          view={{
            phase:
              consent.phase === "access_lost" ? "access-lost" : "unavailable",
            availableDecisions: [],
          }}
          onDecision={() => {}}
          onRefresh={() => void consent.load()}
          onOpenConnections={connections}
        />
      </div>
    );
  }
  const threadIntents = [...(snapshot.intentLookup?.intents ?? [])];
  const selectedOwner = snapshot.selectedIntentId
    ? snapshot.intentOwners?.[snapshot.selectedIntentId]
    : undefined;
  // Recovery reads may return the selected intent after it leaves discovery.
  if (
    selectedOwner &&
    !threadIntents.some((intent) => intent.id === selectedOwner.intent.id)
  )
    threadIntents.push(selectedOwner.intent);
  return (
    <div className="mx-5 my-3 space-y-3" data-testid="work-consent-thread">
      {threadIntents.map((listedIntent) => {
        const owner = snapshot.intentOwners?.[listedIntent.id];
        const intent = owner?.intent ?? listedIntent;
        // A previous binding is permanent for this owner and intent. Terminal
        // consent belongs to the existing cleanup card, never a new choice.
        if (owner?.consent) return null;
        const requesterLabel =
          intent.terms.task.requesterId === snapshot.principalId
            ? "you"
            : (snapshot.intentDisplays?.[intent.id]?.initiatorLabel ??
              intent.terms.task.requesterId);
        const expired = Date.parse(intent.terms.expiresAt) <= Date.now();
        const selected = consent.selectedIntentId === intent.id;
        const terminal =
          expired || intent.state === "expired"
            ? "expired"
            : intent.state === "stale"
              ? "stale"
              : null;
        const pending = consent.pendingSelections[intent.id];
        const busy = Boolean(consent.busyId || consent.busyIntentId);
        return (
          <div
            key={intent.id}
            ref={(element) => {
              if (element) intentElements.current.set(intent.id, element);
              else intentElements.current.delete(intent.id);
            }}
          >
            {selected || terminal || consent.phase === "loading" ? (
              <WorkConsentAccountCard
                scopeKey={JSON.stringify([
                  snapshot.scopeToken,
                  snapshot.principalId,
                  snapshot.organisationId,
                  intent.id,
                  intent.version,
                  intent.digest,
                ])}
                phase={
                  consent.phase === "loading"
                    ? "loading"
                    : pending
                      ? "uncertain"
                      : (terminal ??
                        (consent.intentPhase === "uncertain"
                          ? "uncertain"
                          : consent.intentPhase === "unavailable"
                            ? "unavailable"
                            : owner
                              ? "ready"
                              : "loading"))
                }
                taskSummary={intent.terms.taskSummary}
                requesterLabel={requesterLabel}
                accounts={(owner?.accounts ?? []).map((account) => ({
                  key: accountKey(account),
                  provider: account.provider,
                  providerLabel: "Granola",
                  label: account.label ?? account.email ?? "Granola account",
                  email: account.email,
                }))}
                busy={busy}
                onReview={(key) => {
                  const account = owner?.accounts.find(
                    (candidate) => accountKey(candidate) === key,
                  );
                  if (!account || terminal || pending || busy) return;
                  selectionFocus.current = {
                    intentId: intent.id,
                    element: document.activeElement,
                  };
                  void consent.selectAccount(intent.id, account);
                }}
                onRetry={
                  pending
                    ? () => {
                        selectionFocus.current = {
                          intentId: intent.id,
                          element: document.activeElement,
                        };
                        void consent.retrySelection(intent.id);
                      }
                    : undefined
                }
                onRefresh={() => void consent.loadIntent(intent.id)}
                onOpenConnections={connections}
              />
            ) : (
              <section className="space-y-3 rounded-xl border border-border/70 p-4 text-sm">
                <h3 className="break-words font-medium">
                  {intent.terms.taskSummary}
                </h3>
                <p className="text-xs text-muted-foreground">
                  Requested by {requesterLabel}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={consent.phase !== "ready" || busy}
                  onClick={() => void consent.loadIntent(intent.id)}
                >
                  Review account
                </Button>
              </section>
            )}
          </div>
        );
      })}
      {snapshot.lookup.requests.map((record) => {
        const executionUnavailable = record.state === "pending" && snapshot.executionUnavailableConsents?.includes(record.id);
        const unconfirmed = snapshot.unconfirmedConsents?.includes(record.id);
        const phase =
          consent.phase === "uncertain" || unconfirmed
            ? "uncertain"
            : consent.phase === "loading"
              ? "loading"
              : "ready";
        const expired = Date.parse(record.terms.expiresAt) <= Date.now();
        const projection = snapshot.taskStatusLookup;
        const status =
          record.state === "approved" &&
          !expired &&
          !unconfirmed &&
          snapshot.statusPhase === "ready" &&
          projection?.ownerId === snapshot.principalId &&
          projection.orgId === snapshot.organisationId &&
          projection.workId === record.terms.task.workId
            ? projection.statuses.find(
                (value) =>
                  value.consentId === record.id &&
                  value.consentVersion === record.version &&
                  value.termsDigest === record.termsDigest,
              )
            : undefined;
        const taskState = status
          ? currentWorkTaskStatus(status).state
          : "unconfirmed";
        const taskStatusLabel =
          taskState === "queued"
            ? "Waiting to start"
            : taskState === "running"
              ? "Working privately"
              : taskState === "candidate_ready"
                ? "Ready to review"
              : taskState === "failed"
                  ? status?.failureReason === "coverage_incomplete"
                    ? "Could not verify complete recording coverage within the approved limits. No complete meeting selection was claimed."
                    : "Could not prepare private contribution"
                  : "Status unconfirmed";
        const terms = review(
          record,
          snapshot.principalId,
          snapshot.displays?.[record.id],
        );
        return (
          <div
            key={record.id}
            ref={(element) => {
              if (element) consentElements.current.set(record.id, element);
              else consentElements.current.delete(record.id);
            }}
          >
            <WorkConsentCard
              view={{
                executionUnavailable,
                phase: terms ? phase : "unavailable",
                consentState:
                  expired &&
                  (record.state === "pending" || record.state === "approved")
                    ? "expired"
                    : record.state,
                terms,
                taskStatusLabel,
                availableDecisions: unconfirmed
                  ? []
                  : consent.pendingDecisions[record.id]
                    ? expired &&
                      consent.pendingDecisions[record.id].decision === "approve"
                      ? []
                      : [consent.pendingDecisions[record.id].decision]
                    : record.state === "pending"
                      ? expired
                        ? ["decline"]
                        : executionUnavailable ? ["decline"] : ["approve", "decline"]
                      : record.state === "approved" ||
                          record.state === "stale" ||
                          record.state === "expired"
                        ? ["revoke"]
                        : [],
                busyDecision:
                  consent.busyId === record.id ? consent.decision : null,
              }}
              onDecision={(decision) =>
                void consent.decide(record.id, decision)
              }
              onRefresh={() => executionUnavailable ? consent.refreshAfterSetup() : void consent.load()}
              onOpenConnections={connections}
            />
          </div>
        );
      })}
      {snapshot.lookup.requests.length === 0 &&
      !threadIntents.length &&
      consent.intentPhase === "unavailable" ? (
        <div className="rounded-xl border border-border/70 p-4 text-sm">
          <p role="status">We couldn’t check account requests for this task.</p>
          <Button
            className="mt-3"
            variant="outline"
            size="sm"
            onClick={() => void consent.load()}
          >
            Refresh account requests
          </Button>
        </div>
      ) : null}
      {snapshot.lookup.requests.length === 0 &&
      threadIntents.length === 0 &&
       snapshot.intentLookup?.intents.length === 0 &&
       consent.intentPhase === "ready" && consent.phase === "ready" ? (
        <div className="rounded-xl border border-border/70 p-4 text-sm">
          <p>No personal access request is waiting for you in this thread.</p>
          <Button
            className="mt-3"
            variant="outline"
            size="sm"
            onClick={() => void consent.load()}
          >
            Refresh account requests
          </Button>
        </div>
      ) : null}
      {snapshot.intentBefore || snapshot.intentLookup?.next ? (
        <div className="flex flex-wrap items-center gap-2">
          {snapshot.intentBefore ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={
                consent.phase !== "ready" ||
                Boolean(consent.busyId || consent.busyIntentId)
              }
              onClick={() => void consent.loadIntentPage()}
            >
              Back to latest account requests
            </Button>
          ) : null}
          {snapshot.intentLookup?.next ? (
            <Button
              variant="outline"
              size="sm"
              disabled={
                consent.phase !== "ready" ||
                Boolean(consent.busyId || consent.busyIntentId)
              }
              onClick={() =>
                void consent.loadIntentPage(snapshot.intentLookup?.next)
              }
            >
              Older account requests
            </Button>
          ) : null}
        </div>
      ) : null}
      {snapshot.context.before || snapshot.lookup.next ? (
        <div className="flex flex-wrap items-center gap-2">
          {snapshot.context.before ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={
                consent.phase !== "ready" ||
                Boolean(consent.busyId || consent.busyIntentId)
              }
              onClick={() => consent.loadPage()}
            >
              Back to latest requests
            </Button>
          ) : null}
          {snapshot.lookup.next ? (
            <Button
              variant="outline"
              size="sm"
              disabled={
                consent.phase !== "ready" ||
                Boolean(consent.busyId || consent.busyIntentId)
              }
              onClick={() => consent.loadPage(snapshot.lookup.next)}
            >
              Older access requests
            </Button>
          ) : null}
        </div>
      ) : null}
      {snapshot.lookup.participants.length > 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="work-consent-participants"
        >
          {[
            ["pending", "reviewing access"],
            ["approved", "access approved"],
            ["inactive", "access inactive"],
          ]
            .flatMap(([state, label]) => {
              const count = snapshot.lookup.participants.filter(
                (participant) =>
                  state === "inactive"
                    ? !["pending", "approved"].includes(participant.state)
                    : participant.state === state,
              ).length;
              return count
                ? [
                    `${count} other ${count === 1 ? "person" : "people"}: ${label}`,
                  ]
                : [];
            })
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
