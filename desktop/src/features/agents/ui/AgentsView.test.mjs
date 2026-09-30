import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("the actual gallery adapter captures both native DM guards across a queued scope change", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const relay = "wss://alpha.example.test",
    human = "a".repeat(64),
    peer = "b".repeat(64);
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
  const invocations = [];
  let dmWrites = 0;
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (command, input) => {
      if (command === "get_identity")
        return { pubkey: human, display_name: "Synthetic" };
      if (command === "spaces_list_agents")
        return {
          relay_url: relay,
          human_pubkey: human,
          agents: [
            {
              id: "agt_test",
              name: "Test Agent",
              description: "",
              private: true,
              pubkey: peer,
            },
          ],
        };
      if (command === "open_dm") {
        invocations.push(input);
        // Model an IPC that starts after native scope changes, while React still
        // has its captured scope. Production's existing native guards reject it.
        if (
          input.expectedRelayUrl !== undefined ||
          input.expectedSignerPubkey !== undefined
        )
          throw "Your messaging identity changed.";
        dmWrites++;
        throw "An unguarded DM write escaped.";
      }
      return null;
    },
    transformCallback: () => 1,
    unregisterCallback() {},
  };
  const { createElement } = await import("react");
  const { act, render, screen, fireEvent, cleanup } = await import(
    "@testing-library/react"
  );
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const {
    createRootRoute,
    createRoute,
    createRouter,
    createMemoryHistory,
    RouterProvider,
  } = await import("@tanstack/react-router");
  const { CommunitiesProvider } = await import(
    "@/features/communities/useCommunities"
  );
  const { AgentsView } = await import("./AgentsView.tsx");
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["identity"], {
    pubkey: human,
    displayName: "Synthetic",
  });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: AgentsView,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  try {
    await router.load();
    await act(async () => {
      render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            CommunitiesProvider,
            null,
            createElement(RouterProvider, { router }),
          ),
        ),
      );
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Message Test Agent" }),
    );
    await screen.findByText("Your messaging identity changed.");
    assert.deepEqual(invocations, [
      { pubkeys: [peer], expectedRelayUrl: relay, expectedSignerPubkey: human },
    ]);
    assert.equal(dmWrites, 0);
  } finally {
    cleanup();
    client.clear();
    dom.window.close();
  }
});
