import { invokeTauri } from "@/shared/api/tauri";
import type {
  WorkConsentIdentity,
  WorkConsentDecisionInput,
  WorkConsentIntent,
  WorkConsentIntentOwnerResult,
  WorkConsentIntentQueryResult,
  WorkConsentIntentReadResult,
  WorkConsentIntentSelectionInput,
  WorkConsentLookupCursor,
  WorkConsentRecord,
  WorkConsentSnapshot,
} from "./workConsent";

export const sameConsentIdentity = (
  a: WorkConsentIdentity,
  b: WorkConsentIdentity,
) =>
  a.scopeToken === b.scopeToken &&
  a.principalId === b.principalId &&
  a.organisationId === b.organisationId;

export const currentPendingDecision = (
  operation: WorkConsentDecisionInput,
  record: WorkConsentRecord,
) =>
  operation.expectedVersion === record.version &&
  operation.termsDigest === record.termsDigest &&
  (operation.decision === "revoke"
    ? !["declined", "revoked"].includes(record.state)
    : record.state === "pending");

// Native validates canonical wire shapes. These exact linkage checks also fence
// stale or incorrectly correlated IPC results before presenting private terms.
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equal(left[key], right[key]),
    )
  );
}

export function linkedIntentConsent(
  record: WorkConsentRecord,
  intent: WorkConsentIntent,
  identity: WorkConsentIdentity,
): boolean {
  return (
    record.terms.grantorId === identity.principalId &&
    record.terms.outputAudience.ownerId === identity.principalId &&
    record.terms.outputAudience.kind === "private_contribution" &&
    record.terms.orgId === identity.organisationId &&
    (
      [
        "orgId",
        "applicationId",
        "workloadIdentityId",
        "task",
        "taskSummary",
        "scope",
        "audience",
        "expiresAt",
      ] as const
    ).every((key) => equal(record.terms[key], intent.terms[key]))
  );
}

export function ownerIntentMatches(
  owner: WorkConsentIntentOwnerResult,
  intent: WorkConsentIntent,
  snapshot: WorkConsentSnapshot,
): boolean {
  return (
    owner.intent.id === intent.id &&
    owner.intent.digest === intent.digest &&
    owner.intent.version >= intent.version &&
    equal(owner.intent.terms, intent.terms) &&
    owner.intent.terms.orgId === snapshot.organisationId &&
    owner.intent.terms.task.workId === snapshot.lookup.workId &&
    owner.accounts.length <= 1 &&
    (!owner.consent ||
      linkedIntentConsent(owner.consent, owner.intent, snapshot))
  );
}

export function withIntentOwner(
  snapshot: WorkConsentSnapshot,
  owner: WorkConsentIntentOwnerResult,
  labels?: WorkConsentIdentity,
): WorkConsentSnapshot {
  const record = owner.consent;
  const next: WorkConsentSnapshot = {
    ...snapshot,
    intentPhase: "ready",
    selectedIntentId: owner.intent.id,
    intentOwners: { [owner.intent.id]: owner },
    intentDisplays: { ...snapshot.intentDisplays, ...labels?.intentDisplays },
    displays: { ...snapshot.displays, ...labels?.displays },
    pendingDecisions: {
      ...snapshot.pendingDecisions,
      ...labels?.pendingDecisions,
    },
  };
  if (record) {
    const pending = next.pendingDecisions?.[record.id];
    if (pending && !currentPendingDecision(pending, record))
      delete next.pendingDecisions?.[record.id];
    next.lookup = {
      ...snapshot.lookup,
      requests: [
        ...snapshot.lookup.requests.filter((value) => value.id !== record.id),
        record,
      ],
    };
    if (!snapshot.ownQueryIds?.includes(record.id))
      next.sourceIntents = {
        ...snapshot.sourceIntents,
        [record.id]: {
          sourceIntentId: owner.intent.id,
          sourceIntentBefore: snapshot.intentBefore,
        },
      };
    next.unconfirmedConsents = snapshot.unconfirmedConsents?.filter(
      (id) => id !== record.id,
    );
  }
  return next;
}

/** A newer owner record updates every local view of that same immutable binding. */
export function withConsentRecord(
  snapshot: WorkConsentSnapshot,
  record: WorkConsentRecord,
  fromQuery = false,
): WorkConsentSnapshot {
  const sourceIntents = { ...snapshot.sourceIntents };
  if (fromQuery) delete sourceIntents[record.id];
  return {
    ...snapshot,
    sourceIntents,
    unconfirmedConsents: snapshot.unconfirmedConsents?.filter(
      (id) => id !== record.id,
    ),
    lookup: {
      ...snapshot.lookup,
      requests: snapshot.lookup.requests.map((value) =>
        value.id === record.id ? record : value,
      ),
    },
    intentOwners:
      snapshot.intentOwners &&
      Object.fromEntries(
        Object.entries(snapshot.intentOwners).map(([id, owner]) => [
          id,
          owner.consent?.id === record.id
            ? { ...owner, consent: record }
            : owner,
        ]),
      ),
  };
}

/** Read one selected intent's private account projection, never an account fanout. */
export async function readWorkConsentIntents(
  snapshot: WorkConsentSnapshot,
  before: WorkConsentLookupCursor | undefined,
  selectedId: string | undefined,
  clientId: string,
  selections: Map<string, WorkConsentIntentSelectionInput>,
  valid: () => boolean,
): Promise<
  { state: "access_lost" } | { state: "ready"; snapshot: WorkConsentSnapshot }
> {
  let next: WorkConsentSnapshot = {
    ...snapshot,
    intentBefore: before,
    intentPhase: "unavailable",
  };
  const previousOwner = selectedId
    ? snapshot.intentOwners?.[selectedId]
    : undefined;
  const unavailable = () => ({
    state: "ready" as const,
    snapshot: {
      ...next,
      // A failed refresh or omitted projection cannot remove a known binding.
      intentOwners: previousOwner?.consent
        ? { [previousOwner.intent.id]: previousOwner }
        : undefined,
      unconfirmedConsents:
        previousOwner?.consent &&
        !snapshot.ownQueryIds?.includes(previousOwner.consent.id)
          ? [
              ...new Set([
                ...(next.unconfirmedConsents ?? []),
                previousOwner.consent.id,
              ]),
            ]
          : next.unconfirmedConsents,
      intentPhase: "unavailable" as const,
    },
  });
  const input = {
    ...snapshot.context,
    before,
    expectedScopeToken: snapshot.scopeToken,
    clientId,
  };
  try {
    const query = await invokeTauri<WorkConsentIntentQueryResult>(
      "spaces_query_work_consent_intents",
      { input },
    );
    if (!valid()) return unavailable();
    if (query.state === "access_lost") return { state: "access_lost" };
    if (query.state !== "ready") return unavailable();
    if (
      !sameConsentIdentity(snapshot, query) ||
      query.lookup.workId !== snapshot.lookup.workId ||
      query.lookup.intents.some(
        (intent) =>
          intent.terms.orgId !== snapshot.organisationId ||
          intent.terms.task.workId !== snapshot.lookup.workId,
      )
    )
      return { state: "access_lost" };
    for (const [id, operation] of Object.entries(query.pendingSelections ?? {}))
      selections.set(id, operation);
    // Bound intents leave the unbound query. Recover only a previously selected
    // binding or native retained operation, still under this fresh origin/work.
    const listed = query.lookup.intents.find(
      (intent) => intent.id === selectedId,
    );
    const recoveryId =
      selectedId &&
      (previousOwner?.consent || query.pendingSelections?.[selectedId])
        ? selectedId
        : Object.keys(query.pendingSelections ?? {})[0];
    const selected =
      listed ??
      (recoveryId
        ? previousOwner?.intent.id === recoveryId
          ? previousOwner.intent
          : undefined
        : query.lookup.intents[0]);
    const intentId = selected?.id ?? recoveryId;
    next = {
      ...next,
      intentLookup: query.lookup,
      selectedIntentId: intentId,
      intentDisplays: query.intentDisplays,
      intentPhase: "ready",
    };
    if (!intentId)
      return { state: "ready", snapshot: { ...next, intentOwners: undefined } };
    const read = await invokeTauri<WorkConsentIntentReadResult>(
      "spaces_read_work_consent_intent",
      {
        input: {
          ...input,
          intentId,
          ...(previousOwner?.consent
            ? { expectedConsentId: previousOwner.consent.id }
            : {}),
        },
      },
    );
    if (!valid()) return unavailable();
    if (read.state === "access_lost") return { state: "access_lost" };
    if (read.state !== "ready") return unavailable();
    if (
      !sameConsentIdentity(snapshot, read) ||
      read.ownerResult.intent.id !== intentId ||
      !ownerIntentMatches(
        read.ownerResult,
        selected ?? read.ownerResult.intent,
        snapshot,
      ) ||
      (!selected &&
        (!query.pendingSelections?.[intentId] ||
          read.ownerResult.intent.digest !==
            query.pendingSelections[intentId].intentDigest ||
          read.ownerResult.intent.version <
            query.pendingSelections[intentId].expectedVersion))
    )
      return { state: "access_lost" };
    if (
      previousOwner?.consent &&
      read.ownerResult.consent?.id !== previousOwner.consent.id
    )
      return unavailable();
    for (const [id, operation] of Object.entries(read.pendingSelections ?? {}))
      selections.set(id, operation);
    if (read.ownerResult.consent) selections.delete(intentId);
    return {
      state: "ready",
      snapshot: withIntentOwner(next, read.ownerResult, read),
    };
  } catch {
    return unavailable();
  }
}
