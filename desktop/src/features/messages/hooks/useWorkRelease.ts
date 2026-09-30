import * as React from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeTauri } from "@/shared/api/tauri";
import {
  parseWorkReleaseLookup,
  parseWorkReleasePreview,
  parseWorkReleaseDecisionResult,
} from "@axis/gateway-client/work-release";
import type {
  WorkReleaseContext,
  WorkReleaseContextResult,
  WorkReleaseDecision,
  WorkReleaseDecisionInput,
  WorkReleaseIdentity,
  WorkReleaseLookupResult,
  WorkReleaseNativeResult,
  WorkReleasePreviewResult,
  WorkReleaseTarget,
} from "../lib/workRelease";

type Phase =
  | "idle"
  | "loading"
  | "ready"
  | "unsupported"
  | "unavailable"
  | "access_lost"
  | "uncertain";
type Snapshot = WorkReleaseIdentity & {
  context: WorkReleaseContext;
  lookup: WorkReleaseLookupResult;
  previews: Record<string, WorkReleasePreviewResult>;
};
type State = {
  key: string;
  phase: Phase;
  snapshot: Snapshot | null;
  busyId: string | null;
};
const empty = (key: string, phase: Phase): State => ({
  key,
  phase,
  snapshot: null,
  busyId: null,
});
const visible = () => document.visibilityState !== "hidden";
const same = (a: WorkReleaseIdentity, b: WorkReleaseIdentity) =>
  a.scopeToken === b.scopeToken &&
  a.principalId === b.principalId &&
  a.organisationId === b.organisationId;
const owner = (identity: WorkReleaseIdentity) => ({
  identityId: identity.principalId,
  orgId: identity.organisationId,
});
// Publication reconciliation may outlive private task authority. Only these
// Gateway-projected states still permit restoring selected private bytes.
const active = (state: string) => ["pending", "approved"].includes(state);

/** Fixed native actions; no provider, model, shared-message, or publication calls. */
export function useWorkRelease(target: WorkReleaseTarget | null) {
  const key = target
    ? JSON.stringify([
        target.channelId,
        target.rootEventId,
        target.expectedSignerPubkey,
      ])
    : "";
  const targetRef = React.useRef(target);
  targetRef.current = target;
  const keyRef = React.useRef(key);
  keyRef.current = key;
  const generation = React.useRef(0);
  const snapshotRef = React.useRef<Snapshot | null>(null);
  const pending = React.useRef(new Map<string, WorkReleaseDecisionInput>());
  const busy = React.useRef(false);
  const [clientId] = React.useState(() => crypto.randomUUID());
  const [state, setState] = React.useState<State>(() => empty(key, "idle"));
  const listening = React.useRef<Promise<boolean>>(Promise.resolve(false));
  const cancelBarrier = React.useRef<Promise<unknown>>(Promise.resolve());
  const cancel = React.useCallback(() => {
    cancelBarrier.current = cancelBarrier.current
      .then(() =>
        invokeTauri("spaces_cancel_work_release", { input: { clientId } }),
      )
      .catch(() => {});
  }, [clientId]);
  const clear = React.useCallback(
    (phase: Phase) => {
      generation.current++;
      snapshotRef.current = null;
      pending.current.clear();
      busy.current = false;
      setState(empty(keyRef.current, phase));
      cancel();
    },
    [cancel],
  );

  const load = React.useCallback(async () => {
    const currentTarget = targetRef.current,
      currentKey = keyRef.current;
    if (!currentTarget || !visible() || busy.current) return;
    const epoch = ++generation.current;
    const valid = () =>
      generation.current === epoch &&
      keyRef.current === currentKey &&
      visible();
    const previous = snapshotRef.current;
    if (!previous) setState(empty(currentKey, "loading"));
    await cancelBarrier.current;
    if (!(await listening.current) || !valid()) {
      if (valid()) clear("unavailable");
      return;
    }
    try {
      const context = await invokeTauri<WorkReleaseContextResult>(
        "spaces_work_release_context",
        { input: currentTarget },
      );
      if (!valid()) return;
      if (context.state !== "ready") {
        clear(context.state === "conflict" ? "unavailable" : context.state);
        return;
      }
      if (
        context.context.channelId !== currentTarget.channelId ||
        context.context.rootEventId !== currentTarget.rootEventId ||
        context.context.expectedSignerPubkey !==
          currentTarget.expectedSignerPubkey
      ) {
        clear("access_lost");
        return;
      }
      const result = await invokeTauri<WorkReleaseNativeResult>(
        "spaces_query_work_releases",
        {
          input: {
            ...context.context,
            clientId,
            ...(previous ? { expectedScopeToken: previous.scopeToken } : {}),
          },
        },
      );
      if (!valid()) return;
      if (result.state !== "ready" || !result.lookup) {
        clear(
          result.state === "access_lost"
            ? "access_lost"
            : result.state === "unsupported"
              ? "unsupported"
              : "unavailable",
        );
        return;
      }
      if (previous && !same(previous, result)) {
        clear("access_lost");
        return;
      }
      const lookup = await parseWorkReleaseLookup(result.lookup, owner(result));
      const previews: Record<string, WorkReleasePreviewResult> = {};
      for (const record of lookup.releases) {
        const d = record.terms.destination;
        if (
          d.channelId !== currentTarget.channelId ||
          d.rootEventId !== currentTarget.rootEventId ||
          d.relayUrl !==
            context.context.expectedRelayUrl.replace(/^wss:/, "https:")
        )
          throw new Error("changed native thread");
        const cached = result.previews?.[record.id];
        if (
          cached &&
          active(record.state) &&
          Date.parse(record.terms.expiresAt) > Date.now()
        ) {
          const checked = await parseWorkReleasePreview(cached, {
            ...owner(result),
            workId: lookup.workId,
            releaseId: record.id,
          });
          if (
            checked.release.termsDigest === record.termsDigest &&
            checked.release.version === record.version
          )
            previews[record.id] = checked;
        }
      }
      if (!valid()) return;
      pending.current = new Map(Object.entries(result.pendingDecisions ?? {}));
      const next: Snapshot = {
        ...result,
        context: context.context,
        lookup,
        previews,
      };
      snapshotRef.current = next;
      setState({ ...empty(currentKey, "ready"), snapshot: next });
    } catch {
      if (valid()) clear("unavailable");
    }
  }, [clear, clientId]);

  React.useEffect(() => {
    let disposed = false;
    const listener = listen("spaces-connections-invalidated", () => {
      if (!disposed) clear("access_lost");
    });
    listening.current = listener.then(
      (unlisten) => {
        if (disposed) {
          unlisten();
          return false;
        }
        return true;
      },
      () => false,
    );
    return () => {
      disposed = true;
      void listener.then((fn) => fn()).catch(() => {});
    };
  }, [clear]);
  React.useEffect(() => {
    clear("idle");
    if (key) void load();
    const wake = () => {
      if (visible()) void load();
      else clear("idle");
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    const poll = window.setInterval(() => {
      if (visible()) void load();
    }, 15_000);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      window.clearInterval(poll);
      generation.current++;
      snapshotRef.current = null;
      busy.current = false;
      pending.current.clear();
      cancel();
    };
  }, [key, clear, load, cancel]);
  const expiresAt =
    state.snapshot?.lookup.releases.reduce((next, record) => {
      const time = Date.parse(record.terms.expiresAt);
      return time > Date.now() ? Math.min(next, time) : next;
    }, Infinity) ?? Infinity;
  React.useEffect(() => {
    if (!Number.isFinite(expiresAt)) return;
    const timer = window.setTimeout(
      () => {
        clear("idle");
        if (visible()) void load();
      },
      Math.max(1, Math.min(2_147_483_647, expiresAt - Date.now())),
    );
    return () => window.clearTimeout(timer);
  }, [expiresAt, clear, load]);

  const act = React.useCallback(
    async (releaseId: string, decision?: WorkReleaseDecision) => {
      const snapshot = snapshotRef.current;
      const record = snapshot?.lookup.releases.find(
        (item) => item.id === releaseId,
      );
      if (
        !snapshot ||
        !record ||
        busy.current ||
        !visible() ||
        state.phase !== "ready" ||
        state.key !== keyRef.current
      )
        return;
      if (
        decision === "approve" &&
        (!snapshot.previews[releaseId] ||
          !record.publicationEnabled ||
          record.state !== "pending" ||
          Date.parse(record.terms.expiresAt) <= Date.now())
      )
        return;
      const previous = pending.current.get(releaseId);
      if (decision && previous && previous.decision !== decision) return;
      const intent = decision
        ? (previous ?? {
            operationId: crypto.randomUUID(),
            expectedVersion: record.version,
            termsDigest: record.termsDigest,
            payloadDigest: record.terms.payloadDigest,
            decision,
          })
        : undefined;
      if (intent) pending.current.set(releaseId, intent);
      const currentKey = keyRef.current,
        epoch = ++generation.current;
      const valid = () =>
        keyRef.current === currentKey &&
        generation.current === epoch &&
        visible();
      busy.current = true;
      setState({
        key: currentKey,
        phase: "ready",
        snapshot,
        busyId: releaseId,
      });
      try {
        const result = await invokeTauri<WorkReleaseNativeResult>(
          decision
            ? "spaces_decide_work_release"
            : "spaces_preview_work_release",
          {
            input: {
              ...snapshot.context,
              expectedScopeToken: snapshot.scopeToken,
              clientId,
              releaseId,
              ...intent,
            },
          },
        );
        if (!valid()) return;
        if (result.state === "access_lost") {
          clear("access_lost");
          return;
        }
        let next = snapshot;
        if (result.state === "confirmed" && intent) {
          if (!same(snapshot, result)) {
            clear("access_lost");
            return;
          }
          const checked = await parseWorkReleaseDecisionResult(result.result, {
            ...owner(snapshot),
            workId: snapshot.lookup.workId,
            releaseId,
            ...intent,
          });
          if (!valid()) return;
          pending.current.delete(releaseId);
          const previews = { ...snapshot.previews };
          delete previews[releaseId];
          next = {
            ...snapshot,
            previews,
            lookup: {
              ...snapshot.lookup,
              releases: snapshot.lookup.releases.map((item) =>
                item.id === releaseId ? checked.release : item,
              ),
            },
          };
        } else if (result.state === "ready" && result.preview && !decision) {
          if (!same(snapshot, result)) {
            clear("access_lost");
            return;
          }
          const checked = await parseWorkReleasePreview(result.preview, {
            ...owner(snapshot),
            workId: snapshot.lookup.workId,
            releaseId,
          });
          if (!valid()) return;
          if (
            checked.release.termsDigest !== record.termsDigest ||
            checked.release.version !== record.version ||
            !active(checked.release.state)
          ) {
            clear("access_lost");
            return;
          }
          next = {
            ...snapshot,
            previews: { ...snapshot.previews, [releaseId]: checked },
          };
        } else {
          setState({
            ...empty(currentKey, decision ? "uncertain" : "unavailable"),
            snapshot: decision ? snapshot : null,
          });
          return;
        }
        snapshotRef.current = next;
        setState({ ...empty(currentKey, "ready"), snapshot: next });
      } catch {
        if (valid())
          setState({
            ...empty(currentKey, decision ? "uncertain" : "unavailable"),
            snapshot: decision ? snapshot : null,
          });
      } finally {
        if (valid()) busy.current = false;
      }
    },
    [clear, clientId, state.phase, state.key],
  );
  return {
    ...(state.key === key ? state : empty(key, "idle")),
    pendingDecisions: Object.fromEntries(pending.current),
    load,
    preview: (id: string) => act(id),
    decide: (id: string, decision: WorkReleaseDecision) => act(id, decision),
  };
}
