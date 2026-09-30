import * as React from "react";
import { invokeTauri } from "@/shared/api/tauri";
import { Button } from "@/shared/ui/button";
import { parseWorkContributionCandidateReference } from "@axis/gateway-client";
import type {
  WorkConsentRecord,
  WorkConsentSnapshot,
} from "../lib/workConsent";

/** Transient owner-only view. No result enters message caches or agent context. */
export function WorkConsentResult({
  record,
  snapshot,
}: {
  record: WorkConsentRecord;
  snapshot: WorkConsentSnapshot;
}) {
  const [clientId] = React.useState(() => crypto.randomUUID());
  const [state, setState] = React.useState<{
    phase: "closed" | "loading" | "ready" | "unavailable";
    markdown?: string;
  }>({ phase: "closed" });
  const generation = React.useRef(0);
  const scope = JSON.stringify([
    snapshot.scopeToken,
    snapshot.principalId,
    snapshot.organisationId,
    snapshot.context,
    record.id,
    record.version,
    record.termsDigest,
  ]);
  const scopeRef = React.useRef(scope);
  scopeRef.current = scope;
  React.useEffect(() => {
    const clear = () => {
      generation.current++;
      setState({ phase: "closed" });
      void invokeTauri("spaces_cancel_work_consent", {
        input: { clientId },
      }).catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") clear();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clear();
    };
  }, [clientId, scope]);
  const read = async () => {
    const epoch = ++generation.current;
    const current = () =>
      epoch === generation.current &&
      scopeRef.current === scope &&
      document.visibilityState !== "hidden";
    setState({ phase: "loading" });
    try {
      const response = await invokeTauri<{
        state: string;
        scopeToken: string;
        principalId: string;
        organisationId: string;
        result: { candidate: unknown; markdown: string };
      }>("spaces_read_work_consent_result", {
        input: {
          ...snapshot.context,
          clientId,
          expectedScopeToken: snapshot.scopeToken,
          consentId: record.id,
          ...snapshot.sourceIntents?.[record.id],
        },
      });
      if (!current()) return;
      if (
        response.state !== "ready" ||
        response.scopeToken !== snapshot.scopeToken ||
        response.principalId !== snapshot.principalId ||
        response.organisationId !== snapshot.organisationId
      )
        throw new Error();
      const candidate = await parseWorkContributionCandidateReference(
        response.result.candidate,
      );
      const markdown = response.result.markdown;
      if (
        candidate.execution.consentId !== record.id ||
        candidate.execution.consentVersion !== record.version ||
        candidate.execution.termsDigest !== record.termsDigest ||
        Object.entries(record.terms.task).some(
          ([key, value]) =>
            candidate.task[key as keyof typeof candidate.task] !== value,
        ) ||
        typeof markdown !== "string"
      )
        throw new Error();
      const bytes = new TextEncoder().encode(markdown);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      if (
        bytes.length !== candidate.byteLength ||
        bytes.length > 65_536 ||
        digest !== candidate.contentDigest
      )
        throw new Error();
      if (current()) setState({ phase: "ready", markdown });
    } catch {
      if (current()) setState({ phase: "unavailable" });
    }
  };
  return (
    <section
      aria-label="Private result"
      className="mt-2 rounded-xl border border-border/70 p-4 text-sm"
      data-testid="work-consent-result"
    >
      <h3 className="font-medium">Result · Just for you</h3>
      {state.phase === "ready" ? (
        <>
          <div className="mt-3 whitespace-pre-wrap break-words">
            {state.markdown}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              generation.current++;
              setState({ phase: "closed" });
            }}
          >
            Hide result
          </Button>
        </>
      ) : (
        <>
          {state.phase === "unavailable" && (
            <p role="status">
              The private result could not be opened. Retry viewing it; this
              does not rerun the task.
            </p>
          )}
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            disabled={state.phase === "loading"}
            onClick={() => void read()}
          >
            {state.phase === "loading"
              ? "Opening result…"
              : state.phase === "unavailable"
                ? "Retry viewing result"
                : "View private result"}
          </Button>
        </>
      )}
    </section>
  );
}
