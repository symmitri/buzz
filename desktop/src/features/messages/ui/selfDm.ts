import type { Identity, Profile, UserSearchResult } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

const PUBLIC_KEY = /^[0-9a-f]{64}$/;

export function isSelfDmRecipient(
  pubkey: string,
  currentPubkey: string | undefined,
) {
  if (typeof currentPubkey !== "string") return false;
  const recipient = normalizePubkey(pubkey);
  const ownKey = normalizePubkey(currentPubkey);
  return (
    PUBLIC_KEY.test(recipient) &&
    PUBLIC_KEY.test(ownKey) &&
    recipient === ownKey
  );
}

/** Build the one current-human row from the native signing identity. */
export function currentHumanDmRecipient(
  identity: Identity | undefined,
  currentPubkey: string | undefined,
  profile?: Profile,
): UserSearchResult | null {
  if (!identity || !currentPubkey) return null;
  const ownKey = normalizePubkey(currentPubkey);
  if (!PUBLIC_KEY.test(ownKey) || normalizePubkey(identity.pubkey) !== ownKey) {
    return null;
  }
  const matchingProfile =
    profile && normalizePubkey(profile.pubkey) === ownKey ? profile : null;
  return {
    pubkey: ownKey,
    displayName:
      matchingProfile?.displayName?.trim() ||
      identity.displayName.trim() ||
      null,
    avatarUrl: matchingProfile?.avatarUrl ?? null,
    nip05Handle: matchingProfile?.nip05Handle ?? null,
    ownerPubkey: null,
    isAgent: false,
  };
}

/**
 * Normalize the explicit picker targets without dropping an own-key target.
 * The native command remains the authority and independently rejects malformed
 * input; this keeps the renderer from turning an invalid/mixed self selection
 * into a different audience before IPC.
 */
export function normalizeNewDmRecipients(
  values: readonly string[],
  currentPubkey: string | undefined,
): string[] {
  const ownKey = normalizePubkey(currentPubkey ?? "");
  if (!PUBLIC_KEY.test(ownKey)) {
    throw new Error("Your messaging identity is unavailable. Reopen Messages.");
  }
  const recipients: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const recipient = normalizePubkey(value);
    if (!PUBLIC_KEY.test(recipient)) {
      throw new Error("Choose a valid person before sending.");
    }
    if (seen.has(recipient)) {
      throw new Error("Choose each recipient once.");
    }
    seen.add(recipient);
    recipients.push(recipient);
  }
  if (recipients.length === 0 || recipients.length > 8) {
    throw new Error("Choose between one and eight recipients.");
  }
  if (recipients.includes(ownKey) && recipients.length !== 1) {
    throw new Error("Message yourself separately from other people.");
  }
  return recipients;
}

export function dmChannelMatchesRequest(
  channelParticipants: readonly string[],
  requestedRecipients: readonly string[],
  currentPubkey: string | undefined,
) {
  try {
    const ownKey = normalizePubkey(currentPubkey ?? "");
    if (!PUBLIC_KEY.test(ownKey)) return false;
    const requested = normalizeNewDmRecipients(
      requestedRecipients,
      currentPubkey,
    );
    const expected = [...new Set([ownKey, ...requested])].sort();
    const actual = channelParticipants.map(normalizePubkey).sort();
    return (
      actual.length === expected.length &&
      new Set(actual).size === actual.length &&
      actual.every(
        (pubkey, index) =>
          PUBLIC_KEY.test(pubkey) && pubkey === expected[index],
      )
    );
  } catch {
    return false;
  }
}
