import assert from "node:assert/strict";
import test from "node:test";

import {
  currentHumanDmRecipient,
  dmChannelMatchesRequest,
  isSelfDmRecipient,
  normalizeNewDmRecipients,
} from "./selfDm.ts";

const own = "a".repeat(64);
const peer = "b".repeat(64);
const other = "c".repeat(64);

test("recognizes only the same valid normalized public key as self", () => {
  assert.equal(isSelfDmRecipient(` ${own.toUpperCase()} `, own), true);
  assert.equal(isSelfDmRecipient(peer, own), false);
  assert.equal(isSelfDmRecipient("", ""), false);
  assert.equal(isSelfDmRecipient("invalid", "invalid"), false);
  assert.equal(isSelfDmRecipient(own, undefined), false);
});

test("builds the self picker row only from the matching signed identity", () => {
  assert.deepEqual(
    currentHumanDmRecipient(
      { pubkey: own.toUpperCase(), displayName: " Jonathan Poma " },
      own,
    ),
    {
      pubkey: own,
      displayName: "Jonathan Poma",
      avatarUrl: null,
      nip05Handle: null,
      ownerPubkey: null,
      isAgent: false,
    },
  );
  assert.equal(
    currentHumanDmRecipient(
      { pubkey: peer, displayName: "Jonathan Poma" },
      own,
    ),
    null,
  );
  assert.equal(
    currentHumanDmRecipient({ pubkey: own, displayName: "Jonathan" }, "bad"),
    null,
  );
});

test("uses the real self profile instead of the native compact-key fallback", () => {
  assert.deepEqual(
    currentHumanDmRecipient(
      { pubkey: own, displayName: "npub1abcd…wxyz" },
      own,
      {
        pubkey: own,
        displayName: "Jonathan Poma",
        avatarUrl: "https://example.test/jonathan.png",
        about: null,
        nip05Handle: "jonathan@symmitri.ai",
        ownerPubkey: null,
        hasProfileEvent: true,
      },
    ),
    {
      pubkey: own,
      displayName: "Jonathan Poma",
      avatarUrl: "https://example.test/jonathan.png",
      nip05Handle: "jonathan@symmitri.ai",
      ownerPubkey: null,
      isAgent: false,
    },
  );

  assert.equal(
    currentHumanDmRecipient(
      { pubkey: own, displayName: "npub1abcd…wxyz" },
      own,
      {
        pubkey: peer,
        displayName: "Wrong account",
        avatarUrl: "https://example.test/wrong.png",
        about: null,
        nip05Handle: null,
        ownerPubkey: null,
        hasProfileEvent: true,
      },
    )?.displayName,
    "npub1abcd…wxyz",
  );
});

test("normalizes an explicit self recipient without dropping its own key", () => {
  assert.deepEqual(normalizeNewDmRecipients([own.toUpperCase()], own), [own]);
  assert.deepEqual(normalizeNewDmRecipients([peer, other], own), [peer, other]);
});

test("rejects empty, malformed, duplicate, oversized, and mixed-self audiences", () => {
  assert.throws(
    () => normalizeNewDmRecipients([], own),
    /between one and eight/,
  );
  assert.throws(() => normalizeNewDmRecipients(["bad"], own), /valid person/);
  assert.throws(
    () => normalizeNewDmRecipients([peer, peer.toUpperCase()], own),
    /each recipient once/,
  );
  assert.throws(
    () => normalizeNewDmRecipients([own, peer], own),
    /yourself separately/,
  );
  assert.throws(
    () =>
      normalizeNewDmRecipients(
        Array.from({ length: 9 }, (_, index) =>
          (index + 1).toString(16).padStart(64, "0"),
        ),
        own,
      ),
    /between one and eight/,
  );
  assert.throws(
    () => normalizeNewDmRecipients([peer], "unavailable"),
    /identity is unavailable/,
  );
});

test("matches only the exact canonical participant set", () => {
  assert.equal(dmChannelMatchesRequest([own], [own], own), true);
  assert.equal(dmChannelMatchesRequest([own, peer], [peer], own), true);
  assert.equal(
    dmChannelMatchesRequest(
      [peer.toUpperCase(), own.toUpperCase()],
      [peer],
      own,
    ),
    true,
  );
  assert.equal(dmChannelMatchesRequest([own, peer], [own], own), false);
  assert.equal(dmChannelMatchesRequest([own], [peer], own), false);
  assert.equal(dmChannelMatchesRequest([own, peer, peer], [peer], own), false);
  assert.equal(dmChannelMatchesRequest([own, "bad"], [peer], own), false);
  assert.equal(dmChannelMatchesRequest([own], [own, peer], own), false);
});
