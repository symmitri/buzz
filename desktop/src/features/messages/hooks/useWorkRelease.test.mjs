import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import fixture from "../../../../tests/fixtures/work-release.json" with {
  type: "json",
};
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
const target = {
  channelId: fixture.expected.origin.channelId,
  rootEventId: fixture.expected.origin.rootEventId,
  expectedSignerPubkey: "b".repeat(64),
};
const context = {
  ...target,
  expectedRelayUrl: fixture.expected.origin.relayUrl.replace("https:", "wss:"),
};
const identity = {
  principalId: fixture.expected.identityId,
  organisationId: fixture.expected.orgId,
  scopeToken: "scope_synthetic",
};
const preview = () => structuredClone(fixture.preview);
const query = (records = [preview().release], extras = {}) => ({
  state: "ready",
  ...identity,
  lookup: {
    workId: fixture.expected.workId,
    releases: records,
    truncated: false,
  },
  ...extras,
});
let calls = [],
  handler,
  callbacks = new Map(),
  eventCallback,
  listenFailure = false,
  hidden = false;
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
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (hidden ? "hidden" : "visible"),
  });
  dom.window.__TAURI_INTERNALS__ = {
    transformCallback: (fn) => {
      const id = callbacks.size + 1;
      callbacks.set(id, fn);
      return id;
    },
    unregisterCallback() {},
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "plugin:event|listen") {
        if (listenFailure) throw Error("synthetic listener failure");
        eventCallback = callbacks.get(args.handler);
        return 1;
      }
      if (
        command === "plugin:event|unlisten" ||
        command === "spaces_cancel_work_release"
      )
        return null;
      return handler(command, args?.input);
    },
  };
});
afterEach(async () => {
  const { cleanup, act } = await import("@testing-library/react");
  await act(async () => cleanup());
  calls = [];
  callbacks = new Map();
  eventCallback = undefined;
  listenFailure = false;
  hidden = false;
});
after(() => dom.window.close());
function normal(command) {
  if (command === "spaces_work_release_context")
    return { state: "ready", context };
  if (command === "spaces_query_work_releases") return query();
  if (command === "spaces_preview_work_release")
    return { state: "ready", ...identity, preview: preview() };
  throw Error(`Unexpected native command ${command}`);
}
async function mount(initial = target) {
  const { renderHook } = await import("@testing-library/react");
  const { useWorkRelease } = await import("./useWorkRelease.ts");
  return renderHook(({ target }) => useWorkRelease(target), {
    initialProps: { target: initial },
  });
}
const count = (name) => calls.filter((c) => c.command === name);
async function ready(ui) {
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() => assert.equal(ui.result.current.phase, "ready"));
}
test("closed gate and failed native invalidation listener perform no private read", async () => {
  handler = () => ({ state: "unsupported" });
  const { waitFor } = await import("@testing-library/react");
  const ui = await mount(null);
  assert.equal(count("spaces_work_release_context").length, 0);
  ui.rerender({ target });
  await waitFor(() => assert.equal(ui.result.current.phase, "unsupported"));
  assert.equal(count("spaces_query_work_releases").length, 0);
});
test("listener failure closes preview path", async () => {
  listenFailure = true;
  handler = normal;
  const ui = await mount();
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() => assert.equal(ui.result.current.phase, "unavailable"));
  assert.equal(count("spaces_work_release_context").length, 0);
});
test("foreign owner or changed destination cannot enter native view snapshot", async () => {
  const foreign = preview().release;
  foreign.terms.ownerId = "human_requester";
  handler = (c) =>
    c === "spaces_query_work_releases" ? query([foreign]) : normal(c);
  const ui = await mount();
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() => assert.equal(ui.result.current.phase, "unavailable"));
  assert.equal(ui.result.current.snapshot, null);
  assert.equal(count("spaces_preview_work_release").length, 0);
});
test("private preview uses canonical byte hashes and disabled capability refuses Share", async () => {
  handler = normal;
  const ui = await mount();
  await ready(ui);
  const { act } = await import("@testing-library/react");
  await act(async () => ui.result.current.preview(fixture.expected.releaseId));
  assert.equal(
    ui.result.current.snapshot.previews[fixture.expected.releaseId].markdown,
    fixture.preview.markdown,
  );
  await act(async () =>
    ui.result.current.decide(fixture.expected.releaseId, "approve"),
  );
  assert.equal(count("spaces_decide_work_release").length, 0);
});
test("substituted source URL or hidden suffix fails canonical preview verification", async () => {
  const bad = preview();
  bad.markdown += "\nPRIVATE_SUBSTITUTED_SUFFIX https://other.example.test";
  handler = (c) =>
    c === "spaces_preview_work_release"
      ? { state: "ready", ...identity, preview: bad }
      : normal(c);
  const ui = await mount();
  await ready(ui);
  const { act } = await import("@testing-library/react");
  await act(async () => ui.result.current.preview(fixture.expected.releaseId));
  assert.equal(ui.result.current.phase, "unavailable");
  assert.equal(ui.result.current.snapshot, null);
});
test("late preview after current signer change or native invalidation stays private", async () => {
  let finish;
  handler = (c) =>
    c === "spaces_preview_work_release"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : normal(c);
  const ui = await mount();
  await ready(ui);
  const { act, waitFor } = await import("@testing-library/react");
  await act(async () => {
    void ui.result.current.preview(fixture.expected.releaseId);
  });
  await waitFor(() => assert.equal(typeof finish, "function"));
  await act(async () =>
    eventCallback({ event: "spaces-connections-invalidated", payload: null }),
  );
  assert.equal(ui.result.current.snapshot, null);
  await act(async () =>
    finish({ state: "ready", ...identity, preview: preview() }),
  );
  assert.equal(ui.result.current.snapshot, null);
  assert.equal(ui.result.current.phase, "access_lost");
});
test("hide and reopen clear renderer bytes and restore only freshly checked native preview", async () => {
  let allow = true;
  handler = (c) =>
    c === "spaces_query_work_releases"
      ? query(undefined, {
          previews: allow ? { [fixture.expected.releaseId]: preview() } : {},
        })
      : normal(c);
  const ui = await mount();
  await ready(ui);
  assert.equal(
    ui.result.current.snapshot.previews[fixture.expected.releaseId].markdown,
    fixture.preview.markdown,
  );
  const { act } = await import("@testing-library/react");
  await act(async () => {
    hidden = true;
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
  assert.equal(ui.result.current.snapshot, null);
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
  await ready(ui);
  assert.equal(
    ui.result.current.snapshot.previews[fixture.expected.releaseId].markdown,
    fixture.preview.markdown,
  );
  allow = false;
  await act(async () => ui.result.current.load());
  await ready(ui);
  assert.deepEqual(ui.result.current.snapshot.previews, {});
});
test("unknown decision does not auto-resend and exact native intent survives remount", async () => {
  let intent;
  handler = (c, input) => {
    if (c === "spaces_decide_work_release") {
      intent = {
        operationId: input.operationId,
        expectedVersion: input.expectedVersion,
        termsDigest: input.termsDigest,
        payloadDigest: input.payloadDigest,
        decision: input.decision,
      };
      return { state: "uncertain" };
    }
    if (c === "spaces_query_work_releases")
      return query(undefined, {
        pendingDecisions: intent
          ? { [fixture.expected.releaseId]: intent }
          : {},
      });
    return normal(c);
  };
  const ui = await mount();
  await ready(ui);
  const { act } = await import("@testing-library/react");
  await act(async () =>
    ui.result.current.decide(fixture.expected.releaseId, "decline"),
  );
  assert.equal(ui.result.current.phase, "uncertain");
  const first = count("spaces_decide_work_release")[0].args.input;
  await act(async () => {
    ui.unmount();
  });
  const reopened = await mount();
  await ready(reopened);
  assert.equal(count("spaces_decide_work_release").length, 1);
  assert.deepEqual(
    reopened.result.current.pendingDecisions[fixture.expected.releaseId],
    intent,
  );
  await act(async () =>
    reopened.result.current.decide(fixture.expected.releaseId, "approve"),
  );
  assert.equal(count("spaces_decide_work_release").length, 1);
  await act(async () =>
    reopened.result.current.decide(fixture.expected.releaseId, "decline"),
  );
  const last = count("spaces_decide_work_release")[1].args.input;
  for (const key of [
    "operationId",
    "expectedVersion",
    "termsDigest",
    "payloadDigest",
    "decision",
  ])
    assert.equal(last[key], first[key]);
  assert.equal(last.actorId, undefined);
  assert.equal(count("send_message").length, 0);
});
test("receipt confirms attributable decision but current revoked record wins historical approval", async () => {
  handler = (c, input) => {
    if (c !== "spaces_decide_work_release") return normal(c);
    const release = preview().release;
    release.version = 3;
    release.state = "revoked";
    return {
      state: "confirmed",
      ...identity,
      result: {
        release,
        receipt: {
          receiptId: "receipt_synthetic",
          operationId: input.operationId,
          actorId: identity.principalId,
          releaseId: release.id,
          termsDigest: input.termsDigest,
          payloadDigest: input.payloadDigest,
          version: 2,
          decision: input.decision,
          decidedAt: "2027-01-15T08:02:00Z",
        },
      },
    };
  };
  const ui = await mount();
  await ready(ui);
  const { act } = await import("@testing-library/react");
  await act(async () =>
    ui.result.current.decide(fixture.expected.releaseId, "decline"),
  );
  assert.equal(ui.result.current.snapshot.lookup.releases[0].state, "revoked");
  assert.deepEqual(ui.result.current.snapshot.previews, {});
  assert.equal(count("spaces_decide_work_release").length, 1);
});
test("publication reconciliation metadata never restores bytes without current private authority", async () => {
  const p = preview();
  p.release.state = "publishing";
  p.release.version = 3;
  handler = (c) =>
    c === "spaces_query_work_releases"
      ? query([p.release], { previews: { [p.release.id]: p } })
      : normal(c);
  const ui = await mount();
  await ready(ui);
  assert.equal(
    ui.result.current.snapshot.lookup.releases[0].state,
    "publishing",
  );
  assert.deepEqual(ui.result.current.snapshot.previews, {});
});
