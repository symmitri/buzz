import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
const peer = "b".repeat(64),
  human = "a".repeat(64),
  other = "c".repeat(64),
  relay = "wss://alpha.example";
let client, commands, batchResult, detailResult;
const summary = (over = {}) => ({
  display_name: "Fresh Agent",
  name: "agent-alias",
  avatar_url: null,
  nip05_handle: null,
  owner_pubkey: human,
  is_agent: true,
  ...over,
});
const detail = (over = {}) => ({
  pubkey: peer,
  ...summary(),
  about: "Private Agent",
  has_profile_event: true,
  ...over,
});
before(() => {
  Object.assign(globalThis, {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  localStorage.setItem(
    "buzz-communities",
    JSON.stringify([
      {
        id: "alpha",
        name: "Alpha",
        relayUrl: relay,
        pubkey: human,
        addedAt: "2026-01-01",
      },
    ]),
  );
  localStorage.setItem("buzz-active-community-id", "alpha");
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      commands.push([command, args]);
      if (command === "get_identity")
        return { pubkey: human, display_name: "Owner" };
      if (command === "get_users_batch")
        return typeof batchResult === "function"
          ? batchResult(args)
          : batchResult;
      if (command === "get_user_profile") return detailResult;
      throw new Error(`Unexpected IPC ${command}`);
    },
  };
});
afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
  client?.clear();
});
after(() => dom.window.close());

async function mount({ showDetail = false, extra = false } = {}) {
  commands = [];
  batchResult = { profiles: {}, missing: [peer] };
  detailResult = detail();
  const React = await import("react");
  const { render, act } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { CommunitiesProvider } = await import(
    "@/features/communities/useCommunities"
  );
  const { useUsersBatchQuery, useUserProfileQuery } = await import(
    "./hooks.ts"
  );
  const { resolveUserLabel } = await import("./lib/identity.ts");
  const { formatTimelineMessages } = await import(
    "@/features/messages/lib/formatTimelineMessages"
  );
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryData(["identity"], { pubkey: human, displayName: "Owner" });
  const snapshots = {};
  function View({ panel = showDetail }) {
    const batch = useUsersBatchQuery(extra ? [peer, other] : [peer]);
    const second = useUsersBatchQuery([peer, human]);
    const profile = useUserProfileQuery(panel ? peer : undefined);
    // UserProfilePanel explicitly refreshes on open, even if a batch summary
    // seeded its detail key. Exercise that same hook boundary here.
    React.useEffect(() => {
      if (panel) void profile.refetch();
    }, [panel, profile.refetch]);
    snapshots.batch = batch;
    snapshots.profile = profile;
    snapshots.second = second;
    const message = formatTimelineMessages(
      [
        {
          id: "d".repeat(64),
          pubkey: peer,
          kind: 9,
          created_at: 1,
          content: "Existing message",
          tags: [["h", "same-dm"]],
          sig: "",
        },
      ],
      null,
      human,
      null,
      batch.data?.profiles,
      [{ pubkey: peer, role: "bot" }],
    )[0];
    return React.createElement(
      "div",
      null,
      React.createElement(
        "span",
        { "data-testid": "header" },
        resolveUserLabel({
          pubkey: peer,
          fallbackName: peer,
          profiles: batch.data?.profiles,
        }),
      ),
      React.createElement(
        "span",
        { "data-testid": "sidebar" },
        resolveUserLabel({
          pubkey: peer,
          fallbackName: peer,
          profiles: second.data?.profiles,
        }),
      ),
      React.createElement("span", { "data-testid": "author" }, message.author),
      React.createElement(
        "span",
        { "data-testid": "owner" },
        message.ownerLabel ?? "owner unavailable",
      ),
      React.createElement(
        "span",
        { "data-testid": "panel" },
        profile.data?.displayName ?? "",
      ),
    );
  }
  const tree = (panel) =>
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        CommunitiesProvider,
        null,
        React.createElement(View, { panel }),
      ),
    );
  let view;
  await act(async () => {
    view = render(tree(showDetail));
  });
  return {
    ...view,
    snapshots,
    async panel() {
      await act(async () => {
        view.rerender(tree(true));
      });
    },
  };
}

test("opening a fresh profile repairs every chat label and verified owner after a cached miss", async () => {
  const { waitFor } = await import("@testing-library/react");
  const view = await mount();
  await waitFor(() => assert.equal(view.snapshots.batch.isSuccess, true));
  assert.equal(view.getByTestId("header").textContent, "npub1hwa…04hu");
  assert.equal(view.getByTestId("owner").textContent, "owner unavailable");
  const callsBefore = commands.length;
  await view.panel();
  await waitFor(() =>
    assert.equal(view.getByTestId("owner").textContent, "you"),
  );
  for (const field of ["header", "sidebar", "author", "panel"])
    assert.equal(view.getByTestId(field).textContent, "Fresh Agent");
  assert.deepEqual(
    commands.slice(callsBefore).map(([name]) => name),
    ["get_user_profile"],
  );
  assert.equal(
    client.getQueryData(["users-batch-entry", peer]).summary.ownerPubkey,
    human,
  );
  assert.equal(
    client.getQueryData(["users-batch", peer]).missing.includes(peer),
    false,
  );
  assert.equal(view.snapshots.batch.data.profiles[peer].isAgent, true);
});

test("a late canceled native batch cannot overwrite a newer profile or owner", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const view = await mount();
  await waitFor(() => assert.equal(view.snapshots.batch.isSuccess, true));
  client.removeQueries({ queryKey: ["users-batch-entry", peer] });
  let finish;
  batchResult = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  let old;
  await act(async () => {
    old = view.snapshots.batch.refetch();
  });
  await waitFor(() => assert.equal(typeof finish, "function"));
  await view.panel();
  await waitFor(() =>
    assert.equal(view.getByTestId("owner").textContent, "you"),
  );
  await act(async () => {
    finish({ profiles: {}, missing: [peer] });
    await old;
  });
  assert.equal(view.getByTestId("header").textContent, "Fresh Agent");
  assert.equal(
    client.getQueryData(["users-batch-entry", peer]).summary.ownerPubkey,
    human,
  );
});

test("a refreshed unverified profile clears prior owner and a missing profile clears prior metadata", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const view = await mount({ showDetail: true });
  await waitFor(() =>
    assert.equal(view.getByTestId("owner").textContent, "you"),
  );
  detailResult = detail({ owner_pubkey: null, is_agent: false });
  await act(async () => {
    await view.snapshots.profile.refetch();
  });
  await waitFor(() =>
    assert.equal(view.getByTestId("owner").textContent, "owner unavailable"),
  );
  assert.equal(
    client.getQueryData(["users-batch-entry", peer]).summary.isAgent,
    false,
  );
  detailResult = detail({
    display_name: null,
    owner_pubkey: null,
    has_profile_event: false,
  });
  await act(async () => {
    await view.snapshots.profile.refetch();
  });
  await waitFor(() =>
    assert.equal(view.getByTestId("header").textContent, "npub1hwa…04hu"),
  );
  assert.equal(client.getQueryData(["users-batch-entry", peer]).summary, null);
});

test("unresolved active profiles recover on the short interval without refetching known users", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const { USERS_BATCH_MISS_FRESH_MS } = await import("./userProfileCache.ts");
  const view = await mount({ extra: true });
  await waitFor(() => assert.equal(view.snapshots.batch.isSuccess, true));
  const entryKey = ["users-batch-entry", other];
  client.setQueryData(entryKey, {
    fetchedAt: Date.now(),
    summary: {
      displayName: "Known",
      avatarUrl: null,
      nip05Handle: null,
      ownerPubkey: null,
    },
  });
  // Advance only the unresolved entry across the actual freshness boundary.
  client.setQueryData(["users-batch-entry", peer], {
    fetchedAt: Date.now() - USERS_BATCH_MISS_FRESH_MS - 1,
    summary: null,
  });
  const query = client
    .getQueryCache()
    .find({ queryKey: ["users-batch", peer, other], exact: true });
  assert.equal(query.options.refetchInterval(query), USERS_BATCH_MISS_FRESH_MS);
  batchResult = { profiles: { [peer]: summary() }, missing: [] };
  const before = commands.length;
  await act(async () => {
    await view.snapshots.batch.refetch();
  });
  await waitFor(() =>
    assert.equal(view.getByTestId("header").textContent, "Fresh Agent"),
  );
  assert.deepEqual(commands.slice(before), [
    ["get_users_batch", { pubkeys: [peer] }],
  ]);
  assert.equal(query.options.refetchInterval(query), false);
});

test("gallery names are current-account presentation only and never seed verified profile ownership", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const { agentDisplayLabelsKey } = await import("./agentDisplayLabels.ts");
  const view = await mount();
  await waitFor(() => assert.equal(view.snapshots.batch.isSuccess, true));
  await act(async () => {
    client.setQueryData(agentDisplayLabelsKey(relay, other), {
      [peer]: "Other account",
    });
  });
  assert.notEqual(view.getByTestId("header").textContent, "Other account");
  await act(async () => {
    client.setQueryData(agentDisplayLabelsKey(relay, human), {
      [peer]: "Directory Agent",
    });
  });
  await waitFor(() =>
    assert.equal(view.getByTestId("header").textContent, "Directory Agent"),
  );
  assert.equal(view.getByTestId("owner").textContent, "owner unavailable");
  assert.equal(client.getQueryData(["users-batch-entry", peer]).summary, null);
  assert.equal(client.getQueryData(["user-profile", peer]), undefined);
  assert.deepEqual(client.getQueryData(["users-batch", peer]).profiles, {});
  await view.panel();
  await waitFor(() =>
    assert.equal(view.getByTestId("header").textContent, "Fresh Agent"),
  );
  await act(async () => {
    client.setQueryData(agentDisplayLabelsKey(relay, human), {});
  });
  assert.equal(view.getByTestId("header").textContent, "Fresh Agent");
});

test("unknown public keys stop interval polling after four relay misses", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const { USERS_BATCH_MISS_FRESH_MS } = await import("./userProfileCache.ts");
  const view = await mount();
  await waitFor(() => assert.equal(view.snapshots.batch.isSuccess, true));
  const query = client
    .getQueryCache()
    .find({ queryKey: ["users-batch", peer], exact: true });
  while (client.getQueryData(["users-batch-entry", peer]).missCount < 4) {
    assert.equal(
      query.options.refetchInterval(query),
      USERS_BATCH_MISS_FRESH_MS,
    );
    const old = client.getQueryData(["users-batch-entry", peer]);
    client.setQueryData(["users-batch-entry", peer], {
      ...old,
      fetchedAt: Date.now() - USERS_BATCH_MISS_FRESH_MS - 1,
    });
    await act(async () => {
      await view.snapshots.batch.refetch();
    });
  }
  assert.equal(client.getQueryData(["users-batch-entry", peer]).missCount, 4);
  assert.equal(query.options.refetchInterval(query), false);
});

test("a known profile refresh replaces its name/avatar everywhere and retains mention aliases", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const view = await mount();
  await waitFor(() => assert.equal(view.snapshots.batch.isSuccess, true));
  client.setQueryData(["users-batch-entry", peer], {
    fetchedAt: Date.now(),
    summary: {
      displayName: "Old Agent",
      name: "old-alias",
      avatarUrl: "https://example.test/old.png",
      nip05Handle: null,
      ownerPubkey: human,
      isAgent: true,
    },
  });
  await act(async () => {
    await view.snapshots.batch.refetch();
  });
  detailResult = detail({
    display_name: "Renamed Agent",
    avatar_url: "https://example.test/new.png",
  });
  await view.panel();
  await waitFor(() =>
    assert.equal(view.getByTestId("header").textContent, "Renamed Agent"),
  );
  for (const field of ["sidebar", "author", "panel"])
    assert.equal(view.getByTestId(field).textContent, "Renamed Agent");
  for (const key of [
    ["users-batch", peer],
    ["users-batch", human, peer],
  ]) {
    const profile = client.getQueryData(key).profiles[peer];
    assert.equal(profile.avatarUrl, "https://example.test/new.png");
    assert.equal(profile.ownerPubkey, human);
    assert.equal(profile.name, "old-alias");
  }
});
