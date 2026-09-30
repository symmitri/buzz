import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
before(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});
afterEach(async () => (await import("@testing-library/react")).cleanup());
after(() => dom.window.close());

const human = "a".repeat(64);
const peer = "b".repeat(64);
const relay = "wss://alpha.example.test";
const snapshot = () => ({
  relay_url: relay,
  human_pubkey: human,
  agents: [
    {
      id: "agt_private",
      name: "Private Agent",
      description: "",
      private: true,
      pubkey: peer,
    },
    {
      id: "agent_company",
      name: "Company Agent",
      description: "",
      private: false,
      pubkey: null,
    },
  ],
});

async function mount(overrides = {}) {
  const { createElement } = await import("react");
  const { render, act } = await import("@testing-library/react");
  const { SpacesAgentsGallery } = await import("./SpacesAgentsGallery.tsx");
  const opened = [],
    navigated = [],
    profiles = [];
  const props = {
    relayUrl: relay,
    humanPubkey: human,
    readDirectory: async () => snapshot(),
    openConversation: async (key) => {
      opened.push(key);
      return "exact-dm";
    },
    navigate: (id) => navigated.push(id),
    openProfile: (key) => profiles.push(key),
    ...overrides,
  };
  let view;
  await act(async () => {
    view = render(createElement(SpacesAgentsGallery, props));
  });
  return { ...view, opened, navigated, profiles };
}

test("native Agent profile uses the refreshed key without opening or consenting a DM", async () => {
  const { screen, fireEvent, waitFor } = await import("@testing-library/react");
  let reads = 0;
  const view = await mount({
    readDirectory: async () => {
      reads++;
      return snapshot();
    },
  });
  assert.equal(
    screen.getByRole("button", { name: "View Company Agent's profile" })
      .disabled,
    true,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "View Private Agent's profile" }),
  );
  await waitFor(() => assert.deepEqual(view.profiles, [peer]));
  assert.deepEqual(view.opened, []);
  assert.deepEqual(view.navigated, []);
  assert.equal(reads, 2);
});

test("a changed native binding cannot open the previous Agent profile", async () => {
  const { screen, fireEvent } = await import("@testing-library/react");
  let reads = 0;
  const view = await mount({
    readDirectory: async () => {
      const value = snapshot();
      if (reads++ > 0) value.agents[0].pubkey = "c".repeat(64);
      return value;
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "View Private Agent's profile" }),
  );
  await screen.findByRole("alert");
  assert.deepEqual(view.profiles, []);
  assert.deepEqual(view.opened, []);
});

test("real registry cards open one exact DM only on Message, with disconnected agents disabled", async () => {
  const { screen, fireEvent, waitFor } = await import("@testing-library/react");
  let reads = 0;
  const view = await mount({
    readDirectory: async () => {
      reads++;
      return snapshot();
    },
  });
  const button = await screen.findByRole("button", {
    name: "Message Private Agent",
  });
  assert.equal(
    screen.getByRole("button", {
      name: "Company Agent is not connected to Alpha",
    }).disabled,
    true,
  );
  assert.equal(screen.queryByText(/Start agent/i), null);
  assert.equal(view.opened.length, 0);
  fireEvent.click(button);
  await waitFor(() => assert.deepEqual(view.navigated, ["exact-dm"]));
  assert.deepEqual(view.opened, [peer]);
  assert.equal(reads, 2);
});

test("failed refresh removes previously available actions", async () => {
  const { screen, fireEvent } = await import("@testing-library/react");
  let fail = false;
  const view = await mount({
    readDirectory: async () => {
      if (fail) throw new Error("unavailable");
      return snapshot();
    },
  });
  await screen.findByRole("button", { name: "Message Private Agent" });
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  assert.equal(
    screen.queryByRole("button", { name: "Message Private Agent" }),
    null,
  );
  assert.equal(view.opened.length, 0);
});

test("out-of-order directory results cannot restore removed availability", async () => {
  const { screen, act, waitFor } = await import("@testing-library/react");
  const pending = [];
  await mount({
    readDirectory: () => new Promise((resolve) => pending.push(resolve)),
  });
  await waitFor(() => assert.equal(pending.length, 1));
  await act(async () => window.dispatchEvent(new dom.window.Event("focus")));
  await waitFor(() => assert.equal(pending.length, 2));
  await act(async () => pending[1]({ ...snapshot(), agents: [] }));
  await screen.findByText("No agents are available to your account yet.");
  await act(async () => pending[0](snapshot()));
  assert.equal(
    screen.queryByRole("button", { name: "Message Private Agent" }),
    null,
  );
});

test("removed or changed identity at click time refuses DM creation", async () => {
  const { screen, fireEvent } = await import("@testing-library/react");
  let reads = 0;
  const view = await mount({
    readDirectory: async () => {
      const value = snapshot();
      if (reads++ > 0) value.agents[0].pubkey = "c".repeat(64);
      return value;
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Message Private Agent" }),
  );
  await screen.findByRole("alert");
  assert.equal(view.opened.length, 0);
});

test("wrong account scope is never rendered", async () => {
  const { screen } = await import("@testing-library/react");
  const view = await mount({
    readDirectory: async () => ({
      ...snapshot(),
      human_pubkey: "c".repeat(64),
    }),
  });
  await screen.findByRole("alert");
  assert.equal(screen.queryByText("Private Agent"), null);
  assert.equal(view.opened.length, 0);
});

test("unmounted gallery cannot navigate after a late DM return", async () => {
  const { screen, fireEvent, waitFor, act } = await import(
    "@testing-library/react"
  );
  let finish;
  const view = await mount({
    openConversation: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Message Private Agent" }),
  );
  await waitFor(() => assert.equal(typeof finish, "function"));
  view.unmount();
  await act(async () => finish("exact-dm"));
  assert.deepEqual(view.navigated, []);
});

test("DM refusal is shown and never automatically repeated", async () => {
  const { screen, fireEvent, act } = await import("@testing-library/react");
  let attempts = 0;
  await mount({
    openConversation: async () => {
      attempts++;
      throw "This agent could not connect to the conversation.";
    },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Message Private Agent" }),
  );
  await screen.findByText("This agent could not connect to the conversation.");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  assert.equal(attempts, 1);
});

test("avatars resolve only the exact currently connected Agent keys", async () => {
  const { screen } = await import("@testing-library/react");
  const { createElement } = await import("react");
  const keys = [];
  await mount({
    avatar: (key, name) => {
      keys.push(key);
      return createElement(
        "span",
        { "data-testid": "native-avatar" },
        name + " avatar",
      );
    },
  });
  await screen.findByTestId("native-avatar");
  assert.ok(keys.length > 0);
  assert.ok(keys.every((key) => key === peer));
  assert.equal(screen.queryByText("Company Agent avatar"), null);
});

test("display hints follow only the latest verified directory and clear on failure", async () => {
  const { screen, act, waitFor, fireEvent } = await import(
    "@testing-library/react"
  );
  const pending = [],
    seen = [];
  await mount({
    readDirectory: () =>
      new Promise((resolve, reject) => pending.push({ resolve, reject })),
    onDirectory: (value) => seen.push(value),
  });
  await waitFor(() => assert.equal(pending.length, 1));
  await act(async () => window.dispatchEvent(new dom.window.Event("focus")));
  await waitFor(() => assert.equal(pending.length, 2));
  await act(async () => pending[1].resolve(snapshot()));
  await screen.findByRole("button", { name: "Message Private Agent" });
  await act(async () => pending[0].resolve({ ...snapshot(), agents: [] }));
  assert.deepEqual(seen, [snapshot()]);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => assert.equal(pending.length, 3));
  await act(async () => pending[2].reject(new Error("access lost")));
  await screen.findByRole("alert");
  assert.deepEqual(seen, [snapshot(), null]);
});
