import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const requests = [];
const callbacks = new Map();
let handler;
let eventCallback;
before(() => {
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.__TAURI_INTERNALS__ = {
    invoke(command, args = {}) {
      if (command === "plugin:event|listen") {
        eventCallback = callbacks.get(args.handler);
        return Promise.resolve(1);
      }
      if (command === "plugin:event|unlisten") return Promise.resolve();
      requests.push({ command, args });
      return command === "spaces_cancel_github_connection"
        ? Promise.resolve()
        : handler(command, args);
    },
    transformCallback(callback) {
      const id = callbacks.size + 1;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
  };
  globalThis.__TAURI_INTERNALS__ = dom.window.__TAURI_INTERNALS__;
});
beforeEach(() => {
  requests.length = 0;
  callbacks.clear();
  eventCallback = undefined;
});
after(() => dom.window.close());

const view = {
  revision: "a".repeat(64),
  capability: {
    configured: true,
    administrator_id: "usr_test",
    organisation_id: "org_symmitri",
    account_login: "symmitri",
    repository_scope: "selected",
    repositories: ["symmitri/axis"],
    read_tools: ["github_read"],
    in_progress: false,
    can_start: true,
  },
};

async function mount(active = true) {
  const { renderHook, act } = await import("@testing-library/react");
  const { useGitHubCompanyConnection } = await import(
    "./useGitHubCompanyConnection.ts"
  );
  const hook = renderHook(
    ({ active }) => useGitHubCompanyConnection(active, false),
    { initialProps: { active } },
  );
  await act(async () => {});
  return { ...hook, act };
}

test("company capability stays lazy and a hidden late result cannot restore data", async () => {
  let resolveRead;
  handler = () =>
    new Promise((resolve) => {
      resolveRead = resolve;
    });
  const hook = await mount(false);
  assert.equal(requests.length, 0);
  await hook.act(async () => hook.rerender({ active: true }));
  const read = requests.find(
    (request) => request.command === "spaces_read_github_connection",
  );
  assert.ok(read);
  await hook.act(async () => hook.rerender({ active: false }));
  assert.ok(
    requests.some(
      (request) =>
        request.command === "spaces_cancel_github_connection" &&
        request.args.requestId === read.args.requestId,
    ),
  );
  await hook.act(async () => resolveRead({ state: "ready", view }));
  assert.equal(hook.result.current.view, null);
  hook.unmount();
});

test("uncertain company setup requires a status read before another explicit change", async () => {
  handler = async (command) =>
    command === "spaces_read_github_connection"
      ? { state: "ready", view }
      : { state: "uncertain", view, message: "Check the saved setup." };
  const hook = await mount();
  await hook.act(async () => hook.result.current.change("start"));
  assert.equal(hook.result.current.requiresRefresh, true);
  await hook.act(async () => hook.result.current.change("start"));
  assert.equal(
    requests.filter((r) => r.command === "spaces_change_github_connection")
      .length,
    1,
  );
  await hook.act(async () => hook.result.current.refresh());
  assert.equal(hook.result.current.requiresRefresh, false);
  const change = requests.find(
    (r) => r.command === "spaces_change_github_connection",
  );
  assert.equal(change.args.input.expectedRevision, view.revision);
  assert.equal(change.args.input.expectedAdministratorId, "usr_test");
  assert.equal(change.args.input.expectedOrganisationId, "org_symmitri");
  hook.unmount();
});

test("access invalidation clears setup and fences a pending browser result", async () => {
  let resolveChange;
  handler = (command) =>
    command === "spaces_read_github_connection"
      ? Promise.resolve({ state: "ready", view })
      : new Promise((resolve) => {
          resolveChange = resolve;
        });
  const hook = await mount();
  let pending;
  await hook.act(async () => {
    pending = hook.result.current.change("start");
  });
  await hook.act(async () =>
    eventCallback({ event: "spaces-connections-invalidated", payload: null }),
  );
  assert.equal(hook.result.current.view, null);
  await hook.act(async () => {
    resolveChange({ state: "opened", view });
    await pending;
  });
  assert.equal(hook.result.current.view, null);
  assert.equal(hook.result.current.busy, false);
  hook.unmount();
});
