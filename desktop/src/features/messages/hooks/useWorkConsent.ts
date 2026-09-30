import * as React from "react";
import { listen } from "@tauri-apps/api/event";
import { invokeTauri } from "@/shared/api/tauri";
import type {
  WorkConsentContextResult,
  WorkConsentDecision,
  WorkConsentDecisionInput,
  WorkConsentIdentity,
  WorkConsentLookupCursor,
  WorkConsentMutationResult,
  WorkConsentQueryResult,
  WorkConsentReadResult,
  WorkConsentRecord,
  WorkConsentTarget,
  WorkConsentSnapshot,
  WorkConsentIntentAccount,
  WorkConsentIntentSelectionInput,
  WorkConsentIntentReadResult,
  WorkConsentSelectionResult,
  WorkConsentTaskStatusResult,
} from "../lib/workConsent";
import { parseWorkTaskStatusLookup } from "@axis/gateway-client/work-task-status";
import {
  linkedIntentConsent,
  ownerIntentMatches,
  readWorkConsentIntents,
  withIntentOwner,
  withConsentRecord,
  currentPendingDecision,
} from "../lib/workConsentIntent";

type Phase =
  | "idle"
  | "loading"
  | "ready"
  | "unsupported"
  | "unavailable"
  | "access_lost"
  | "uncertain";
type Snapshot = WorkConsentSnapshot;
type State = {
  key: string;
  phase: Phase;
  snapshot: Snapshot | null;
  busyId: string | null;
  decision: WorkConsentDecision | null;
  busyIntentId: string | null;
};
const empty = (key: string, phase: Phase): State => ({
  key,
  phase,
  snapshot: null,
  busyId: null,
  decision: null,
  busyIntentId: null,
});
const sameIdentity = (a: WorkConsentIdentity, b: WorkConsentIdentity) =>
  a.scopeToken === b.scopeToken &&
  a.principalId === b.principalId &&
  a.organisationId === b.organisationId;
const owned = (record: WorkConsentRecord, identity: WorkConsentIdentity) =>
  record.terms.grantorId === identity.principalId &&
  record.terms.orgId === identity.organisationId &&
  record.terms.outputAudience.ownerId === identity.principalId;

const visible = () => document.visibilityState !== "hidden";

/** Private, visible-thread-only state. Never sends a chat message or starts work. */
export function useWorkConsent(target: WorkConsentTarget | null) {
  const key = target
    ? JSON.stringify([
        target.channelId,
        target.rootEventId,
        target.expectedSignerPubkey,
      ])
    : "";
  const targetRef = React.useRef(target);
  const keyRef = React.useRef(key);
  targetRef.current = target;
  keyRef.current = key;
  const generation = React.useRef(0);
  const clientId = React.useState(() => crypto.randomUUID())[0];
  const pageRef = React.useRef<WorkConsentLookupCursor | undefined>(undefined);
  const intentPageRef = React.useRef<WorkConsentLookupCursor | undefined>(
    undefined,
  );
  const selectedIntentRef = React.useRef<string | undefined>(undefined);
  const snapshotRef = React.useRef<Snapshot | null>(null);
  const busy = React.useRef(false);
  const subscribed = React.useRef<Promise<boolean>>(Promise.resolve(false));
  const subscribeAgain = React.useRef<() => Promise<boolean>>(() =>
    Promise.resolve(false),
  );
  const cancelBarrier = React.useRef<Promise<unknown>>(Promise.resolve());
  const intents = React.useRef(new Map<string, WorkConsentDecisionInput>());
  const selections = React.useRef(
    new Map<string, WorkConsentIntentSelectionInput>(),
  );
  const [state, setState] = React.useState<State>(() => empty(key, "idle"));
  const [, wakeClock] = React.useState(0);
  const cancel = React.useCallback(() => {
    cancelBarrier.current = cancelBarrier.current
      .then(() =>
        invokeTauri("spaces_cancel_work_consent", { input: { clientId } }),
      )
      .catch(() => {});
  }, [clientId]);
  const clear = React.useCallback(
    (phase: Phase) => {
      generation.current++;
      snapshotRef.current = null;
      busy.current = false;
      intents.current.clear();
      selections.current.clear();
      pageRef.current = undefined;
      intentPageRef.current = undefined;
      selectedIntentRef.current = undefined;
      setState(empty(keyRef.current, phase));
      cancel();
    },
    [cancel],
  );

  const load = React.useCallback(async () => {
    const currentTarget = targetRef.current;
    const currentKey = keyRef.current;
    if (!currentTarget || !visible() || busy.current) return;
    const epoch = ++generation.current;
    const valid = () =>
      generation.current === epoch &&
      keyRef.current === currentKey &&
      visible();
    const previous = snapshotRef.current;
    // Keep a current card and keyboard focus during background reads. Every
    // explicit decision still carries the reviewed digest/version to native.
    setState((current) =>
      current.key === currentKey && current.phase === "ready" && previous
        ? { ...current }
        : { ...empty(currentKey, "loading"), snapshot: previous },
    );
    await cancelBarrier.current;
    if (!(await subscribed.current) && valid())
      subscribed.current = subscribeAgain.current();
    if (!(await subscribed.current) || !valid()) {
      if (valid()) clear("unavailable");
      return;
    }
    try {
      const gate = await invokeTauri<WorkConsentContextResult>(
        "spaces_work_consent_context",
        { input: currentTarget },
      );
      if (!valid()) return;
      if (gate.state !== "ready") {
        clear(gate.state);
        return;
      }
      if (
        gate.context.channelId !== currentTarget.channelId ||
        gate.context.rootEventId !== currentTarget.rootEventId ||
        gate.context.expectedSignerPubkey !== currentTarget.expectedSignerPubkey
      ) {
        clear("access_lost");
        return;
      }
      const pageContext = {
        ...gate.context,
        ...(previous ? { expectedScopeToken: previous.scopeToken } : {}),
        ...(pageRef.current ? { before: pageRef.current } : {}),
      };
      const result = await invokeTauri<WorkConsentQueryResult>(
        "spaces_query_work_consents",
        {
          input: { ...pageContext, clientId },
        },
      );
      if (!valid()) return;
      if (result.state !== "ready") {
        if (result.state === "access_lost") clear("access_lost");
        else setState(empty(currentKey, "unavailable"));
        return;
      }
      if (
        !result.lookup.requests.every((record) => owned(record, result)) ||
        (previous &&
          (!sameIdentity(previous, result) ||
            previous.lookup.workId !== result.lookup.workId))
      ) {
        clear("access_lost");
        return;
      }
      let next: Snapshot = {
        ...previous,
        ...result,
        context: pageContext,
        ownQueryIds: result.lookup.requests.map((record) => record.id),
      };
      for (const record of result.lookup.requests)
        next = withConsentRecord(next, record, true);
      // Preserve the selected card and its exact binding during same-scope
      // background reads. Failed intent refreshes never expose replacement choices.
      const bound = next.selectedIntentId
        ? next.intentOwners?.[next.selectedIntentId]?.consent
        : undefined;
      if (
        bound &&
        !next.lookup.requests.some((record) => record.id === bound.id)
      )
        next.lookup = {
          ...next.lookup,
          requests: [...next.lookup.requests, bound],
        };
      for (const [id, intent] of Object.entries(result.pendingDecisions ?? {}))
        intents.current.set(id, intent);
      // A new authoritative record ends an old uncertain intent; unchanged terms retain its exact operation.
      for (const [id, intent] of intents.current) {
        const record = next.lookup.requests.find((item) => item.id === id);
        if (!record || !currentPendingDecision(intent, record))
          intents.current.delete(id);
      }
      snapshotRef.current = next;
      setState({ ...empty(currentKey, "ready"), snapshot: next });
      // Consent cleanup remains usable even if the independent account-intent
      // projection is unavailable. A decision invalidates this read's epoch.
      const intentRead = await readWorkConsentIntents(
        next,
        intentPageRef.current,
        selectedIntentRef.current,
        clientId,
        selections.current,
        valid,
      );
      if (!valid()) return;
      if (intentRead.state === "access_lost") {
        clear("access_lost");
        return;
      }
      selectedIntentRef.current = intentRead.snapshot.selectedIntentId;
      for (const record of intentRead.snapshot.lookup.requests) {
        const operation = intents.current.get(record.id);
        if (operation && !currentPendingDecision(operation, record))
          intents.current.delete(record.id);
      }
      for (const [id, operation] of Object.entries(
        intentRead.snapshot.pendingDecisions ?? {},
      ))
        if (
          intentRead.snapshot.lookup.requests.some(
            (record) =>
              record.id === id && currentPendingDecision(operation, record),
          )
        )
          intents.current.set(id, operation);
      snapshotRef.current = intentRead.snapshot;
      setState({
        ...empty(currentKey, "ready"),
        snapshot: intentRead.snapshot,
      });
      let final: Snapshot = {
        ...intentRead.snapshot,
        taskStatusLookup: undefined,
        statusPhase: "unavailable",
      };
      try {
        const status = await invokeTauri<WorkConsentTaskStatusResult>(
          "spaces_query_work_consent_task_status",
          {
            input: {
              ...pageContext,
              clientId,
              expectedScopeToken: next.scopeToken,
            },
          },
        );
        if (!valid()) return;
        if (status.state === "access_lost") {
          clear("access_lost");
          return;
        }
        if (status.state === "ready") {
          if (
            !sameIdentity(next, status) ||
            status.lookup.ownerId !== next.principalId ||
            status.lookup.orgId !== next.organisationId ||
            status.lookup.workId !== next.lookup.workId
          ) {
            clear("access_lost");
            return;
          }
          const lookup = parseWorkTaskStatusLookup(status.lookup, {
            orgId: next.organisationId,
            identityId: next.principalId,
            workId: next.lookup.workId,
          });
          final = {
            ...intentRead.snapshot,
            taskStatusLookup: lookup,
            statusPhase: "ready",
          };
          // A newer loss projection cannot leave an old approved card active.
          // Wait for the exact full owner record before another decision.
          const changed = lookup.statuses
            .filter((status) => {
              const record = final.lookup.requests.find(
                (record) => record.id === status.consentId,
              );
              return (
                record?.state === "approved" &&
                status.consentVersion >= record.version &&
                (status.consentVersion !== record.version ||
                  status.termsDigest !== record.termsDigest ||
                  [
                    "pending",
                    "declined",
                    "revoked",
                    "expired",
                    "stale",
                  ].includes(status.state))
              );
            })
            .map((status) => status.consentId);
          final.unconfirmedConsents = [
            ...new Set([...(final.unconfirmedConsents ?? []), ...changed]),
          ];
        }
      } catch {
        /* Optional status failure never removes owner consent cleanup. */
      }
      if (!valid()) return;
      snapshotRef.current = final;
      setState({ ...empty(currentKey, "ready"), snapshot: final });
    } catch {
      if (valid()) {
        setState(empty(currentKey, "unavailable"));
      }
    }
  }, [clear, clientId]);

  React.useEffect(() => {
    let disposed = false;
    let listener: Promise<() => void> | undefined;
    const attach = () => {
      listener = listen("spaces-connections-invalidated", () => {
        if (!disposed) clear("access_lost");
      });
      return listener.then(
        (unlisten) => {
          if (disposed) {
            unlisten();
            return false;
          }
          return true;
        },
        () => false,
      );
    };
    subscribeAgain.current = attach;
    subscribed.current = attach();
    return () => {
      disposed = true;
      subscribeAgain.current = () => Promise.resolve(false);
      void listener?.then((unlisten) => unlisten()).catch(() => {});
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
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      generation.current++;
      snapshotRef.current = null;
      busy.current = false;
      intents.current.clear();
      selections.current.clear();
      cancel();
    };
  }, [key, clear, load, cancel]);

  const consentExpiry = [
    ...(state.snapshot?.lookup.requests ?? []),
    ...(state.snapshot?.intentLookup?.intents ?? []),
  ].reduce((next, record) => {
    const expiry = Date.parse(record.terms.expiresAt);
    return expiry > Date.now() ? Math.min(next, expiry) : next;
  }, Infinity);
  const statusExpiry =
    state.snapshot?.taskStatusLookup?.statuses.reduce((next, status) => {
      const expiry = status.leaseExpiresAt
        ? Date.parse(status.leaseExpiresAt)
        : Infinity;
      return expiry > Date.now() ? Math.min(next, expiry) : next;
    }, Infinity) ?? Infinity;
  const expiresAt = Math.min(consentExpiry, statusExpiry);
  const loaded = Boolean(state.snapshot);
  React.useEffect(() => {
    if (!loaded) return;
    const poll = window.setInterval(() => {
      if (visible()) void load();
    }, 15_000);
    const expiry = Number.isFinite(expiresAt)
      ? window.setTimeout(
          () => {
            if (visible()) {
              wakeClock((value) => value + 1);
              void load();
            }
          },
          Math.max(1, expiresAt - Date.now()),
        )
      : undefined;
    return () => {
      window.clearInterval(poll);
      window.clearTimeout(expiry);
    };
  }, [loaded, expiresAt, load]);

  const decide = React.useCallback(
    async (consentId: string, decision: WorkConsentDecision) => {
      const snapshot = snapshotRef.current;
      const record = snapshot?.lookup.requests.find(
        (entry) => entry.id === consentId,
      );
      if (
        !snapshot ||
        !record ||
        snapshot.unconfirmedConsents?.includes(consentId) ||
        busy.current ||
        !visible() ||
        state.phase !== "ready" ||
        state.key !== keyRef.current
      )
        return;
      const oldIntent = intents.current.get(consentId);
      if (oldIntent && oldIntent.decision !== decision) return;
      const intent = oldIntent ?? {
        operationId: crypto.randomUUID(),
        expectedVersion: record.version,
        termsDigest: record.termsDigest,
        decision,
      };
      intents.current.set(consentId, intent);
      busy.current = true;
      const epoch = ++generation.current;
      const currentKey = keyRef.current;
      const valid = () =>
        generation.current === epoch &&
        currentKey === keyRef.current &&
        visible();
      setState({
        key: currentKey,
        phase: "ready",
        snapshot,
        busyId: consentId,
        decision,
        busyIntentId: null,
      });
      const input = {
        ...snapshot.context,
        clientId,
        consentId,
        expectedScopeToken: snapshot.scopeToken,
        ...snapshot.sourceIntents?.[consentId],
      };
      try {
        const result = await invokeTauri<WorkConsentMutationResult>(
          "spaces_decide_work_consent",
          { input: { ...input, ...intent } },
        );
        if (!valid()) return;
        if (result.state === "access_lost") {
          clear("access_lost");
          return;
        }
        if (result.state === "confirmed") {
          const nextRecord = result.result.consent;
          if (
            !sameIdentity(snapshot, result) ||
            !owned(nextRecord, snapshot) ||
            nextRecord.id !== consentId
          ) {
            clear("access_lost");
            return;
          }
          intents.current.delete(consentId);
          const next = withConsentRecord(snapshot, nextRecord);
          snapshotRef.current = next;
          // Current record wins even if a replay includes an old approve receipt.
          setState({ ...empty(currentKey, "ready"), snapshot: next });
        } else if (result.state === "conflict") {
          const read = await invokeTauri<WorkConsentReadResult>(
            "spaces_read_work_consent",
            { input },
          );
          if (!valid()) return;
          if (read.state === "access_lost") {
            clear("access_lost");
            return;
          }
          if (
            read.state === "ready" &&
            sameIdentity(snapshot, read) &&
            owned(read.consent, snapshot) &&
            read.consent.id === consentId
          ) {
            intents.current.delete(consentId);
            const next = withConsentRecord(snapshot, read.consent);
            snapshotRef.current = next;
            setState({ ...empty(currentKey, "ready"), snapshot: next });
          } else if (read.state === "ready") clear("access_lost");
          else setState({ ...empty(currentKey, "uncertain"), snapshot });
        } else setState({ ...empty(currentKey, "uncertain"), snapshot });
      } catch {
        if (valid()) setState({ ...empty(currentKey, "uncertain"), snapshot });
      } finally {
        if (valid()) busy.current = false;
      }
    },
    [clear, clientId, state.phase, state.key],
  );

  const loadPage = React.useCallback(
    (before?: WorkConsentLookupCursor) => {
      if (busy.current || !visible()) return;
      pageRef.current = before;
      void load();
    },
    [load],
  );

  const selectAccount = React.useCallback(
    async (intentId: string, account?: WorkConsentIntentAccount) => {
      const snapshot = snapshotRef.current;
      const owner = snapshot?.intentOwners?.[intentId];
      const frozen = owner?.intent;
      const retained = selections.current.get(intentId);
      if (
        !snapshot ||
        !owner ||
        !frozen ||
        owner.consent ||
        busy.current ||
        !visible() ||
        state.key !== keyRef.current ||
        state.phase !== "ready" ||
        snapshot.intentPhase === "unavailable"
      )
        return;
      if (
        !retained &&
        (!account ||
          frozen.state !== "select_account" ||
          Date.parse(frozen.terms.expiresAt) <= Date.now() ||
          !owner.accounts.some(
            (value) =>
              value.accountId === account.accountId &&
              value.accountVersion === account.accountVersion &&
              value.connectionId === account.connectionId &&
              value.provider === account.provider,
          ))
      )
        return;
      // An uncertain selection never adopts a currently offered replacement.
      if (
        retained &&
        account &&
        (account.accountId !== retained.accountId ||
          account.accountVersion !== retained.accountVersion)
      )
        return;
      let operation = retained;
      if (!operation) {
        if (!account) return;
        operation = {
          operationId: crypto.randomUUID(),
          expectedVersion: frozen.version,
          intentDigest: frozen.digest,
          accountId: account.accountId,
          accountVersion: account.accountVersion,
        };
      }
      selections.current.set(intentId, operation);
      busy.current = true;
      const epoch = ++generation.current,
        currentKey = keyRef.current;
      const valid = () =>
        generation.current === epoch &&
        keyRef.current === currentKey &&
        visible();
      setState({
        ...empty(currentKey, "ready"),
        snapshot,
        busyIntentId: intentId,
      });
      const input = {
        ...snapshot.context,
        before: snapshot.intentBefore,
        clientId,
        intentId,
        expectedScopeToken: snapshot.scopeToken,
      };
      const uncertain = () => {
        const next = { ...snapshot, intentPhase: "uncertain" as const };
        snapshotRef.current = next;
        setState({ ...empty(currentKey, "ready"), snapshot: next });
      };
      try {
        const result = await invokeTauri<WorkConsentSelectionResult>(
          "spaces_select_work_consent_account",
          { input: { ...input, ...operation } },
        );
        if (!valid()) return;
        if (result.state === "access_lost") {
          clear("access_lost");
          return;
        }
        if (result.state === "confirmed") {
          const record = result.consent;
          if (
            !sameIdentity(snapshot, result) ||
            !linkedIntentConsent(record, frozen, snapshot) ||
            record.terms.accountId !== operation.accountId ||
            record.terms.accountVersion !== operation.accountVersion
          ) {
            clear("access_lost");
            return;
          }
          selections.current.delete(intentId);
          const next = withIntentOwner(
            snapshot,
            { ...owner, consent: record },
            result,
          );
          snapshotRef.current = next;
          // Binding is never approval: even a terminal replay uses its current record.
          setState({ ...empty(currentKey, "ready"), snapshot: next });
        } else if (result.state === "conflict") {
          const read = await invokeTauri<WorkConsentIntentReadResult>(
            "spaces_read_work_consent_intent",
            { input },
          );
          if (!valid()) return;
          if (read.state === "access_lost") {
            clear("access_lost");
            return;
          }
          if (read.state !== "ready") {
            uncertain();
            return;
          }
          if (
            !sameIdentity(snapshot, read) ||
            !ownerIntentMatches(read.ownerResult, frozen, snapshot)
          ) {
            clear("access_lost");
            return;
          }
          // Only a definitive conflict followed by the exact fresh owner read
          // permits another explicit choice. A read alone never clears an unknown write.
          selections.current.delete(intentId);
          const next = withIntentOwner(snapshot, read.ownerResult, read);
          snapshotRef.current = next;
          setState({ ...empty(currentKey, "ready"), snapshot: next });
        } else uncertain();
      } catch {
        if (valid()) uncertain();
      } finally {
        if (valid()) busy.current = false;
      }
    },
    [clear, clientId, state.phase, state.key],
  );
  const retrySelection = React.useCallback(
    (intentId: string) => {
      if (selections.current.has(intentId)) void selectAccount(intentId);
    },
    [selectAccount],
  );
  const loadIntent = React.useCallback(
    (intentId: string) => {
      if (
        busy.current ||
        !visible() ||
        !snapshotRef.current?.intentLookup?.intents.some(
          (intent) => intent.id === intentId,
        )
      )
        return;
      selectedIntentRef.current = intentId;
      void load();
    },
    [load],
  );
  const loadIntentPage = React.useCallback(
    (before?: WorkConsentLookupCursor) => {
      if (busy.current || !visible()) return;
      intentPageRef.current = before;
      selectedIntentRef.current = undefined;
      void load();
    },
    [load],
  );

  // Fence synchronously on navigation/identity props, before effects can run.
  return {
    ...(state.key === key ? state : empty(key, "idle")),
    pendingDecisions: Object.fromEntries(intents.current),
    pendingSelections: Object.fromEntries(selections.current),
    selectedIntentId:
      state.key === key ? state.snapshot?.selectedIntentId : undefined,
    intentPhase: state.key === key ? state.snapshot?.intentPhase : undefined,
    load,
    loadPage,
    decide,
    selectAccount,
    retrySelection,
    loadIntent,
    loadIntentPage,
  };
}
