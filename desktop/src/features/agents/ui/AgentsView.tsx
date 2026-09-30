// Symmitri: show governed Agents; Alpha does not launch local starter personas.
import { invoke } from "@tauri-apps/api/core";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useOpenDmMutation } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import {
  SpacesAgentsGallery,
  type AgentDirectory,
} from "./SpacesAgentsGallery";

const readDirectory = () => invoke<AgentDirectory>("spaces_list_agents");

export function AgentsView() {
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery();
  const openDm = useOpenDmMutation();
  const { goChannel } = useAppNavigation();
  const relayUrl = activeCommunity?.relayUrl ?? "";
  const humanPubkey = identity.data?.pubkey ?? "";
  return (
    <SpacesAgentsGallery
      key={`${relayUrl}|${humanPubkey}`}
      relayUrl={relayUrl}
      humanPubkey={humanPubkey}
      readDirectory={readDirectory}
      openConversation={async (pubkey) => {
        const conversation = await openDm.mutateAsync({
          pubkeys: [pubkey],
          expectedRelayUrl: relayUrl,
          expectedSignerPubkey: humanPubkey,
        });
        return conversation.id;
      }}
      navigate={(id) => {
        void goChannel(id);
      }}
    />
  );
}
