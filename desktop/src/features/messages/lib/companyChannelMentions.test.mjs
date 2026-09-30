import assert from "node:assert/strict";
import test from "node:test";
import { companyMentionRows } from "./companyChannelMentions.ts";
import { getMentionableAgentPubkeys } from "@/features/agents/lib/agentAutocompleteEligibility.ts";
import {
  revalidateAgentMentionPubkeys,
  AgentMentionAuthorizationError,
} from "./agentMentionRevalidation.ts";
const scope = {
  relayUrl: "wss://alpha.test",
  humanPubkey: "a".repeat(64),
  channelId: "11111111-1111-4111-8111-111111111111",
};
const key = "b".repeat(64);
const result = () => ({
  relay_url: scope.relayUrl,
  human_pubkey: scope.humanPubkey,
  channel_id: scope.channelId,
  agents: [
    {
      company_agent_id: "agent-symi",
      pubkey: key,
      name: "Symi",
      channel_ids: [scope.channelId],
    },
  ],
});
const rows = () => companyMentionRows(result(), scope, [key]);
const options = () => ({
  pubkeys: [key],
  agentPubkeys: new Set([key]),
  currentPubkey: scope.humanPubkey,
  eligibilityScope: { type: "channel", channelId: scope.channelId },
  sharedChannelIds: new Set([scope.channelId]),
  refetchManagedAgents: async () => ({ data: [], error: null }),
  companyAgentPubkeys: new Set([key]),
  fetchCompanyAgents: async () => rows(),
  fetchRelayAgents: async () => {
    throw new Error("no legacy policy");
  },
});

test("canonical company row has scoped eligibility without inventing owner or policy", () => {
  const agents = rows();
  assert.equal(agents[0].ownerPubkey, null);
  assert.equal(agents[0].respondTo, null);
  assert.equal(agents[0].status, "unknown");
  const input = {
    managedAgentPubkeys: [],
    relayAgents: agents,
    sharedChannelIds: new Set([scope.channelId]),
  };
  assert.deepEqual(
    [
      ...getMentionableAgentPubkeys({
        ...input,
        eligibilityScope: { type: "channel", channelId: scope.channelId },
      }),
    ],
    [key],
  );
  for (const eligibilityScope of [
    { type: "community" },
    { type: "owned", channelId: scope.channelId },
    { type: "channel", channelId: "foreign" },
  ])
    assert.equal(
      getMentionableAgentPubkeys({ ...input, eligibilityScope }).size,
      0,
    );
});
test("native response pins reject identity relay and destination changes", () => {
  for (const field of ["relay_url", "human_pubkey", "channel_id"])
    assert.throws(() =>
      companyMentionRows({ ...result(), [field]: "other" }, scope),
    );
});
test("selected recipient cannot disappear or be replaced by another key", () => {
  assert.throws(() =>
    companyMentionRows({ ...result(), agents: [] }, scope, [key]),
  );
  assert.throws(() => companyMentionRows(result(), scope, ["c".repeat(64)]));
  const value = result();
  value.agents.push({ ...value.agents[0] });
  assert.throws(() => companyMentionRows(value, scope));
});
test("canonical company send revalidates without calling the legacy policy path", async () => {
  let legacyCalls = 0;
  assert.deepEqual(
    await revalidateAgentMentionPubkeys({
      ...options(),
      fetchRelayAgents: async () => {
        legacyCalls++;
        return [];
      },
      fetchCompanyAgents: async (keys, channelId) => {
        assert.deepEqual(keys, [key]);
        assert.equal(channelId, scope.channelId);
        return rows();
      },
    }),
    [key],
  );
  assert.equal(legacyCalls, 0);
});
test("revoked company evidence cannot fall through to local or legacy policy", async () => {
  for (const fetchCompanyAgents of [
    async () => [],
    async () => {
      throw new Error("revoked");
    },
  ])
    await assert.rejects(
      revalidateAgentMentionPubkeys({
        ...options(),
        fetchCompanyAgents,
        refetchManagedAgents: async () => ({
          data: [{ pubkey: key }],
          error: null,
        }),
      }),
      AgentMentionAuthorizationError,
    );
});
test("company projection cannot authorize another channel or an owner-only DM", async () => {
  for (const eligibilityScope of [
    { type: "channel", channelId: "other" },
    { type: "owned", channelId: scope.channelId },
  ])
    await assert.rejects(
      revalidateAgentMentionPubkeys({ ...options(), eligibilityScope }),
      AgentMentionAuthorizationError,
    );
});
test("mixed company and legacy mentions preserve both fresh authorization paths", async () => {
  const other = "f".repeat(64);
  assert.deepEqual(
    await revalidateAgentMentionPubkeys({
      ...options(),
      pubkeys: [key, other],
      agentPubkeys: new Set([key, other]),
      fetchRelayAgents: async (keys) => {
        assert.deepEqual(keys, [other]);
        return [
          {
            pubkey: other,
            respondTo: "anyone",
            respondToAllowlist: [],
            channelIds: [scope.channelId],
          },
        ];
      },
    }),
    [key, other],
  );
});
