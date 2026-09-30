import {
  getAgentMentionAdmission,
  getMentionableAgentPubkeys,
  type AgentEligibilityScope,
} from "@/features/agents/lib/agentAutocompleteEligibility";
import { revalidateRelayAgents } from "@/shared/api/tauriRelayAgents";
import type { ManagedAgent, RelayAgent } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import * as React from "react";

export type MentionRevalidationOptions = {
  phase?: "prepare" | "publish";
  intendedAgentPubkeys?: readonly string[];
};

export class AgentMentionAuthorizationError extends Error {
  constructor() {
    super(
      "Could not authorize a mentioned agent. Check its access and channel membership, then retry or remove the mention.",
    );
    this.name = "AgentMentionAuthorizationError";
  }
}

type DirectoryResult<T> = {
  data: T | undefined;
  error: Error | null;
};

export async function revalidateAgentMentionPubkeys({
  pubkeys,
  agentPubkeys,
  currentPubkey,
  eligibilityScope,
  sharedChannelIds,
  refetchManagedAgents,
  fetchRelayAgents,
  companyAgentPubkeys = new Set<string>(),
  fetchCompanyAgents,
  phase = "publish",
}: {
  phase?: "prepare" | "publish";
  pubkeys: readonly string[];
  agentPubkeys: ReadonlySet<string>;
  currentPubkey: string | null;
  eligibilityScope: AgentEligibilityScope;
  sharedChannelIds: ReadonlySet<string>;
  refetchManagedAgents: () => Promise<DirectoryResult<ManagedAgent[]>>;
  fetchRelayAgents: (pubkeys: string[]) => Promise<RelayAgent[]>;
  companyAgentPubkeys?: ReadonlySet<string>;
  fetchCompanyAgents?: (
    pubkeys: string[],
    channelId: string,
  ) => Promise<RelayAgent[]>;
}) {
  const requestedAgentPubkeys = new Set(
    pubkeys.map(normalizePubkey).filter((pubkey) => agentPubkeys.has(pubkey)),
  );
  if (requestedAgentPubkeys.size === 0) {
    return [...pubkeys];
  }

  const companyKeys = [...requestedAgentPubkeys].filter((key) =>
    companyAgentPubkeys.has(key),
  );
  const legacyKeys = [...requestedAgentPubkeys].filter(
    (key) => !companyAgentPubkeys.has(key),
  );
  const [managedResult, legacyAgents, companyAgents] = await Promise.all([
    refetchManagedAgents().catch(() => null),
    legacyKeys.length > 0 ? fetchRelayAgents(legacyKeys).catch(() => null) : [],
    companyKeys.length === 0
      ? []
      : eligibilityScope.type === "channel" && fetchCompanyAgents
        ? fetchCompanyAgents(companyKeys, eligibilityScope.channelId).catch(
            () => null,
          )
        : null,
  ]);
  // A revoked canonical identity must never fall through to a local or legacy
  // policy. Every selected company key requires its own fresh native proof.
  if (
    companyAgents === null ||
    companyKeys.some(
      (key) =>
        !companyAgents.some(
          (agent) => agent.pubkey === key && Boolean(agent.companyAgentId),
        ),
    )
  )
    throw new AgentMentionAuthorizationError();
  const relayAgents = [...(legacyAgents ?? []), ...companyAgents];
  // Each directory proves only its own identities. A failed local runtime
  // query must neither veto fresh relay evidence nor admit stale local data.
  const managedPubkeys = new Set(
    (managedResult?.error === null ? (managedResult.data ?? []) : []).map(
      (agent) => normalizePubkey(agent.pubkey),
    ),
  );
  for (const key of companyKeys) managedPubkeys.delete(key);
  const mentionablePubkeys = getMentionableAgentPubkeys({
    currentPubkey,
    eligibilityScope,
    phase,
    managedAgentPubkeys: managedPubkeys,
    relayAgents,
    sharedChannelIds,
  });
  const admittedPubkeys = new Set(
    [...agentPubkeys].filter((pubkey) => {
      const isManagedAgent = managedPubkeys.has(normalizePubkey(pubkey));
      const directoryReady =
        isManagedAgent ||
        (companyAgentPubkeys.has(pubkey)
          ? companyAgents !== null
          : legacyAgents !== null);
      return (
        getAgentMentionAdmission({
          isAgent: true,
          pubkey,
          mentionableAgentPubkeys: mentionablePubkeys,
          directoryReady,
        }) === "allow"
      );
    }),
  );
  if (
    [...requestedAgentPubkeys].some((pubkey) => !admittedPubkeys.has(pubkey))
  ) {
    throw new AgentMentionAuthorizationError();
  }
  return [...pubkeys];
}

export function useAgentMentionRevalidation({
  agentPubkeys,
  getSelectedAgentPubkeys,
  currentPubkey,
  eligibilityScope,
  sharedChannelIds,
  refetchManagedAgents,
  companyAgentPubkeys,
  fetchCompanyAgents,
}: {
  agentPubkeys: ReadonlySet<string>;
  getSelectedAgentPubkeys: () => ReadonlySet<string>;
  currentPubkey: string | null;
  eligibilityScope: AgentEligibilityScope;
  sharedChannelIds: ReadonlySet<string>;
  refetchManagedAgents: () => Promise<DirectoryResult<ManagedAgent[]>>;
  companyAgentPubkeys?: ReadonlySet<string>;
  fetchCompanyAgents?: (
    pubkeys: string[],
    channelId: string,
  ) => Promise<RelayAgent[]>;
}) {
  return React.useCallback(
    (
      pubkeys: readonly string[],
      destinationChannelId?: string | null,
      options: MentionRevalidationOptions = {},
    ) => {
      // A new DM can acquire its channel during preparation. Validate the
      // actual destination at publication, not the composer's original null id.
      const scope: AgentEligibilityScope = destinationChannelId
        ? {
            type: eligibilityScope.type === "owned" ? "owned" : "channel",
            channelId: destinationChannelId,
          }
        : eligibilityScope;
      return revalidateAgentMentionPubkeys({
        pubkeys,
        agentPubkeys: new Set([
          ...agentPubkeys,
          ...getSelectedAgentPubkeys(),
          ...(options.intendedAgentPubkeys ?? []).map(normalizePubkey),
        ]),
        phase: options.phase,
        currentPubkey,
        eligibilityScope: scope,
        sharedChannelIds,
        refetchManagedAgents,
        companyAgentPubkeys,
        fetchCompanyAgents,
        fetchRelayAgents: (requestedPubkeys) =>
          revalidateRelayAgents(
            requestedPubkeys,
            "channelId" in scope ? (scope.channelId ?? undefined) : undefined,
          ),
      });
    },
    [
      agentPubkeys,
      currentPubkey,
      eligibilityScope,
      getSelectedAgentPubkeys,
      refetchManagedAgents,
      companyAgentPubkeys,
      fetchCompanyAgents,
      sharedChannelIds,
    ],
  );
}
