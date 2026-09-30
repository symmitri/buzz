import { invokeTauri } from "@/shared/api/tauri";
import type { RelayAgent } from "@/shared/api/types";

export type CompanyMentionScope = {
  channelId: string;
  relayUrl: string;
  humanPubkey: string;
};

type NativeCompanyMentions = {
  relay_url: string;
  human_pubkey: string;
  channel_id: string;
  agents: Array<{
    company_agent_id: string;
    pubkey: string;
    name: string;
    channel_ids: string[];
  }>;
};

export function companyMentionRows(
  value: NativeCompanyMentions,
  scope: CompanyMentionScope,
  requested?: readonly string[],
): RelayAgent[] {
  if (
    value.relay_url !== scope.relayUrl ||
    value.human_pubkey !== scope.humanPubkey ||
    value.channel_id !== scope.channelId ||
    !Array.isArray(value.agents) ||
    value.agents.length > 128
  ) {
    throw new Error("Company agent context changed. Refresh the channel.");
  }
  const seen = new Set<string>();
  const ids = new Set<string>();
  const rows = value.agents.map((agent): RelayAgent => {
    if (
      !/^[a-f0-9]{64}$/.test(agent.pubkey) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(agent.company_agent_id) ||
      typeof agent.name !== "string" ||
      !agent.name.trim() ||
      agent.name.length > 512 ||
      agent.channel_ids.length !== 1 ||
      agent.channel_ids[0] !== scope.channelId ||
      seen.has(agent.pubkey) ||
      ids.has(agent.company_agent_id)
    ) {
      throw new Error("Company agent context changed. Refresh the channel.");
    }
    seen.add(agent.pubkey);
    ids.add(agent.company_agent_id);
    return {
      companyAgentId: agent.company_agent_id,
      pubkey: agent.pubkey,
      name: agent.name,
      ownerPubkey: null,
      agentType: "agent",
      channels: [],
      channelIds: [scope.channelId],
      capabilities: [],
      status: "unknown",
      respondTo: null,
      respondToAllowlist: [],
    };
  });
  if (
    requested &&
    (seen.size !== new Set(requested).size ||
      requested.some((key) => !seen.has(key)))
  ) {
    throw new Error("A company agent is no longer available in this channel.");
  }
  return rows;
}

export async function readCompanyChannelMentions(scope: CompanyMentionScope) {
  return companyMentionRows(
    await invokeTauri<NativeCompanyMentions>(
      "spaces_list_company_channel_mentions",
      { channelId: scope.channelId },
    ),
    scope,
  );
}

export async function revalidateCompanyChannelMentions(
  scope: CompanyMentionScope,
  pubkeys: string[],
) {
  return companyMentionRows(
    await invokeTauri<NativeCompanyMentions>(
      "spaces_revalidate_company_channel_mentions",
      {
        channelId: scope.channelId,
        pubkeys,
        expectedRelayUrl: scope.relayUrl,
        expectedSignerPubkey: scope.humanPubkey,
      },
    ),
    scope,
    pubkeys,
  );
}
