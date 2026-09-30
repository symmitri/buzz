import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import {
  AgentConnectionsSection,
  type AgentConnections,
} from "./AgentConnectionsSection";

const subscribeInvalidation = (clear: () => void) =>
  listen("spaces-connections-invalidated", clear);

export function SpacesAgentConnections({ pubkey }: { pubkey: string }) {
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery();
  const relayUrl = activeCommunity?.relayUrl ?? "";
  const humanPubkey = identity.data?.pubkey ?? "";
  const read = useCallback(
    () =>
      invoke<AgentConnections>("spaces_agent_connections", {
        agentPubkey: pubkey,
        expectedRelayUrl: relayUrl,
        expectedHumanPubkey: humanPubkey,
      }),
    [pubkey, relayUrl, humanPubkey],
  );
  if (!relayUrl || !humanPubkey) return null;
  return (
    <AgentConnectionsSection
      key={`${relayUrl}|${humanPubkey}|${pubkey}`}
      relayUrl={relayUrl}
      humanPubkey={humanPubkey}
      agentPubkey={pubkey}
      read={read}
      subscribeInvalidation={subscribeInvalidation}
    />
  );
}
