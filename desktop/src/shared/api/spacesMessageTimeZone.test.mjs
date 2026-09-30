import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";

// Model the Alpha compile-time define, not the date-context implementation.
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url.endsWith("/product-brand.ts")) {
      return { format: "module", shortCircuit: true, source: readFileSync(new URL(url), "utf8").replace("import.meta.env?.VITE_SPACES_ALPHA", '"1"') };
    }
    return loaded;
  },
});
const calls = [];
globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
  calls.push({ command, args });
  if (command === "sign_event") return JSON.stringify({ ...args, id: "a".repeat(64), pubkey: "b".repeat(64), sig: "c".repeat(128), created_at: 1 });
  if (command === "send_channel_message") return { event_id: "d".repeat(64), parent_event_id: args.parentEventId, root_event_id: args.parentEventId, depth: 1, created_at: 1 };
  throw new Error(`Unexpected native operation: ${command}`);
} } };
const { RelayClient } = await import("./relayClientSession.ts");
const { sendChannelMessage } = await import("./tauriMessages.ts");

test("ordinary WebSocket messages and native replies both carry the Alpha device timezone to signing", async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const client = new RelayClient();
  client.ensureConnected = async () => {};
  client.publishEvent = async event => event;
  const event = await client.sendMessage("channel", "My meetings this morning", ["b".repeat(64)]);
  assert.deepEqual(event.tags.filter(tag => tag[0] === "axis-time-zone"), [["axis-time-zone", zone]]);
  assert.equal(calls[0].command, "sign_event");
  assert.deepEqual(calls[0].args.tags, event.tags);
  await sendChannelMessage("channel", "Follow up on those meetings", "a".repeat(64));
  assert.equal(calls[1].command, "send_channel_message");
  assert.equal(calls[1].args.timeZone, zone);
  assert.equal(calls[1].args.parentEventId, "a".repeat(64));
});
