import type { TimelineMessage } from "../types";

/** Presentation correlation only. Native consent remains the sole authority. */
export function workConsentAnchor(
  messages: readonly TimelineMessage[],
  requestId: string | undefined,
  agentPubkey: string | undefined,
): TimelineMessage | undefined {
  if (!requestId || !agentPubkey || !/^[a-f0-9]{64}$/.test(agentPubkey)) return;
  return messages.filter(message => {
    const clients = message.tags?.filter(tag => tag[0] === "client") ?? [];
    return !message.pending && (message.signerPubkey ?? message.pubkey) === agentPubkey &&
      clients.length === 1 && clients[0].length === 2 && clients[0][1] === requestId &&
      /^[a-f0-9]{64}$/.test(message.id) && Number.isFinite(message.createdAt) && message.createdAt > 0;
  }).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0];
}
