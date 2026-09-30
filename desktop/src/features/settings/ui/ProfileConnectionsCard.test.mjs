import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import {
  connectionsFixture,
  connectionEntry,
} from "../../../../tests/fixtures/profileConnections.ts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
let calls = [],
  handler,
  callbacks = new Map(),
  listener,
  listenFailure = false,
  cancelHandler = async () => null;
const ready = () => ({ state: "ready", snapshot: connectionsFixture() });
before(() => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "plugin:event|listen") {
        if (listenFailure) throw new Error("Synthetic listener unavailable");
        listener = callbacks.get(args.handler);
        return 1;
      }
      if (command === "plugin:event|unlisten") return null;
      calls.push({ command, args });
      if (command === "spaces_cancel_connections") return cancelHandler();
      return handler(command, args);
    },
    transformCallback: (callback) => {
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
  callbacks = new Map();
  listener = undefined;
  listenFailure = false;
  cancelHandler = async () => null;
  localStorage.clear();
});
after(() => dom.window.close());
async function mount(active = true) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { ProfileConnectionsCard } = await import(
    "./ProfileConnectionsCard.tsx"
  );
  const rendered = render(createElement(ProfileConnectionsCard, { active }));
  return {
    ...rendered,
    show: (active) =>
      rendered.rerender(createElement(ProfileConnectionsCard, { active })),
  };
}
const readCalls = () =>
  calls.filter((call) => call.command === "spaces_read_connections");

test("does not read until opened; late hidden read cannot replace reopened catalog", async () => {
  const { act, screen, waitFor } = await import("@testing-library/react");
  let finishOld;
  handler = () =>
    new Promise((resolve) => {
      finishOld = resolve;
    });
  const ui = await mount(false);
  assert.equal(readCalls().length, 0);
  ui.show(true);
  await waitFor(() => assert.equal(typeof finishOld, "function"));
  ui.show(false);
  handler = async () => ready();
  ui.show(true);
  assert.ok(await screen.findByText("Google Workspace"));
  await act(async () =>
    finishOld({
      state: "ready",
      snapshot: {
        ...connectionsFixture(),
        entries: [connectionEntry({ name: "Stale private entry" })],
      },
    }),
  );
  assert.equal(screen.queryByText("Stale private entry"), null);
  assert.equal(readCalls().length, 2);
});

test("identity invalidation clears private rows and late mutation result", async () => {
  const { act, fireEvent, screen, waitFor } = await import(
    "@testing-library/react"
  );
  let finish;
  handler = async (command) =>
    command === "spaces_read_connections"
      ? ready()
      : new Promise((resolve) => {
          finish = resolve;
        });
  await mount();
  await screen.findByText("Google Workspace");
  fireEvent.click(screen.getByLabelText("Enable Google Workspace for me"));
  await waitFor(() => assert.equal(typeof finish, "function"));
  await act(async () => listener({ payload: null }));
  assert.equal(screen.queryByText("alex@example.test"), null);
  assert.equal(screen.queryByLabelText("Notion API key or access token"), null);
  await act(async () =>
    finish({ state: "confirmed", snapshot: connectionsFixture() }),
  );
  assert.equal(screen.queryByText("Google Workspace"), null);
  assert.ok(
    screen.getByText(
      "Your account access changed. Refresh to check your connections.",
    ),
  );
});

test("duplicate clicks submit once; uncertain changes need explicit refresh", async () => {
  const { act, fireEvent, screen, waitFor } = await import(
    "@testing-library/react"
  );
  let finish;
  handler = async (command) =>
    command === "spaces_read_connections"
      ? ready()
      : new Promise((resolve) => {
          finish = resolve;
        });
  await mount();
  await screen.findByText("Google Workspace");
  const toggle = screen.getByLabelText("Enable Google Workspace for me");
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  await waitFor(() => assert.equal(typeof finish, "function"));
  assert.equal(
    calls.filter((call) => call.command === "spaces_set_connection_enabled")
      .length,
    1,
  );
  await act(async () =>
    finish({ state: "not_confirmed", message: "The change is not confirmed." }),
  );
  assert.equal(toggle.disabled, true);
  assert.equal(readCalls().length, 1);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => assert.equal(toggle.disabled, false));
  assert.equal(readCalls().length, 2);
});

test("access request retains original id after unknown outcome and tab switch", async () => {
  const { fireEvent, screen, waitFor } = await import("@testing-library/react");
  handler = async (command) =>
    command === "spaces_read_connections"
      ? ready()
      : { state: "not_confirmed", message: "Refresh to check your request." };
  const ui = await mount();
  await screen.findByText("Linear");
  fireEvent.click(
    screen.getByRole("button", { name: "Request access", hidden: true }),
  );
  await screen.findByText("Refresh to check your request.");
  const first = calls.find(
    (call) => call.command === "spaces_request_connection_access",
  );
  ui.show(false);
  ui.show(true);
  await screen.findByText("Linear");
  fireEvent.click(
    screen.getByRole("button", { name: "Request access", hidden: true }),
  );
  await waitFor(() =>
    assert.equal(
      calls.filter(
        (call) => call.command === "spaces_request_connection_access",
      ).length,
      2,
    ),
  );
  assert.equal(
    calls.filter(
      (call) => call.command === "spaces_request_connection_access",
    )[1].args.input.idempotencyKey,
    first.args.input.idempotencyKey,
  );
});

test("unavailable refresh marks rows stale; access loss removes them", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  handler = async () => ready();
  await mount();
  await screen.findByText("Google Workspace");
  handler = async () => ({
    state: "unavailable",
    message: "Offline. These accounts may be out of date.",
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Offline. These accounts may be out of date.");
  assert.equal(
    screen.getByLabelText("Enable Google Workspace for me").disabled,
    true,
  );
  handler = async () => ({ state: "access_lost", message: "Sign in again." });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Sign in again.");
  assert.equal(screen.queryByText("Google Workspace"), null);
});

test("large catalog bounds rendered rows and searches account metadata", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const snapshot = connectionsFixture();
  snapshot.entries = Array.from({ length: 5000 }, (_, i) =>
    connectionEntry({
      connection_id: `connection-${i}`,
      name: `Provider ${String(i).padStart(4, "0")}`,
    }),
  );
  snapshot.accounts[0].connection_id = "connection-4999";
  handler = async () => ({ state: "ready", snapshot });
  await mount();
  await screen.findByText("Provider 4999");
  assert.equal(
    document.querySelectorAll('[data-testid^="profile-connection-"]').length,
    40,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  assert.equal(
    document.querySelectorAll('[data-testid^="profile-connection-"]').length,
    40,
  );
  assert.ok(screen.getByText("41–80 of 5000"));
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "alex@example.test" },
  });
  assert.equal(
    document.querySelectorAll('[data-testid^="profile-connection-"]').length,
    1,
  );
  assert.ok(screen.getByText("Provider 4999"));
});

test("late OAuth after closing cannot claim browser success on reopening", async () => {
  const { act, fireEvent, screen, waitFor } = await import(
    "@testing-library/react"
  );
  let finish;
  handler = async (command) =>
    command === "spaces_read_connections"
      ? ready()
      : new Promise((resolve) => {
          finish = resolve;
        });
  const ui = await mount();
  await screen.findByText("Google Workspace");
  fireEvent.click(
    screen.getByRole("button", { name: "Reconnect", hidden: true }),
  );
  await waitFor(() => assert.equal(typeof finish, "function"));
  ui.show(false);
  ui.show(true);
  await screen.findByText("Google Workspace");
  await act(async () => finish({ opened: true }));
  assert.equal(
    screen.queryByText(
      "Continue in your browser, then return here and refresh.",
    ),
    null,
  );
});

test("partial account read remains honest and disables account changes", async () => {
  const { screen } = await import("@testing-library/react");
  const snapshot = connectionsFixture();
  snapshot.accounts = [];
  snapshot.accounts_state = "unavailable";
  handler = async () => ({ state: "ready", snapshot });
  await mount();
  await screen.findByText("Google Workspace");
  assert.ok(screen.getAllByText("Account status unavailable").length > 0);
  assert.equal(
    screen.getByLabelText("Enable Google Workspace for me").disabled,
    true,
  );
  assert.ok(
    screen.getByText(
      "Some account details could not be loaded. Refresh to check before making changes.",
    ),
  );
});

test("account-free services retain entitlement controls without suggesting account setup", async () => {
  const { fireEvent, screen, waitFor, within } = await import(
    "@testing-library/react"
  );
  const snapshot = connectionsFixture();
  snapshot.accounts = [];
  snapshot.entries = [
    connectionEntry({
      connection_id: "exa",
      alias: "exa",
      name: "Exa",
      provider: "exa",
      credential_scope: "none",
      auth_mode: "anonymous",
      setup: { kind: "none", connector_id: "exa", browser_supported: false },
    }),
    connectionEntry({
      connection_id: "context7",
      alias: "context7",
      name: "Context7",
      provider: "context7",
      credential_scope: "none",
      auth_mode: "anonymous",
      readiness: "unavailable",
      setup: {
        kind: "none",
        connector_id: "context7",
        browser_supported: false,
      },
    }),
    connectionEntry({
      connection_id: "parallel-search",
      alias: "parallel-search",
      name: "Parallel",
      provider: "parallel-search",
      credential_scope: "none",
      auth_mode: "anonymous",
      entitlement: "requestable",
      activation: { enabled: false, source: "default", version: 0 },
      setup: {
        kind: "none",
        connector_id: "parallel-search",
        browser_supported: false,
      },
    }),
  ];
  handler = async (command) => ({
    state: command === "spaces_read_connections" ? "ready" : "confirmed",
    snapshot,
  });
  await mount();
  await screen.findByText("Exa");
  assert.equal(screen.getAllByText("Shared service").length, 3);
  assert.equal(screen.getAllByText("No account required").length, 2);
  assert.ok(screen.getByText("Connection unavailable"));
  assert.equal(screen.queryByText("Company setup needed"), null);
  assert.equal(
    screen.queryByText("Setup is not available for this connection yet."),
    null,
  );
  assert.equal(
    screen.queryByText("Account setup is managed by your company."),
    null,
  );
  assert.equal(
    screen.queryByRole("button", { name: "Connect", hidden: true }),
    null,
  );
  assert.equal(
    screen.queryByRole("button", { name: "Disconnect", hidden: true }),
    null,
  );
  fireEvent.click(screen.getByLabelText("Enable Exa for me"));
  await waitFor(() =>
    assert.equal(screen.getByLabelText("Enable Exa for me").disabled, false),
  );
  assert.equal(
    calls.filter((call) => call.command === "spaces_set_connection_enabled")
      .length,
    1,
  );
  const parallel = within(
    screen.getByTestId("profile-connection-parallel-search"),
  );
  fireEvent.click(
    parallel.getByRole("button", { name: "Request access", hidden: true }),
  );
  await waitFor(() =>
    assert.equal(
      calls.filter(
        (call) => call.command === "spaces_request_connection_access",
      ).length,
      1,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Company", exact: true }));
  assert.equal(screen.getAllByText("Shared service").length, 3);
  fireEvent.click(
    screen.getByRole("button", { name: "Personal", exact: true }),
  );
  assert.ok(screen.getByText("No connections here"));
});

test("company readiness stays explicit without exposed account metadata", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const snapshot = connectionsFixture();
  snapshot.accounts = [];
  snapshot.entries = [
    connectionEntry({
      connection_id: "lightfield-api",
      alias: "lightfield-api",
      provider: "lightfield-api",
      name: "Lightfield company reads",
      credential_scope: "organisation",
      auth_mode: "bearer",
      entitlement: "requestable",
      activation: { enabled: false, source: "default", version: 0 },
      setup: {
        kind: "none",
        connector_id: "lightfield-api",
        browser_supported: false,
      },
    }),
  ];
  handler = async () => ({ state: "ready", snapshot });
  await mount();
  await screen.findByText("Lightfield company reads");
  assert.ok(screen.getByText("Company configured"));
  assert.equal(screen.queryByText("No saved account required"), null);
  assert.ok(screen.getByText("Provider access hasn’t been checked here."));
  handler = async () => ({
    state: "ready",
    snapshot: { ...snapshot, accounts_state: "unavailable" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Account status unavailable");
  assert.equal(screen.queryByText("Company configured"), null);
  assert.equal(
    screen.getByRole("button", { name: "Request access", hidden: true })
      .disabled,
    true,
  );
});

test("secret form clears on submit and never saves or logs the key", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  handler = async (command) =>
    command === "spaces_read_connections"
      ? ready()
      : {
          state: "not_confirmed",
          message: "Check your account before retrying.",
        };
  await mount();
  await screen.findByText("Notion");
  const secret = screen.getByLabelText("Notion API key or access token");
  fireEvent.change(secret, { target: { value: "synthetic-provider-secret" } });
  fireEvent.submit(secret.closest("form"));
  await screen.findByText("Check your account before retrying.");
  assert.equal(secret.value, "");
  assert.equal(localStorage.length, 0);
  assert.equal(
    document.body.textContent.includes("synthetic-provider-secret"),
    false,
  );
  assert.equal(
    calls.filter((call) => call.command === "spaces_connect_connection_key")
      .length,
    1,
  );
});

test("replacement principal remounts rows instead of retaining previous private drafts", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  handler = async () => ready();
  await mount();
  await screen.findByText("Notion");
  fireEvent.change(screen.getByLabelText("Notion API key or access token"), {
    target: { value: "synthetic-prior-secret" },
  });
  const snapshot = connectionsFixture();
  snapshot.principal.id = "another-sample-user";
  snapshot.accounts = [];
  handler = async () => ({ state: "ready", snapshot });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Google Workspace");
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() =>
    assert.equal(
      screen.getByLabelText("Notion API key or access token").value,
      "",
    ),
  );
  assert.equal(screen.queryByText("alex@example.test"), null);
});

test("missing account invalidation subscription refuses private reads", async () => {
  const { screen } = await import("@testing-library/react");
  listenFailure = true;
  handler = async () => ready();
  await mount();
  await screen.findByText(
    "Account status could not be checked. Close and reopen Settings to try again.",
  );
  assert.equal(readCalls().length, 0);
  assert.equal(screen.queryByText("Google Workspace"), null);
});

test("reopening Settings waits for the previous instance native cancellation", async () => {
  const { act, screen } = await import("@testing-library/react");
  handler = async () => ready();
  const first = await mount();
  await screen.findByText("Google Workspace");
  let releaseCancel;
  cancelHandler = () =>
    new Promise((resolve) => {
      releaseCancel = resolve;
    });
  first.unmount();
  await mount();
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      readCalls().length,
      1,
      "new Settings must wait until old native cancellation completes",
    );
  } finally {
    cancelHandler = async () => null;
    await act(async () => releaseCancel());
  }
  await screen.findByText("Google Workspace");
  assert.equal(readCalls().length, 2);
});
