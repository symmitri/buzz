import { currentWorkTaskStatus, type WorkTaskStatus } from "@axis/gateway-client/work-task-status";
import { WorkConsentPlacement, type WorkConsentTimeline } from "./WorkConsentPlacement";
import { WorkConsentResult } from "./WorkConsentResult";
import type { WorkConsentRecord, WorkConsentSnapshot } from "../lib/workConsent";

/** Real owner-only execution observations. Never pretends an unobserved tool ran. */
export function WorkConsentProgress({ status, record, snapshot, timeline }: {
  status: WorkTaskStatus;
  record: WorkConsentRecord;
  snapshot: WorkConsentSnapshot;
  timeline?: WorkConsentTimeline;
}) {
  const current = currentWorkTaskStatus(status);
  const activity = current.activity;
  const labels = {
    preparing: "Getting started",
    finding_meetings: "Find meetings",
    checking_recordings: "Check recording times",
    reading_notes: `Read notes${activity?.meeting ? ` · meeting ${activity.meeting}` : ""}`,
    reading_transcripts: `Read transcript page${activity?.meeting ? ` · meeting ${activity.meeting}` : ""}`,
  };
  const text = current.state === "running"
    ? activity ? labels[activity.phase] : "Working on your meetings"
    : current.state === "queued" ? "Queued to start"
    : current.state === "failed" ? current.failureReason === "coverage_incomplete"
      ? "I couldn’t read enough of the meetings to finish. There isn’t a draft yet."
      : "I hit a problem before I could finish the draft. I’ve stopped."
    : current.state === "candidate_ready" ? "Your draft is ready to review"
    : "I can’t confirm the latest progress right now.";
  const at = activity?.updatedAt ?? current.updatedAt;
  const content = (
    <div className="my-2 ml-11 space-y-1 text-xs" data-testid="work-consent-progress">
      <div className="flex items-center gap-2 text-2xs text-muted-foreground">
        <span>{snapshot.displays?.[record.id]?.agentLabel ?? "Agent"} · Only you</span>
        {at && <time dateTime={at}>{new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</time>}
      </div>
      <p role="status" data-testid="work-consent-task-status">{text}{activity ? ` · ${{requested:"requested",completed:"done",failed:"failed",unknown:"unconfirmed"}[activity.status]}` : current.state === "running" ? "…" : ""}</p>
      {activity && activity.completedCalls > 0 && <p className="text-2xs text-muted-foreground">Granola · {activity.completedCalls} completed read steps</p>}
      {current.state === "candidate_ready" && <WorkConsentResult record={record} snapshot={snapshot} />}
    </div>
  );
  // No checkpoint means no execution timestamp. Keep uncertainty beside access.
  return at ? <WorkConsentPlacement timeline={timeline} eventAt={at}>{() => content}</WorkConsentPlacement> : content;
}
