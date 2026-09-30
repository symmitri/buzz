// Symmitri: show governed Agents; Alpha does not launch local starter personas.
import { invoke } from "@tauri-apps/api/core";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useOpenDmMutation } from "@/features/channels/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import { useIdentityQuery } from "@/shared/api/hooks";
import { useUserProfileQuery } from "@/features/profile/hooks";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { useProfilePanel } from "@/shared/context/ProfilePanelContext";
import {
  SpacesAgentsGallery,
  type AgentDirectory,
} from "./SpacesAgentsGallery";

const readDirectory = () => invoke<AgentDirectory>("spaces_list_agents");

function AgentAvatar({ pubkey, name }: { pubkey: string; name: string }) {
  const profile = useUserProfileQuery(pubkey);
  return (
    <ProfileAvatar
      avatarUrl={
        profile.data?.pubkey === pubkey ? profile.data.avatarUrl : null
      }
      label={name}
      shape="squircle"
      className="h-full w-full border-[3px] border-background bg-muted shadow-none"
      iconClassName="h-8 w-8"
    />
  );
}

export function AgentsView() {
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery();
  const openDm = useOpenDmMutation();
  const { goChannel } = useAppNavigation();
  const { openProfilePanel } = useProfilePanel();
  const relayUrl = activeCommunity?.relayUrl ?? "";
  const humanPubkey = identity.data?.pubkey ?? "";
  return (
    <SpacesAgentsGallery
      key={`${relayUrl}|${humanPubkey}`}
      relayUrl={relayUrl}
      humanPubkey={humanPubkey}
      readDirectory={readDirectory}
      openProfile={openProfilePanel ?? undefined}
      avatar={(pubkey, name) => (
        <AgentAvatar
          key={`${relayUrl}|${pubkey}`}
          pubkey={pubkey}
          name={name}
        />
      )}
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
