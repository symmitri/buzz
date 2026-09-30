// Symmitri: channel membership and reply access use the same governed identity.
import { useQueryClient } from "@tanstack/react-query";
import { useCommunities } from "@/features/communities/useCommunities";
import { invalidateChannelState } from "@/features/channels/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { SpacesChannelAgentsDialog } from "./SpacesChannelAgentsDialog";
import { companyChannelMentionsQueryKey } from "@/features/messages/lib/useCompanyChannelMentions";

export function AlphaChannelBotDialog({
  channelId,
  open,
  onOpenChange,
}: {
  channelId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery();
  const queryClient = useQueryClient();
  const relayUrl = activeCommunity?.relayUrl ?? "";
  const humanPubkey = identity.data?.pubkey ?? "";
  return (
    <SpacesChannelAgentsDialog
      key={JSON.stringify([relayUrl, humanPubkey, channelId])}
      channelId={channelId}
      relayUrl={relayUrl}
      humanPubkey={humanPubkey}
      open={open}
      onOpenChange={onOpenChange}
      onAdded={() => {
        void invalidateChannelState(queryClient, channelId);
        void queryClient.invalidateQueries({ queryKey: ["relay-agents"] });
        void queryClient.invalidateQueries({
          queryKey: companyChannelMentionsQueryKey,
        });
      }}
    />
  );
}
