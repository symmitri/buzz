import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDirectMessageIntro,
  isSelfDirectMessage,
} from "./dmParticipantDisplay.ts";

const own = "a".repeat(64);
const peer = "b".repeat(64);
const channel = (participantPubkeys, participants = []) => ({
  channelType: "dm",
  participantPubkeys,
  participants,
});

test("recognizes only an exact one-member own-key DM", () => {
  assert.equal(isSelfDirectMessage(channel([own]), own.toUpperCase()), true);
  assert.equal(isSelfDirectMessage(channel([own, peer]), own), false);
  assert.equal(isSelfDirectMessage(channel([peer]), own), false);
  assert.equal(isSelfDirectMessage(channel([]), own), false);
});

test("self-DM intro uses notes copy and the owner's real avatar", () => {
  assert.deepEqual(
    buildDirectMessageIntro({
      channel: channel([own], ["Jonathan Poma"]),
      currentPubkey: own,
      profiles: {
        [own]: {
          displayName: "Jonathan Poma",
          avatarUrl: "https://example.test/jonathan.png",
          nip05Handle: null,
          ownerPubkey: null,
        },
      },
    }),
    {
      displayName: "Notes to yourself",
      isSelf: true,
      participants: [
        {
          avatarUrl: "https://example.test/jonathan.png",
          displayName: "You",
          pubkey: own,
        },
      ],
    },
  );
});

test("ordinary DMs retain participant copy", () => {
  const intro = buildDirectMessageIntro({
    channel: channel([own, peer], ["Jonathan", "Avery"]),
    currentPubkey: own,
  });
  assert.equal(intro?.displayName, "Avery");
  assert.equal(intro?.isSelf, false);
});
