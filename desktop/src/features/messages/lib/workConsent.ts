import type {
  WorkConsentDecisionInput,
  WorkConsentDecisionResult,
  WorkConsentLookupResult,
  WorkConsentLookupCursor,
  WorkConsentRecord,
  WorkConsentIntent,
  WorkConsentIntentAccount,
  WorkConsentIntentLookupResult,
  WorkConsentIntentOwnerResult,
  WorkConsentIntentSelectionInput,
  WorkTaskStatusLookupResult,
} from "@axis/gateway-client";

/** Native IPC preconditions. Identity and permission always come from native auth. */
export interface WorkConsentContext {
  channelId: string;
  rootEventId: string;
  admissionRequestId?: string;
  before?: WorkConsentLookupCursor;
  expectedScopeToken?: string;
  expectedRelayUrl: string;
  expectedSignerPubkey: string;
}
export type WorkConsentTarget = Pick<
  WorkConsentContext,
  "channelId" | "rootEventId" | "expectedSignerPubkey"
>;
export type WorkConsentContextResult =
  | { state: "ready"; context: WorkConsentContext }
  | { state: "unsupported" | "access_lost" | "unavailable" };
export interface WorkConsentDisplay {
  accountLabel?: string;
  accountEmail?: string;
  agentLabel?: string;
  initiatorLabel?: string;
}
export interface WorkConsentIdentity {
  scopeToken: string;
  principalId: string;
  organisationId: string;
  displays?: Record<string, WorkConsentDisplay>;
  pendingDecisions?: Record<string, WorkConsentDecisionInput>;
  pendingSelections?: Record<string, WorkConsentIntentSelectionInput>;
  intentDisplays?: Record<string, WorkConsentDisplay>;
}
export type WorkConsentFailure = {
  state: "access_lost" | "unavailable" | "uncertain" | "conflict";
};
export type WorkConsentQueryResult =
  | (WorkConsentIdentity & { state: "ready"; lookup: WorkConsentLookupResult })
  | WorkConsentFailure;
export type WorkConsentReadResult =
  | (WorkConsentIdentity & { state: "ready"; consent: WorkConsentRecord })
  | WorkConsentFailure;
export type WorkConsentMutationResult =
  | (WorkConsentIdentity & {
      state: "confirmed";
      result: WorkConsentDecisionResult;
    })
  | WorkConsentFailure;
export type WorkConsentDecision = WorkConsentDecisionInput["decision"];
export type WorkConsentIntentQueryResult =
  | (WorkConsentIdentity & {
      state: "ready";
      lookup: WorkConsentIntentLookupResult;
    })
  | WorkConsentFailure;
export type WorkConsentIntentReadResult =
  | (WorkConsentIdentity & {
      state: "ready";
      ownerResult: WorkConsentIntentOwnerResult;
    })
  | WorkConsentFailure;
export type WorkConsentSelectionResult =
  | (WorkConsentIdentity & { state: "confirmed"; consent: WorkConsentRecord })
  | WorkConsentFailure;
export type WorkConsentTaskStatusResult =
  | (WorkConsentIdentity & {
      state: "ready";
      lookup: WorkTaskStatusLookupResult;
    })
  | WorkConsentFailure;
export type WorkConsentSnapshot = WorkConsentIdentity & {
  context: WorkConsentContext;
  lookup: WorkConsentLookupResult;
  ownQueryIds?: string[];
  intentLookup?: WorkConsentIntentLookupResult;
  intentBefore?: WorkConsentLookupCursor;
  selectedIntentId?: string;
  intentPhase?: "ready" | "unavailable" | "uncertain";
  intentOwners?: Record<string, WorkConsentIntentOwnerResult>;
  unconfirmedConsents?: string[];
  taskStatusLookup?: WorkTaskStatusLookupResult;
  statusPhase?: "ready" | "unavailable";
  sourceIntents?: Record<
    string,
    { sourceIntentId: string; sourceIntentBefore?: WorkConsentLookupCursor }
  >;
};
export type {
  WorkConsentRecord,
  WorkConsentLookupResult,
  WorkConsentLookupCursor,
  WorkConsentDecisionInput,
  WorkConsentIntent,
  WorkConsentIntentAccount,
  WorkConsentIntentSelectionInput,
  WorkConsentIntentOwnerResult,
};
