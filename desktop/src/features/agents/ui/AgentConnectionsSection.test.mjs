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
const relay = "wss://relay.example.test",
  human = "a".repeat(64),
  agent = "b".repeat(64);
const snapshot = () => ({
  relay_url: relay,
  human_pubkey: human,
  agent_pubkey: agent,
  agent_name: "Company Agent",
  connections: [
    { label: "Code repository", provider: "github", ownership: "company" },
    { label: "Agent inbox", provider: "google-workspace", ownership: "agent" },
  ],
});
async function mount(overrides = {}) {
  const { createElement } = await import("react");
  const { render, act } = await import("@testing-library/react");
  const { AgentConnectionsSection } =
    await import("./AgentConnectionsSection.tsx");
  let invalidate;
  const props = {
    relayUrl: relay,
    humanPubkey: human,
    agentPubkey: agent,
    read: async () => snapshot(),
    subscribeInvalidation: async (clear) => {
      invalidate = clear;
      return () => {};
    },
    ...overrides,
  };
  let view;
  await act(async () => {
    view = render(createElement(AgentConnectionsSection, props));
  });
  return {
    ...view,
    props,
    invalidate: () => invalidate(),
    rerenderProps: async (next) => {
      await act(async () =>
        view.rerender(
          createElement(AgentConnectionsSection, { ...props, ...next }),
        ),
      );
    },
  };
}
test("shows Agent configuration separately from verified working access", async () => {
  const { screen } = await import("@testing-library/react");
  await mount();
  await screen.findByText("Code repository");
  assert.match(
    screen.getByText(/Configured for Company Agent/).textContent,
    /do not confirm a working connection/,
  );
  assert.ok(screen.getByText(/Agent account/));
  assert.ok(screen.getByText(/Company account/));
  assert.equal(
    screen.queryByRole("button", { name: /Connect|Grant|Activate/i }),
    null,
  );
});
test("denied refresh immediately removes previously visible connection details", async () => {
  const { screen, fireEvent } = await import("@testing-library/react");
  let calls = 0;
  await mount({
    read: async () => {
      if (calls++)
        throw "You do not have permission to view this agent's connections.";
      return snapshot();
    },
  });
  await screen.findByText("Code repository");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  assert.match((await screen.findByRole("alert")).textContent, /permission/);
  assert.equal(screen.queryByText("Code repository"), null);
  assert.equal(calls, 2);
});
test("changing account fences the previous pending response", async () => {
  const { screen, act } = await import("@testing-library/react");
  let resolve;
  const read = () =>
    new Promise((r) => {
      resolve = r;
    });
  const view = await mount({ read });
  const previous = resolve;
  await view.rerenderProps({ humanPubkey: "c".repeat(64) });
  await act(async () => previous(snapshot()));
  assert.equal(screen.queryByText("Code repository"), null);
});
test("current native invalidation clears details and fences an in-flight refresh", async () => {
  const { screen, fireEvent, act } = await import("@testing-library/react");
  let resolve,
    calls = 0;
  const view = await mount({
    read: () =>
      calls++ === 0
        ? Promise.resolve(snapshot())
        : new Promise((r) => {
            resolve = r;
          }),
  });
  await screen.findByText("Code repository");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => view.invalidate());
  await act(async () => resolve(snapshot()));
  assert.equal(screen.queryByText("Code repository"), null);
});
test("a wrong Agent receipt cannot be displayed", async () => {
  const { screen } = await import("@testing-library/react");
  await mount({
    read: async () => ({ ...snapshot(), agent_pubkey: "c".repeat(64) }),
  });
  assert.match(
    (await screen.findByRole("alert")).textContent,
    /identity changed/,
  );
  assert.equal(screen.queryByText("Code repository"), null);
});
test("reopening reads current grants instead of restoring a cached card", async () => {
  const { screen } = await import("@testing-library/react");
  const view = await mount();
  await screen.findByText("Code repository");
  view.unmount();
  await mount({ read: async () => ({ ...snapshot(), connections: [] }) });
  await screen.findByText("No connections are visible to you for this agent.");
  assert.equal(screen.queryByText("Code repository"), null);
});
test("no connection read runs without the invalidation listener", async () => {
  const { screen, fireEvent } = await import("@testing-library/react");
  let reads = 0;
  await mount({
    subscribeInvalidation: async () => {
      throw Error("unavailable");
    },
    read: async () => {
      reads++;
      return snapshot();
    },
  });
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  assert.equal(reads, 0);
});

test("scheduled refreshes coalesce while a slow native read is pending", async () => {
  const { screen, act } = await import("@testing-library/react");
  const original = window.setInterval;
  let tick,
    resolve,
    reads = 0;
  window.setInterval = (callback) => {
    tick = callback;
    return 0;
  };
  try {
    await mount({
      read: () => {
        reads++;
        return new Promise((r) => {
          resolve = r;
        });
      },
    });
    await act(async () => {
      tick();
      tick();
    });
    assert.equal(reads, 1);
    await act(async () => resolve(snapshot()));
    await screen.findByText("Code repository");
    await act(async () => tick());
    assert.equal(reads, 2);
  } finally {
    window.setInterval = original;
  }
});
