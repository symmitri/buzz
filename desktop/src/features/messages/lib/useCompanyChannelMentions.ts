import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import * as React from "react";
import { useCommunities } from "@/features/communities/useCommunities";
import { IS_SPACES_ALPHA } from "@/shared/lib/product-brand";
import {
  readCompanyChannelMentions,
  revalidateCompanyChannelMentions,
  type CompanyMentionScope,
} from "./companyChannelMentions";

export const companyChannelMentionsQueryKey = ["spaces-company-mentions"];

export function useCompanyChannelMentions(
  channelId: string | null,
  channelType: string | null | undefined,
  humanPubkey: string | null,
) {
  const { activeCommunity } = useCommunities();
  const relayUrl = activeCommunity?.relayUrl ?? "";
  const enabled = Boolean(
    IS_SPACES_ALPHA &&
      (channelType === "stream" || channelType === "dm") &&
      channelId &&
      relayUrl &&
      humanPubkey,
  );
  const scope = React.useMemo(
    () => ({
      channelId: channelId ?? "",
      relayUrl,
      humanPubkey: humanPubkey ?? "",
    }),
    [channelId, relayUrl, humanPubkey],
  );
  return useScopedCompanyMentions(enabled, scope);
}

/** Hints are scoped; every send still needs a new native authorization read. */
export function useScopedCompanyMentions(
  enabled: boolean,
  scope: CompanyMentionScope,
) {
  const [generation, setGeneration] = React.useState(0);
  const queryClient = useQueryClient();
  const identityKey = JSON.stringify([enabled, scope.relayUrl, scope.humanPubkey, scope.channelId]);
  const epoch = React.useRef(0);
  const scopeKey = JSON.stringify([
    enabled,
    scope.relayUrl,
    scope.humanPubkey,
    scope.channelId,
    generation,
  ]);
  const currentScope = React.useRef(scopeKey);
  if (currentScope.current !== scopeKey) {
    epoch.current++;
    currentScope.current = scopeKey;
  }
  const generationEpoch = epoch.current;
  const mounted = React.useRef(true);
  const known = React.useRef({ scopeKey: identityKey, keys: new Set<string>() });
  React.useEffect(() => {
    if (!enabled) return;
    return queryClient.getQueryCache().subscribe(event => {
      const key = event.query.queryKey;
      if (event.type === "updated" && event.action.type === "invalidate" && key[0] === "channels" && (key.length === 1 || key[1] === scope.channelId))
        void queryClient.invalidateQueries({ queryKey: [...companyChannelMentionsQueryKey, scope] });
    });
  }, [enabled, queryClient, scope]);
  React.useEffect(() => {
    mounted.current = true;
    if (!enabled)
      return () => {
        mounted.current = false;
      };
    const listener = listen("spaces-connections-invalidated", () => {
      epoch.current++;
      setGeneration((value) => value + 1);
    });
    return () => {
      mounted.current = false;
      void listener.then((unlisten) => unlisten());
    };
  }, [enabled]);
  const query = useQuery({
    queryKey: [...companyChannelMentionsQueryKey, scope, generation],
    enabled,
    queryFn: () => readCompanyChannelMentions(scope),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const data = enabled && query.error === null ? query.data : undefined;
  const knownCompanyPubkeys = React.useMemo(() => {
    const keys = new Set(
      known.current.scopeKey === identityKey ? known.current.keys : [],
    );
    for (const agent of data ?? []) keys.add(agent.pubkey);
    known.current = { scopeKey: identityKey, keys };
    return keys;
  }, [data, identityKey]);
  const revalidate = React.useCallback(
    async (pubkeys: string[], destinationChannelId: string) => {
      const started = generationEpoch;
      const current = () => {
        if (
          !enabled ||
          !mounted.current ||
          currentScope.current !== scopeKey ||
          started !== epoch.current ||
          destinationChannelId !== scope.channelId
        ) {
          throw new Error("Company agent destination changed.");
        }
      };
      current();
      const rows = await revalidateCompanyChannelMentions(scope, pubkeys);
      current();
      return rows;
    },
    [enabled, scope, scopeKey, generationEpoch],
  );
  return { data, revalidate, knownCompanyPubkeys };
}
