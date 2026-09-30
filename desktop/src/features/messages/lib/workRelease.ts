import type {
  WorkReleaseDecisionInput,
  WorkReleaseDecisionResult,
  WorkReleaseLookupResult,
  WorkReleasePreviewResult,
  WorkReleaseRecord,
} from "@axis/gateway-client/work-release";

/** These are native IPC preconditions, never authority or a selectable service URL. */
export interface WorkReleaseTarget {
  channelId: string;
  rootEventId: string;
  expectedSignerPubkey: string;
}
export interface WorkReleaseContext extends WorkReleaseTarget {
  expectedRelayUrl: string;
  expectedScopeToken?: string;
  admissionRequestId?: string;
}
export interface WorkReleaseIdentity {
  scopeToken: string;
  principalId: string;
  organisationId: string;
  pendingDecisions?: Record<string, WorkReleaseDecisionInput>;
  previews?: Record<string, WorkReleasePreviewResult>;
}
export type WorkReleaseFailure = {
  state:
    | "unsupported"
    | "access_lost"
    | "unavailable"
    | "uncertain"
    | "conflict";
};
export type WorkReleaseContextResult =
  | { state: "ready"; context: WorkReleaseContext }
  | WorkReleaseFailure;
export type WorkReleaseNativeResult =
  | (WorkReleaseIdentity & {
      state: "ready";
      lookup?: WorkReleaseLookupResult;
      release?: WorkReleaseRecord;
      preview?: WorkReleasePreviewResult;
    })
  | (WorkReleaseIdentity & {
      state: "confirmed";
      result: WorkReleaseDecisionResult;
    })
  | WorkReleaseFailure;
export type WorkReleaseDecision = WorkReleaseDecisionInput["decision"];
export type {
  WorkReleaseDecisionInput,
  WorkReleaseDecisionResult,
  WorkReleaseLookupResult,
  WorkReleasePreviewResult,
  WorkReleaseRecord,
};
