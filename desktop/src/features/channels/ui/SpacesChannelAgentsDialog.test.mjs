import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
let handler;
let calls = [];
let listener;
const callbacks = new Map();
const relay = "wss://alpha.example.test";
const human = "a".repeat(64);
const agentKey = "b".repeat(64);
const channelId = "11111111-1111-4111-8111-111111111111";
const snapshot = (changes = {}) => ({
  channel_id: channelId,
  relay_url: relay,
  human_pubkey: human,
  agents: [
    {
      id: "agent-symi-internal",
      name: "Symi",
      description: "Company teammate",
      pubkey: agentKey,
      in_channel: false,
      ready: false,
      can_add: true,
      ...changes,
    },
  ],
});

before(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      if (command === "plugin:event|listen") {
        if (args.event === "spaces-connections-invalidated")
          listener = callbacks.get(args.handler);
        return 1;
      }
      if (
        command === "plugin:event|unlisten" ||
        command === "set_window_vibrancy"
      )
        return;
      if (command === "get_relay_http_url") return "https://alpha.example.test";
      if (command === "get_media_proxy_port") return null;
      calls.push({ command, args });
      return handler(command, args);
    },
    transformCallback(callback) {
      const id = callbacks.size + 1;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback() {},
  };
});
afterEach(async () => {
  (await import("@testing-library/react")).cleanup();
  calls = [];
  listener = undefined;
  callbacks.clear();
});
after(() => dom.window.close());

async function mount(overrides = {}) {
  const { createElement } = await import("react");
  const { render, act } = await import("@testing-library/react");
  const { ThemeProvider } = await import("@/shared/theme/ThemeProvider");
  const { SpacesChannelAgentsDialog } = await import(
    "./SpacesChannelAgentsDialog.tsx"
  );
  const closed = [],
    added = [];
  const props = {
    channelId,
    relayUrl: relay,
    humanPubkey: human,
    open: true,
    onOpenChange: (value) => closed.push(value),
    onAdded: () => added.push(true),
    ...overrides,
  };
  const tree = (values = {}) =>
    createElement(
      ThemeProvider,
      null,
      createElement(SpacesChannelAgentsDialog, { ...props, ...values }),
    );
  let rendered;
  await act(async () => {
    rendered = render(tree());
  });
  return {
    ...rendered,
    closed,
    added,
    show: (open) => rendered.rerender(tree({ open })),
  };
}

test("loads canonical agents only on open and submits the exact native identity once", async () => {
  const { screen, fireEvent, waitFor, act } = await import(
    "@testing-library/react"
  );
  let finish;
  handler = async (command) =>
    command === "spaces_list_channel_agents"
      ? snapshot()
      : new Promise((resolve) => {
          finish = resolve;
        });
  const ui = await mount({ open: false });
  assert.deepEqual(calls, []);
  ui.show(true);
  fireEvent.click(
    await screen.findByRole("button", { name: /Symi.*Company agent/ }),
  );
  const submit = screen.getByRole("button", { name: "Add agent", exact: true });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => assert.equal(typeof finish, "function"));
  assert.deepEqual(
    calls.map(({ command }) => command),
    ["spaces_list_channel_agents", "spaces_add_channel_agent"],
  );
  assert.deepEqual(calls[1].args, {
    channelId,
    agentId: "agent-symi-internal",
    expectedPubkey: agentKey,
    expectedRelayUrl: relay,
    expectedSignerPubkey: human,
  });
  await act(async () => finish({ state: "confirmed" }));
  assert.deepEqual(ui.added, [true]);
  assert.deepEqual(ui.closed, [false]);
  assert.equal(screen.queryByText("Create a new agent"), null);
});

test("shows unavailable and already-ready agents without offering local setup", async () => {
  const { screen } = await import("@testing-library/react");
  handler = async () => ({
    ...snapshot({ ready: true, in_channel: true, can_add: false }),
    agents: [
      snapshot({ ready: true, in_channel: true, can_add: false }).agents[0],
      {
        ...snapshot({
          can_add: false,
          unavailable_reason: "A company administrator must add this agent.",
        }).agents[0],
        id: "agt_other",
        name: "Aster",
      },
    ],
  });
  await mount();
  assert.equal(
    (
      await screen.findByRole("button", {
        name: /Symi.*Company agent.*In channel/,
      })
    ).disabled,
    true,
  );
  assert.equal(
    screen.getByRole("button", {
      name: /Aster.*Company agent.*A company administrator/,
    }).disabled,
    true,
  );
  assert.equal(
    screen.getByRole("button", { name: "Add agent", exact: true }).disabled,
    true,
  );
});

test("uncertain writes require a fresh read and support membership-only repair", async () => {
  const { screen, fireEvent, waitFor } = await import("@testing-library/react");
  handler = async (command) =>
    command === "spaces_list_channel_agents"
      ? snapshot({ in_channel: true })
      : {
          state: "not_confirmed",
          message: "Membership was saved. Reply access could not be confirmed.",
        };
  const ui = await mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /Symi.*Company agent/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Enable replies", exact: true }),
  );
  assert.match(
    (await screen.findByRole("alert")).textContent,
    /Reply access could not be confirmed/,
  );
  assert.equal(
    screen.getByRole("button", { name: "Enable replies", exact: true })
      .disabled,
    true,
  );
  assert.deepEqual(ui.added, []);
  assert.deepEqual(ui.closed, []);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    assert.equal(
      calls.filter((call) => call.command === "spaces_list_channel_agents")
        .length,
      2,
    ),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: /Symi.*Company agent/ }),
  );
  assert.equal(
    screen.getByRole("button", { name: "Enable replies", exact: true })
      .disabled,
    false,
  );
  assert.equal(
    calls.filter((call) => call.command === "spaces_add_channel_agent").length,
    1,
  );
});

test("identity replacement clears rows and fences a late native success", async () => {
  const { screen, fireEvent, waitFor, act } = await import(
    "@testing-library/react"
  );
  let finish;
  handler = async (command) =>
    command === "spaces_list_channel_agents"
      ? snapshot()
      : new Promise((resolve) => {
          finish = resolve;
        });
  const ui = await mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /Symi.*Company agent/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Add agent", exact: true }),
  );
  await waitFor(() => assert.equal(typeof finish, "function"));
  await act(async () => listener({ payload: null }));
  assert.equal(
    screen.queryByRole("button", { name: /Symi.*Company agent/ }),
    null,
  );
  await act(async () => finish({ state: "confirmed" }));
  assert.deepEqual(ui.added, []);
  assert.deepEqual(ui.closed, []);
});

test("a mismatched native directory is rejected before an add can be selected", async () => {
  const { screen } = await import("@testing-library/react");
  handler = async () => ({ ...snapshot(), human_pubkey: "c".repeat(64) });
  await mount();
  assert.match(
    (await screen.findByRole("alert")).textContent,
    /company connection changed/,
  );
  assert.equal(
    screen.queryByRole("button", { name: /Symi.*Company agent/ }),
    null,
  );
  assert.equal(
    screen.getByRole("button", { name: "Add agent", exact: true }).disabled,
    true,
  );
});

test("reopening waits for the pending addition and refreshes without accepting its stale success", async () => {
  const { screen, fireEvent, waitFor, act } = await import(
    "@testing-library/react"
  );
  let finish;
  handler = async (command) =>
    command === "spaces_list_channel_agents"
      ? snapshot()
      : new Promise((resolve) => {
          finish = resolve;
        });
  const ui = await mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /Symi.*Company agent/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Add agent", exact: true }),
  );
  await waitFor(() => assert.equal(typeof finish, "function"));
  ui.show(false);
  ui.show(true);
  assert.equal(
    calls.filter((call) => call.command === "spaces_list_channel_agents")
      .length,
    1,
  );
  await act(async () => finish({ state: "confirmed" }));
  await screen.findByRole("button", { name: /Symi.*Company agent/ });
  assert.equal(
    calls.filter((call) => call.command === "spaces_list_channel_agents")
      .length,
    2,
  );
  assert.deepEqual(ui.added, []);
  assert.deepEqual(ui.closed, []);
});

test("native permission failures stay visible and require refreshing before another attempt", async () => {
  const { screen, fireEvent } = await import("@testing-library/react");
  handler = async (command) => {
    if (command === "spaces_list_channel_agents") return snapshot();
    throw "A company administrator must add this agent.";
  };
  const ui = await mount();
  fireEvent.click(
    await screen.findByRole("button", { name: /Symi.*Company agent/ }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Add agent", exact: true }),
  );
  assert.match(
    (await screen.findByRole("alert")).textContent,
    /company administrator/,
  );
  assert.equal(
    screen.getByRole("button", { name: "Add agent", exact: true }).disabled,
    true,
  );
  assert.deepEqual(ui.added, []);
  assert.deepEqual(ui.closed, []);
});
