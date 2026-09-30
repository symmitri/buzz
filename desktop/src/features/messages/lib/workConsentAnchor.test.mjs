import assert from "node:assert/strict";
import test from "node:test";
import { workConsentAnchor } from "./workConsentAnchor.ts";

test("receipt stays on its original signed request reply when new messages arrive", () => {
  const agent = "b".repeat(64);
  const reply = { id: "a".repeat(64), createdAt: 100, pubkey: agent, tags: [["client", "request-original"]] };
  const later = { id: "c".repeat(64), createdAt: 200, pubkey: agent, tags: [["client", "request-followup"]] };
  assert.equal(workConsentAnchor([reply], "request-original", agent), reply);
  assert.equal(workConsentAnchor([later, reply], "request-original", agent), reply);
  assert.equal(workConsentAnchor([{ ...reply, pubkey: "d".repeat(64) }], "request-original", agent), undefined);
  assert.equal(workConsentAnchor([{ ...reply, signerPubkey: "e".repeat(64) }], "request-original", agent), undefined);
  assert.equal(workConsentAnchor([{ ...reply, tags: [...reply.tags, ["client", "other"]] }], "request-original", agent), undefined);
  assert.equal(workConsentAnchor([reply], "request-original", undefined), undefined);
});
