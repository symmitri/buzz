import assert from "node:assert/strict";
import { before, after, afterEach, test } from "node:test";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
let handler,
  listener,
  cleanup,
  renderHook,
  act,
  waitFor,
  React,
  QueryClient,
  QueryClientProvider,
  useScopedCompanyMentions;
const callbacks = new Map();
const scope = {
  relayUrl: "wss://alpha.test",
  humanPubkey: "a".repeat(64),
  channelId: "11111111-1111-4111-8111-111111111111",
};
const key = "b".repeat(64);
const snapshot = () => ({
  relay_url: scope.relayUrl,
  human_pubkey: scope.humanPubkey,
  channel_id: scope.channelId,
  agents: [
    {
      company_agent_id: "agent-symi",
      pubkey: key,
      name: "Symi",
      channel_ids: [scope.channelId],
    },
  ],
});
before(async () => {
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    localStorage: dom.window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  dom.window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  dom.window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      if (command === "plugin:event|listen") {
        listener = callbacks.get(args.handler);
        return 1;
      }
      if (command === "plugin:event|unlisten") return;
      if (command === "get_relay_http_url") return "https://alpha.test";
      if (command === "get_media_proxy_port") return null;
      return handler(command, args);
    },
    transformCallback(callback) {
      const id = callbacks.size + 1;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback() {},
  };
  React = await import("react");
  ({ renderHook, cleanup, act, waitFor } = await import(
    "@testing-library/react"
  ));
  ({ QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  ));
  ({ useScopedCompanyMentions } = await import(
    "./useCompanyChannelMentions.ts"
  ));
});
afterEach(() => cleanup());
after(() => dom.window.close());
function fixture() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const view = renderHook(
    ({ current }) => useScopedCompanyMentions(true, current),
    { initialProps: { current: scope }, wrapper },
  );
  return { client, ...view };
}
test("failed refresh removes suggestions but retains canonical send classification", async () => {
  handler = async () => snapshot();
  const view = fixture();
  await waitFor(() => assert.equal(view.result.current.data?.length, 1));
  handler = async () => {
    throw new Error("revoked");
  };
  await act(async () => {
    await view.client.invalidateQueries({
      queryKey: ["spaces-company-mentions"],
    });
  });
  await waitFor(() => assert.equal(view.result.current.data, undefined));
  assert.equal(view.result.current.knownCompanyPubkeys.has(key), true);
});
test("identity invalidation rejects already completed native result before consumer continuation", async () => {
  let resolve;
  handler = async (command) =>
    command === "spaces_revalidate_company_channel_mentions"
      ? new Promise((done) => {
          resolve = done;
        })
      : snapshot();
  const view = fixture();
  await waitFor(() => assert.equal(view.result.current.data?.length, 1));
  let pending;
  await act(async () => {
    pending = view.result.current.revalidate([key], scope.channelId);
    pending.catch(() => {});
  });
  await act(async () => {
    resolve(snapshot());
    listener({ payload: null });
  });
  await assert.rejects(pending, /destination changed/);
});
test("a retained old closure cannot follow a changed channel", async () => {
  handler = async () => snapshot();
  const view = fixture();
  await waitFor(() => assert.equal(view.result.current.data?.length, 1));
  const old = view.result.current.revalidate;
  view.rerender({
    current: { ...scope, channelId: "22222222-2222-4222-8222-222222222222" },
  });
  assert.equal(view.result.current.knownCompanyPubkeys.has(key), false);
  await assert.rejects(old([key], scope.channelId), /destination changed/);
});

test("leaving and returning to the same channel never revives a pending send", async () => {
  let resolve;
  handler = async (command) =>
    command === "spaces_revalidate_company_channel_mentions"
      ? new Promise((done) => {
          resolve = done;
        })
      : snapshot();
  const view = fixture();
  await waitFor(() => assert.equal(view.result.current.data?.length, 1));
  let pending;
  await act(async () => {
    pending = view.result.current.revalidate([key], scope.channelId);
    pending.catch(() => {});
  });
  view.rerender({
    current: { ...scope, channelId: "22222222-2222-4222-8222-222222222222" },
  });
  view.rerender({ current: scope });
  await act(async () => {
    resolve(snapshot());
  });
  await assert.rejects(pending, /destination changed/);
});
