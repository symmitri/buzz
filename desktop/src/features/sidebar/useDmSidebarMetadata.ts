import * as React from "react";

import { usePresenceQuery } from "@/features/presence/hooks";
import { isSelfDirectMessage } from "@/features/channels/lib/dmParticipantDisplay";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveChannelDisplayLabel } from "@/features/sidebar/lib/channelLabels";
import type { SidebarDmParticipant } from "@/features/sidebar/ui/SidebarSection";
import type { Channel, PresenceStatus } from "@/shared/api/types";

export function useDmSidebarMetadata({
  currentPubkey,
  directMessages,
  fallbackDisplayName,
  profileAvatarUrl,
  profileDisplayName,
  enabled = true,
}: {
  currentPubkey?: string;
  directMessages: Channel[];
  fallbackDisplayName?: string;
  profileAvatarUrl?: string | null;
  profileDisplayName?: string | null;
  enabled?: boolean;
}) {
  const selfDmLabels = React.useMemo(
    () =>
      new Set(
        [profileDisplayName, fallbackDisplayName]
          .map((value) => value?.trim().toLowerCase())
          .filter((value): value is string => Boolean(value)),
      ),
    [fallbackDisplayName, profileDisplayName],
  );
  const dmParticipantPubkeys = React.useMemo(
    () =>
      directMessages.flatMap((channel) =>
        channel.participantPubkeys.filter((pubkey, index) => {
          const normalizedPubkey = pubkey.toLowerCase();
          if (normalizedPubkey === currentPubkey?.toLowerCase()) {
            return false;
          }

          const participantLabel =
            channel.participants[index]?.trim().toLowerCase() ?? null;
          return !participantLabel || !selfDmLabels.has(participantLabel);
        }),
      ),
    [currentPubkey, directMessages, selfDmLabels],
  );
  const dmPresenceQuery = usePresenceQuery(dmParticipantPubkeys, {
    enabled: enabled && directMessages.length > 0,
  });
  const dmProfilesQuery = useUsersBatchQuery(dmParticipantPubkeys, {
    enabled: enabled && directMessages.length > 0,
  });
  const dmProfiles = dmProfilesQuery.data?.profiles;
  const dmPresenceByChannelId = React.useMemo(
    () =>
      Object.fromEntries(
        directMessages.flatMap((channel) => {
          if (isSelfDirectMessage(channel, currentPubkey)) {
            return [];
          }
          const otherParticipantPubkey = channel.participantPubkeys.find(
            (pubkey, index) => {
              const normalizedPubkey = pubkey.toLowerCase();
              if (normalizedPubkey === currentPubkey?.toLowerCase()) {
                return false;
              }

              const participantLabel =
                channel.participants[index]?.trim().toLowerCase() ?? null;
              return !participantLabel || !selfDmLabels.has(participantLabel);
            },
          );

          return [
            [
              channel.id,
              otherParticipantPubkey
                ? (dmPresenceQuery.data?.[
                    otherParticipantPubkey.toLowerCase()
                  ] ?? "offline")
                : "offline",
            ],
          ];
        }),
      ) satisfies Record<string, PresenceStatus>,
    [currentPubkey, directMessages, dmPresenceQuery.data, selfDmLabels],
  );
  const dmChannelLabels = React.useMemo(
    () =>
      Object.fromEntries(
        directMessages.map((channel) => [
          channel.id,
          resolveChannelDisplayLabel(
            channel,
            currentPubkey,
            dmProfilesQuery.data?.profiles,
          ),
        ]),
      ),
    [currentPubkey, directMessages, dmProfilesQuery.data],
  );
  const dmParticipantsByChannelId = React.useMemo(
    () =>
      Object.fromEntries(
        directMessages.map((channel) => {
          if (isSelfDirectMessage(channel, currentPubkey)) {
            return [
              channel.id,
              [
                {
                  avatarUrl: profileAvatarUrl ?? null,
                  label:
                    profileDisplayName?.trim() ||
                    fallbackDisplayName?.trim() ||
                    "You",
                  pubkey: channel.participantPubkeys[0] ?? currentPubkey ?? "",
                },
              ],
            ];
          }
          const participants = channel.participantPubkeys.map(
            (pubkey, index) => ({
              fallbackName: channel.participants[index] ?? null,
              pubkey,
            }),
          );
          const otherParticipants = participants.filter((participant) => {
            if (
              participant.pubkey.toLowerCase() === currentPubkey?.toLowerCase()
            ) {
              return false;
            }

            const participantLabel =
              participant.fallbackName?.trim().toLowerCase() ?? null;
            return !participantLabel || !selfDmLabels.has(participantLabel);
          });
          const visibleParticipants =
            otherParticipants.length > 0 ? otherParticipants : participants;

          return [
            channel.id,
            visibleParticipants.map((participant) => ({
              avatarUrl:
                dmProfiles?.[participant.pubkey.toLowerCase()]?.avatarUrl ??
                null,
              label: resolveUserLabel({
                currentPubkey,
                fallbackName: participant.fallbackName,
                profiles: dmProfiles,
                pubkey: participant.pubkey,
              }),
              ...(dmProfiles?.[participant.pubkey.toLowerCase()]?.isAgent ===
              true
                ? { isAgent: true }
                : {}),
              pubkey: participant.pubkey,
            })),
          ];
        }),
      ) satisfies Record<string, SidebarDmParticipant[]>,
    [
      currentPubkey,
      directMessages,
      dmProfiles,
      fallbackDisplayName,
      profileAvatarUrl,
      profileDisplayName,
      selfDmLabels,
    ],
  );

  return {
    dmChannelLabels,
    dmParticipantsByChannelId,
    dmPresenceByChannelId,
  };
}
