// Symmitri: one relay-backed profile projection for detail and chat surfaces.
import type { QueryClient } from "@tanstack/react-query";
import type {
  Profile,
  UserProfileSummary,
  UsersBatchResponse,
} from "@/shared/api/types";
import { writeCachedUserLabels } from "./lib/userLabelStorage";

export type UsersBatchEntry = {
  summary: UserProfileSummary | null;
  fetchedAt: number;
  missCount?: number;
};
export const usersBatchEntryKey = (pubkey: string) => [
  "users-batch-entry",
  pubkey.toLowerCase(),
];
export const USERS_BATCH_ENTRY_FRESH_MS = 10 * 60_000;
export const USERS_BATCH_MISS_FRESH_MS = 30_000;
export const USERS_BATCH_MISS_MAX_READS = 4;
export function shouldRetryMissingProfiles(
  client: QueryClient,
  missing: string[],
): boolean {
  return missing.some(
    (pubkey) =>
      (client.getQueryData<UsersBatchEntry>(usersBatchEntryKey(pubkey))
        ?.missCount ?? 0) < USERS_BATCH_MISS_MAX_READS,
  );
}
export function isUsersBatchEntryFresh(
  entry: UsersBatchEntry,
  now: number,
): boolean {
  return (
    now - entry.fetchedAt <
    (entry.summary ? USERS_BATCH_ENTRY_FRESH_MS : USERS_BATCH_MISS_FRESH_MS)
  );
}
export function evictUsersBatchEntries(client: QueryClient, pubkeys: string[]) {
  for (const pubkey of pubkeys)
    client.removeQueries({ queryKey: usersBatchEntryKey(pubkey), exact: true });
}

/** Only call for a completed native kind-0 read, never a placeholder or directory label.
 * Native verifies the event and exact NIP-OA delegation before returning ownerPubkey.
 * Null ownership replaces old ownership; local management and message auth tags
 * are not alternative authority sources. */
export async function syncFetchedUserProfile(
  client: QueryClient,
  profile: Profile,
  relayUrl: string,
  signal: AbortSignal,
) {
  const pubkey = profile.pubkey.toLowerCase();
  await client.cancelQueries({
    predicate: (query) =>
      query.queryKey[0] === "users-batch" && query.queryKey.includes(pubkey),
  });
  signal.throwIfAborted();
  const previous = client.getQueryData<UsersBatchEntry>(
    usersBatchEntryKey(pubkey),
  )?.summary;
  const summary: UserProfileSummary | null = profile.hasProfileEvent
    ? {
        displayName: profile.displayName,
        name: previous?.name ?? null,
        avatarUrl: profile.avatarUrl,
        nip05Handle: profile.nip05Handle,
        ownerPubkey: profile.ownerPubkey,
        isAgent: profile.ownerPubkey !== null,
      }
    : null;
  client.setQueryData<UsersBatchEntry>(usersBatchEntryKey(pubkey), {
    summary,
    fetchedAt: Date.now(),
    missCount: summary ? 0 : 1,
  });
  for (const query of client
    .getQueryCache()
    .findAll({
      predicate: (query) =>
        query.queryKey[0] === "users-batch" && query.queryKey.includes(pubkey),
    })) {
    client.setQueryData<UsersBatchResponse>(query.queryKey, (existing) => {
      const current = existing ?? {
        profiles: {},
        missing: query.queryKey.slice(1) as string[],
      };
      const profiles = { ...current.profiles };
      if (summary) profiles[pubkey] = summary;
      else delete profiles[pubkey];
      const missing = current.missing.filter((key) => key !== pubkey);
      if (!summary) missing.push(pubkey);
      return { profiles, missing };
    });
    // A canceled first fetch still needs the other participants. The new exact
    // entry is already seeded, so the delta fetch cannot refetch this profile.
    if (
      query.state.dataUpdatedAt &&
      (query.state.data as UsersBatchResponse).missing.some(
        (key) =>
          key !== pubkey && !client.getQueryData(usersBatchEntryKey(key)),
      )
    ) {
      void client.invalidateQueries({ queryKey: query.queryKey, exact: true });
    }
  }
  if (relayUrl)
    writeCachedUserLabels(
      relayUrl,
      summary ? { [pubkey]: summary } : {},
      summary ? [] : [pubkey],
    );
}
