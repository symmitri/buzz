import * as React from "react";
import { Button } from "@/shared/ui/button";
import { IS_SPACES_ALPHA } from "@/shared/lib/product-brand";
import { useWorkRelease } from "../hooks/useWorkRelease";
import { WorkContributionReview } from "./WorkContributionReview";

/** The native source gate returns Unsupported before auth or network access.
 * Separate from account consent; opening a thread never approves or publishes. */
export function WorkReleaseThread({
  channelId,
  rootEventId,
  currentPubkey,
}: {
  channelId: string | null;
  rootEventId: string;
  currentPubkey?: string;
}) {
  const target = React.useMemo(
    () =>
      IS_SPACES_ALPHA && channelId && currentPubkey
        ? { channelId, rootEventId, expectedSignerPubkey: currentPubkey }
        : null,
    [channelId, rootEventId, currentPubkey],
  );
  const release = useWorkRelease(target);
  const scopeKey = JSON.stringify(target);
  const observedReview = React.useRef({ key: scopeKey, present: false });
  if (observedReview.current.key !== scopeKey)
    observedReview.current = { key: scopeKey, present: false };
  if (release.snapshot && release.snapshot.lookup.releases.length > 0)
    observedReview.current.present = true;
  if (!target || !observedReview.current.present || ["idle", "unsupported", "loading"].includes(release.phase))
    return null;
  if (!release.snapshot)
    return (
      <div className="mx-5 my-3 rounded-xl border border-border/70 p-4 text-sm">
        <p role="status">
          Private contribution review is unavailable. Refresh to check your
          current access.
        </p>
        <Button
          type="button"
          className="mt-3"
          size="sm"
          variant="ghost"
          onClick={() => void release.load()}
        >
          Check status
        </Button>
      </div>
    );
  return (
    <div className="mx-5 my-3 space-y-3" data-testid="work-release-thread">
      {release.snapshot.lookup.releases.map((record) => (
        <WorkContributionReview
          key={record.id}
          record={record}
          preview={release.snapshot?.previews[record.id]}
          phase={release.phase === "uncertain" ? "uncertain" : "ready"}
          busy={release.busyId === record.id}
          onPreview={() => void release.preview(record.id)}
          onDecision={(decision) => void release.decide(record.id, decision)}
          onRefresh={() => void release.load()}
        />
      ))}
      {release.snapshot.lookup.truncated ? (
        <p className="text-xs text-muted-foreground">
          Some older contribution reviews are not shown.
        </p>
      ) : null}
    </div>
  );
}
