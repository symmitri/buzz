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
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
});
afterEach(async () => (await import("@testing-library/react")).cleanup());
after(() => dom.window.close());

const personal = {
  key: "personal:1",
  label: "Personal meetings",
  email: "alex@example.test",
  provider: "granola",
  providerLabel: "Granola",
};
const work = {
  key: "work:3",
  label: "Work meetings",
  email: "alex@work.example.test",
  provider: "granola",
  providerLabel: "Granola",
};
const view = (overrides = {}) => ({
  scopeKey: "owner-one:intent-one:1",
  phase: "ready",
  taskSummary: "Review my two latest morning meetings",
  requesterLabel: "Alex",
  accounts: [personal, work],
  ...overrides,
});

async function mount(initial = view()) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { WorkConsentAccountCard } = await import(
    "./WorkConsentAccountCard.tsx"
  );
  const reviews = [];
  let connections = 0;
  let refreshes = 0;
  const props = {
    ...initial,
    onReview: (key) => reviews.push(key),
    onOpenConnections: () => connections++,
    onRefresh: () => refreshes++,
  };
  const ui = render(createElement(WorkConsentAccountCard, props));
  return {
    ...ui,
    reviews,
    connections: () => connections,
    refreshes: () => refreshes,
    show: (next) =>
      ui.rerender(createElement(WorkConsentAccountCard, { ...props, ...next })),
  };
}

test("a single exact eligible account is preselected locally without submitting or approving", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount(view({ accounts: [personal] }));
  assert.equal(screen.getByRole("radio").checked, true);
  assert.deepEqual(ui.reviews, []);
  assert.equal(screen.queryByRole("button", { name: "Allow access" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Review access" }));
  assert.deepEqual(ui.reviews, ["personal:1"]);
  assert.ok(
    screen.getByRole("heading", { name: "Choose an account for this task" }),
  );
});

test("multiple accounts require an explicit native radio choice and preserve the exact versioned key", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  const review = screen.getByRole("button", { name: "Review access" });
  assert.equal(review.disabled, true);
  assert.ok(screen.getByRole("group", { name: "Choose an account" }));
  const radio = screen.getByRole("radio", {
    name: "Work meetings alex@work.example.test Granola",
  });
  radio.focus();
  assert.equal(document.activeElement, radio);
  fireEvent.click(radio);
  assert.equal(review.disabled, false);
  assert.deepEqual(ui.reviews, []);
  fireEvent.click(review);
  assert.deepEqual(ui.reviews, ["work:3"]);
});

test("an account/version removed by a refresh cannot remain selected", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  fireEvent.click(
    screen.getByRole("radio", {
      name: "Personal meetings alex@example.test Granola",
    }),
  );
  ui.show(view({ accounts: [{ ...personal, key: "personal:2" }, work] }));
  assert.equal(
    screen.getByRole("button", { name: "Review access" }).disabled,
    true,
  );
  assert.deepEqual(ui.reviews, []);
});

test("an owner or frozen intent change clears selection synchronously even when account keys repeat", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  fireEvent.click(
    screen.getByRole("radio", {
      name: "Personal meetings alex@example.test Granola",
    }),
  );
  ui.show(view({ scopeKey: "owner-two:intent-two:2" }));
  assert.equal(
    screen.getByRole("button", { name: "Review access" }).disabled,
    true,
  );
  assert.equal(
    screen.getAllByRole("radio").some((radio) => radio.checked),
    false,
  );
  ui.show(view());
  assert.equal(
    screen.getByRole("button", { name: "Review access" }).disabled,
    true,
  );
});

test("identity loss hides retained accounts and task details, and clears prior choice", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  fireEvent.click(
    screen.getByRole("radio", {
      name: "Personal meetings alex@example.test Granola",
    }),
  );
  ui.show(view({ phase: "access-lost" }));
  assert.equal(screen.queryByText("alex@example.test"), null);
  assert.equal(
    screen.queryByText("Review my two latest morning meetings"),
    null,
  );
  assert.equal(screen.queryByRole("radio"), null);
  ui.show(view());
  assert.equal(
    screen.getByRole("button", { name: "Review access" }).disabled,
    true,
  );
});

test("uncertain selection only offers reconciliation and never retries or switches accounts", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount(view({ phase: "uncertain" }));
  assert.equal(screen.queryByRole("radio"), null);
  assert.equal(screen.queryByRole("button", { name: "Review access" }), null);
  fireEvent.click(
    screen.getByRole("button", { name: "Check account selection" }),
  );
  assert.equal(ui.refreshes(), 1);
  assert.deepEqual(ui.reviews, []);
});

test("uncertain selection can explicitly retry its retained operation without supplying another account", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  let retries = 0;
  const ui = await mount(
    view({ phase: "uncertain", onRetry: () => retries++ }),
  );
  assert.equal(screen.queryByRole("radio"), null);
  fireEvent.click(screen.getByRole("button", { name: "Retry selection" }));
  assert.equal(retries, 1);
  assert.deepEqual(ui.reviews, []);
  ui.show(view({ phase: "uncertain", busy: true, onRetry: () => retries++ }));
  fireEvent.click(screen.getByRole("button", { name: "Checking selection…" }));
  assert.equal(retries, 1);
});

test("no eligible account opens the existing Connections callback without a selection or chat action", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount(view({ accounts: [] }));
  fireEvent.click(screen.getByRole("button", { name: "Open Connections" }));
  assert.equal(ui.connections(), 1);
  assert.deepEqual(ui.reviews, []);
  assert.equal(screen.queryByRole("button", { name: "Review access" }), null);
});

test("busy selection disables changes while the native adapter prepares the review", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount(view({ accounts: [personal], busy: true }));
  const button = screen.getByRole("button", { name: "Preparing review…" });
  assert.equal(button.disabled, true);
  assert.equal(screen.getByRole("radio").closest("fieldset").disabled, true);
  assert.equal(
    screen.getByRole("button", { name: "Refresh eligible accounts" }).disabled,
    true,
  );
  fireEvent.click(button);
  assert.deepEqual(ui.reviews, []);
});

for (const phase of ["stale", "expired"]) {
  test(`${phase} intent cannot select an account or offer account setup`, async () => {
    const { fireEvent, screen } = await import("@testing-library/react");
    const ui = await mount(view({ phase }));
    assert.equal(screen.queryByRole("radio"), null);
    assert.equal(screen.queryByRole("button", { name: "Review access" }), null);
    assert.equal(
      screen.queryByRole("button", { name: "Open Connections" }),
      null,
    );
    assert.equal(screen.queryByText("alex@example.test"), null);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh eligible accounts" }),
    );
    assert.equal(ui.refreshes(), 1);
    assert.deepEqual(ui.reviews, []);
  });
}
