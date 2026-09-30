import * as React from "react";
import { LockKeyhole, RefreshCw } from "lucide-react";
import { Button } from "@/shared/ui/button";
import type {
  WorkReleaseDecision,
  WorkReleasePreviewResult,
  WorkReleaseRecord,
} from "../lib/workRelease";

export interface WorkContributionReviewProps {
  record: WorkReleaseRecord;
  preview?: WorkReleasePreviewResult;
  phase: "ready" | "loading" | "uncertain" | "access_lost" | "unavailable";
  busy?: boolean;
  onPreview: () => void;
  onDecision: (decision: WorkReleaseDecision) => void;
  onRefresh: () => void;
}
const titles: Record<WorkReleaseRecord["state"], string> = {
  pending: "Review your contribution",
  approved: "Sharing decision saved",
  declined: "Contribution declined",
  revoked: "Sharing stopped",
  expired: "Review expired",
  stale: "This review has changed",
  publishing: "Sharing your contribution…",
  unknown: "Publication is unconfirmed",
  delivered: "Contribution shared",
};

/** Verbatim preview intentionally creates no links, images, embeds or unfurls. */
export function WorkContributionReview({
  record,
  preview,
  phase,
  busy = false,
  onPreview,
  onDecision,
  onRefresh,
}: WorkContributionReviewProps) {
  const headingId = React.useId();
  const heading = React.useRef<HTMLHeadingElement>(null);
  const section = React.useRef<HTMLElement>(null);
  const submitted = React.useRef(false);
  const [expanded, setExpanded] = React.useState(false);
  const visible = phase === "ready" || phase === "uncertain";
  const expired = Date.parse(record.terms.expiresAt) <= Date.now();
  const exactPreview =
    visible &&
    !expired &&
    ["pending", "approved"].includes(record.state) &&
    preview?.release.id === record.id &&
    preview.release.termsDigest === record.termsDigest &&
    preview.release.version === record.version
      ? preview
      : undefined;
  const pending = record.state === "pending" && !expired;
  // Match the native review prerequisite without rewriting immutable bytes.
  const hiddenControls =
    !!exactPreview &&
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(
      exactPreview.markdown,
    );
  const disabled = busy || phase !== "ready";
  const title = visible
    ? expired && record.state === "pending"
      ? "Review expired"
      : titles[record.state]
    : phase === "access_lost"
      ? "Your access changed"
      : phase === "loading"
        ? "Checking your contribution…"
        : "Contribution review unavailable";
  React.useLayoutEffect(() => {
    if (!submitted.current || busy) return;
    const focused = document.activeElement;
    if (focused === document.body || section.current?.contains(focused))
      heading.current?.focus();
    submitted.current = false;
  }, [record.state, phase, busy]);
  const decide = (decision: WorkReleaseDecision) => {
    if (
      disabled ||
      (decision === "approve" &&
        (!pending ||
          !expanded ||
          !exactPreview ||
          hiddenControls ||
          !record.publicationEnabled))
    )
      return;
    submitted.current = true;
    onDecision(decision);
  };
  return (
    <section
      ref={section}
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
      data-preserve-composer-focus
      className="min-w-0 rounded-xl border border-border/70 bg-background/80 text-sm shadow-xs"
      data-testid="work-contribution-review"
    >
      <div className="space-y-4 p-4">
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <LockKeyhole aria-hidden="true" className="size-3.5" />
          Private review · Just for you
        </p>
        <h3
          ref={heading}
          id={headingId}
          tabIndex={-1}
          className="font-semibold text-foreground"
        >
          {title}
        </h3>
        {visible ? (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Review the complete selected message before sharing it to the
              original thread. Your account-use approval is separate from this
              decision.
            </p>
            <div className="rounded-lg bg-muted/40 p-3 text-xs leading-relaxed">
              <p className="font-medium text-foreground">Who can read this</p>
              <p className="mt-1 text-muted-foreground">
                All admitted members of this realm can read this open channel,
                including silent members and directly admitted Agents
                {record.terms.disclosure.readers ===
                "admitted-realm-members-and-owner-delegated-agents"
                  ? ", plus applicable owner-delegated Agents"
                  : ""}
                . The people active in this thread are not the full audience.
              </p>
              <p className="mt-2 text-muted-foreground">
                After sharing, native history access rules apply. Stopping
                access cannot retract copies or prevent every later history
                reader.
              </p>
            </div>
            {hiddenControls ? (
              <p
                role="alert"
                className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground"
              >
                This selected message contains hidden text controls that this
                preview cannot show safely. Sharing is unavailable for this
                version. The original text has not been changed.
              </p>
            ) : exactPreview ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                  disabled={busy}
                >
                  {expanded ? "Hide selected message" : "Show selected message"}
                </Button>
                {expanded ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Exact selected text, including complete source URLs. Links
                      and media stay inactive in this private preview.
                    </p>
                    <pre
                      className="whitespace-pre-wrap break-words rounded-lg border border-border/60 p-3 font-sans text-sm leading-relaxed"
                      style={{
                        overflowWrap: "anywhere",
                        unicodeBidi: "plaintext",
                      }}
                      data-testid="work-release-preview"
                    >
                      {exactPreview.markdown}
                    </pre>
                  </div>
                ) : null}
              </>
            ) : pending ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  setExpanded(true);
                  onPreview();
                }}
              >
                Review draft
              </Button>
            ) : null}
            {record.state === "approved" ? (
              <p role="status" className="text-xs text-muted-foreground">
                Your decision is recorded. Delivery has not been confirmed.
              </p>
            ) : null}
            {record.state === "unknown" || phase === "uncertain" ? (
              <p
                role="status"
                className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground"
              >
                The outcome is unknown. Check status to reconcile the original
                operation; this does not send another message.
              </p>
            ) : null}
            {!record.publicationEnabled && pending ? (
              <p role="status" className="text-xs text-muted-foreground">
                Sharing is not available yet. This contribution stays private.
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Review expires{" "}
              <time dateTime={record.terms.expiresAt}>
                {new Date(record.terms.expiresAt).toLocaleString()}
              </time>
              .
            </p>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring">
                Review details
              </summary>
              <dl className="mt-2 space-y-2 break-all">
                <div>
                  <dt>Original request</dt>
                  <dd>{record.terms.candidate.task.requestId}</dd>
                </div>
                <div>
                  <dt>Requester</dt>
                  <dd>{record.terms.initiatorId}</dd>
                </div>
                <div>
                  <dt>Contribution owner</dt>
                  <dd>{record.terms.ownerId}</dd>
                </div>
                <div>
                  <dt>Destination</dt>
                  <dd>
                    {record.terms.destination.relayUrl} ·{" "}
                    {record.terms.destination.channelId} ·{" "}
                    {record.terms.destination.rootEventId}
                  </dd>
                </div>
                <div>
                  <dt>Exact message metadata</dt>
                  <dd>
                    <pre className="whitespace-pre-wrap break-all">
                      {JSON.stringify(record.terms.payloadTags, null, 2)}
                    </pre>
                  </dd>
                </div>
                <div>
                  <dt>Selected content digest</dt>
                  <dd>{record.terms.payloadDigest}</dd>
                </div>
              </dl>
            </details>
          </>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            Refresh to check the current owner and thread before showing private
            content.
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 bg-muted/20 px-4 py-3">
        {visible && pending ? (
          <>
            <Button
              type="button"
              size="sm"
              disabled={
                disabled ||
                !expanded ||
                !exactPreview ||
                hiddenControls ||
                !record.publicationEnabled
              }
              onClick={() => decide("approve")}
            >
              Share selected contribution
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => decide("decline")}
            >
              Decline
            </Button>
          </>
        ) : null}
        {visible && ["approved", "stale", "expired"].includes(record.state) ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => decide("revoke")}
          >
            Stop sharing
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={busy}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Check status
        </Button>
      </div>
    </section>
  );
}
