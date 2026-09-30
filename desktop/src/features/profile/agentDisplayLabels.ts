// Symmitri: in-memory presentation hints from the current native Agent directory.
// Never place these hints in a verified profile cache or infer NIP-OA ownership.
import type { UsersBatchResponse } from "@/shared/api/types";
export const agentDisplayLabelsKey = (
  relayUrl: string,
  humanPubkey: string,
) => ["spaces-agent-display-labels", relayUrl, humanPubkey.toLowerCase()];
export function withAgentDisplayLabels(
  data: UsersBatchResponse | undefined,
  pubkeys: string[],
  labels: Record<string, string> | undefined,
): UsersBatchResponse | undefined {
  let profiles = data?.profiles;
  for (const pubkey of pubkeys) {
    const name = labels?.[pubkey]?.trim();
    const current = profiles?.[pubkey];
    if (!name || current?.displayName?.trim() || current?.nip05Handle?.trim())
      continue;
    profiles = {
      ...profiles,
      [pubkey]: {
        displayName: name,
        name: null,
        avatarUrl: null,
        nip05Handle: null,
        ownerPubkey: null,
        ...current,
      },
    };
    // An existing nameless signed profile retains all verified metadata.
    profiles[pubkey] = { ...profiles[pubkey], displayName: name };
  }
  return profiles === data?.profiles
    ? data
    : { profiles: profiles ?? {}, missing: data?.missing ?? pubkeys };
}
