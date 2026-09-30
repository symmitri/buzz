import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import fixture from "../../../../tests/fixtures/work-consent.json" with {
  type: "json",
};
import intentFixture from "../../../../tests/fixtures/work-consent-intent.json" with {
  type: "json",
};
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
  pretendToBeVisual: true,
});
const realNow = Date.now;
const target = {
  channelId: "channel_fixture",
  rootEventId: "a".repeat(64),
  expectedSignerPubkey: "b".repeat(64),
};
const context = {
  ...target,
  expectedRelayUrl: "wss://relay.example.test",
  admissionRequestId: "admission_fixture",
};
const identity = {
  principalId: "usr_owner",
  organisationId: "org_fixture",
  scopeToken: "scope_fixture",
};
const record = () => ({
  ...structuredClone(fixture.consent),
  state: "pending",
  version: 1,
});
const query = (records = [record()]) => ({
  state: "ready",
  ...identity,
  lookup: { workId: "work_fixture", requests: records, participants: [] },
});
const intentRecord = () => structuredClone(intentFixture.intent);
const intentQuery = (intents = [intentRecord()]) => ({
  state: "ready",
  ...identity,
  lookup: { workId: "work_fixture", intents },
});
const intentOwner = (overrides = {}) => ({
  state: "ready",
  ...identity,
  ownerResult: {
    intent: intentRecord(),
    accounts: structuredClone(intentFixture.accounts),
    ...overrides,
  },
});
let calls = [],
  handler,
  callbackMap = new Map(),
  eventCallback,
  listenFailure = false,
  hidden = false;
before(() => {
  Date.now = () => Date.parse(fixture.receipt.decidedAt);
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
      const id = callbackMap.size + 1;
      callbackMap.set(id, fn);
      return id;
    },
    unregisterCallback() {},
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "plugin:event|listen") {
        if (listenFailure) throw new Error("synthetic listener failure");
        eventCallback = callbackMap.get(args.handler);
        return 1;
      }
      if (
        command === "plugin:event|unlisten" ||
        command === "spaces_cancel_work_consent"
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
  callbackMap = new Map();
  eventCallback = undefined;
  listenFailure = false;
  hidden = false;
});
after(() => {
  Date.now = realNow;
  dom.window.close();
});
function normal(command) {
  if (command === "spaces_work_consent_context")
    return { state: "ready", context };
  if (command === "spaces_query_work_consents") return query();
  if (command === "spaces_query_work_consent_intents") return intentQuery([]);
  if (command === "spaces_query_work_consent_task_status")
    return { state: "unavailable" };
  throw new Error(`unexpected command ${command}`);
}
function selecting(command) {
  if (command === "spaces_query_work_consents") return query([]);
  if (command === "spaces_query_work_consent_intents") return intentQuery();
  if (command === "spaces_read_work_consent_intent") return intentOwner();
  return normal(command);
}
async function mount(initial = target) {
  const { renderHook } = await import("@testing-library/react");
  const { useWorkConsent } = await import("./useWorkConsent.ts");
  return renderHook(({ target }) => useWorkConsent(target), {
    initialProps: { target: initial },
  });
}
const count = (name) => calls.filter((call) => call.command === name);
async function ready(ui) {
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() => {
    assert.equal(ui.result.current.phase, "ready");
    assert.ok(ui.result.current.intentPhase);
  });
}

test("closed native gate makes no private query or startup catalog reads", async () => {
  handler = async () => ({ state: "unsupported" });
  const { waitFor } = await import("@testing-library/react");
  const ui = await mount(null);
  assert.equal(count("spaces_work_consent_context").length, 0);
  ui.rerender({ target });
  await waitFor(() => assert.equal(ui.result.current.phase, "unsupported"));
  assert.equal(count("spaces_query_work_consents").length, 0);
  assert.equal(count("spaces_read_connections").length, 0);
});

test("listener precedes reads and failed listener prevents any native context read", async () => {
  listenFailure = true;
  handler = normal;
  const { waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await waitFor(() => assert.equal(ui.result.current.phase, "unavailable"));
  assert.equal(count("spaces_work_consent_context").length, 0);
});

test("only exact current owner records survive native query", async () => {
  const foreign = record();
  foreign.terms.grantorId = "usr_other";
  handler = (command) =>
    command === "spaces_query_work_consents"
      ? query([foreign])
      : normal(command);
  const { waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await waitFor(() => assert.equal(ui.result.current.phase, "access_lost"));
  assert.equal(ui.result.current.snapshot, null);
});

test("identity props immediately fence late owner query completion", async () => {
  let finish;
  handler = (command) =>
    command === "spaces_query_work_consents"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : normal(command);
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await waitFor(() => assert.equal(typeof finish, "function"));
  ui.rerender({ target: { ...target, expectedSignerPubkey: "c".repeat(64) } });
  assert.equal(ui.result.current.snapshot, null);
  await act(async () => finish(query()));
  assert.equal(ui.result.current.snapshot, null);
});

test("duplicate click is single flight and a replay renders current revoked record", async () => {
  let finish;
  handler = (command) =>
    command === "spaces_decide_work_consent"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : normal(command);
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => {
    void ui.result.current.decide("consent_fixture", "approve");
    void ui.result.current.decide("consent_fixture", "approve");
  });
  await waitFor(() => assert.equal(typeof finish, "function"));
  assert.equal(count("spaces_decide_work_consent").length, 1);
  const input = count("spaces_decide_work_consent")[0].args.input;
  assert.equal(input.expectedVersion, 1);
  assert.equal(input.termsDigest, record().termsDigest);
  assert.equal(input.expectedScopeToken, identity.scopeToken);
  assert.equal(input.actorId, undefined);
  await act(async () =>
    finish({ state: "confirmed", ...identity, result: fixture }),
  );
  assert.equal(ui.result.current.snapshot.lookup.requests[0].state, "revoked");
  assert.equal(count("send_message").length, 0);
});

test("uncertain decision retries exact operation after authoritative same-version refresh", async () => {
  handler = (command) =>
    command === "spaces_decide_work_consent"
      ? { state: "uncertain" }
      : normal(command);
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => ui.result.current.decide("consent_fixture", "approve"));
  assert.equal(ui.result.current.phase, "uncertain");
  const first = count("spaces_decide_work_consent")[0].args.input;
  await act(async () => ui.result.current.load());
  await ready(ui);
  await act(async () => ui.result.current.decide("consent_fixture", "decline"));
  assert.equal(count("spaces_decide_work_consent").length, 1);
  await act(async () => ui.result.current.decide("consent_fixture", "approve"));
  assert.deepEqual(count("spaces_decide_work_consent")[1].args.input, first);
});

test("conflict reads exact consent before a new explicit decision on changed terms", async () => {
  const changed = record();
  changed.version = 2;
  changed.termsDigest = "d".repeat(64);
  handler = (command) =>
    command === "spaces_decide_work_consent"
      ? { state: "conflict" }
      : command === "spaces_read_work_consent"
        ? { state: "ready", ...identity, consent: changed }
        : normal(command);
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => ui.result.current.decide("consent_fixture", "approve"));
  assert.equal(count("spaces_read_work_consent").length, 1);
  assert.equal(count("spaces_decide_work_consent").length, 1);
  assert.equal(
    ui.result.current.snapshot.lookup.requests[0].termsDigest,
    changed.termsDigest,
  );
  await act(async () => ui.result.current.decide("consent_fixture", "decline"));
  assert.equal(
    count("spaces_decide_work_consent")[1].args.input.termsDigest,
    changed.termsDigest,
  );
  assert.notEqual(
    count("spaces_decide_work_consent")[0].args.input.operationId,
    count("spaces_decide_work_consent")[1].args.input.operationId,
  );
});

test("native invalidation clears private data and suppresses an in-flight approval response", async () => {
  let finish;
  handler = (command) =>
    command === "spaces_decide_work_consent"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : normal(command);
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => {
    void ui.result.current.decide("consent_fixture", "approve");
  });
  await waitFor(() => assert.equal(typeof finish, "function"));
  await act(async () => eventCallback({ payload: null }));
  assert.equal(ui.result.current.snapshot, null);
  await act(async () =>
    finish({ state: "confirmed", ...identity, result: fixture }),
  );
  assert.equal(ui.result.current.snapshot, null);
  assert.equal(ui.result.current.phase, "access_lost");
});

test("hidden view cancels its native slot and ignores late results", async () => {
  let finish;
  handler = (command) =>
    command === "spaces_query_work_consents"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : normal(command);
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await waitFor(() => assert.equal(typeof finish, "function"));
  await act(async () => {
    hidden = true;
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
  await act(async () => finish(query()));
  assert.equal(ui.result.current.snapshot, null);
  assert.ok(count("spaces_cancel_work_consent").length > 0);
  handler = normal;
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
  await ready(ui);
});

test("Refresh can restore a failed invalidation subscription", async () => {
  listenFailure = true;
  handler = normal;
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await waitFor(() => assert.equal(ui.result.current.phase, "unavailable"));
  listenFailure = false;
  await act(async () => ui.result.current.load());
  await ready(ui);
  const listenIndex = calls.findLastIndex(
    (call) => call.command === "plugin:event|listen",
  );
  assert.ok(
    listenIndex <
      calls.findIndex((call) => call.command === "spaces_work_consent_context"),
  );
});

test("unavailable recovery does not discard an uncertain decision operation", async () => {
  let failRead = false;
  handler = (command) =>
    command === "spaces_decide_work_consent"
      ? { state: "uncertain" }
      : command === "spaces_query_work_consents" && failRead
        ? { state: "unavailable" }
        : normal(command);
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => ui.result.current.decide("consent_fixture", "approve"));
  const first = count("spaces_decide_work_consent")[0].args.input.operationId;
  failRead = true;
  await act(async () => ui.result.current.load());
  assert.equal(ui.result.current.phase, "unavailable");
  assert.equal(ui.result.current.snapshot, null);
  failRead = false;
  await act(async () => ui.result.current.load());
  await act(async () => ui.result.current.decide("consent_fixture", "approve"));
  assert.equal(
    count("spaces_decide_work_consent")[1].args.input.operationId,
    first,
  );
});

test("a conflict with unavailable read stays uncertain, not an asserted identity loss", async () => {
  handler = (command) =>
    command === "spaces_decide_work_consent"
      ? { state: "conflict" }
      : command === "spaces_read_work_consent"
        ? { state: "unavailable" }
        : normal(command);
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => ui.result.current.decide("consent_fixture", "approve"));
  assert.equal(ui.result.current.phase, "uncertain");
  assert.equal(count("spaces_decide_work_consent").length, 1);
});

test("native journal restores exact uncertain decision after complete renderer remount", async () => {
  const oldIntent = {
    operationId: "op_before_settings",
    expectedVersion: 1,
    termsDigest: record().termsDigest,
    decision: "approve",
  };
  handler = (command) =>
    command === "spaces_query_work_consents"
      ? { ...query(), pendingDecisions: { consent_fixture: oldIntent } }
      : command === "spaces_decide_work_consent"
        ? { state: "uncertain" }
        : normal(command);
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => ui.result.current.decide("consent_fixture", "approve"));
  assert.equal(
    count("spaces_decide_work_consent")[0].args.input.operationId,
    oldIntent.operationId,
  );
});

test("changed native scope token rejects response before it can replace private state", async () => {
  handler = (command) =>
    command === "spaces_decide_work_consent"
      ? {
          state: "confirmed",
          ...identity,
          scopeToken: "replacement_scope",
          result: fixture,
        }
      : normal(command);
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => ui.result.current.decide("consent_fixture", "approve"));
  assert.equal(ui.result.current.phase, "access_lost");
  assert.equal(ui.result.current.snapshot, null);
});

test("owner history cursor stays on exact origin for old-request read and revoke", async () => {
  const cursor = { createdAt: "2026-09-17T14:00:00Z", id: "consent_fixture" };
  const historical = record();
  historical.id = "consent_older";
  historical.state = "expired";
  handler = (command, input) => {
    if (command === "spaces_query_work_consents")
      return input.before
        ? query([historical])
        : { ...query(), lookup: { ...query().lookup, next: cursor } };
    if (command === "spaces_decide_work_consent") return { state: "conflict" };
    if (command === "spaces_read_work_consent")
      return { state: "ready", ...identity, consent: historical };
    return normal(command);
  };
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () =>
    ui.result.current.loadPage(ui.result.current.snapshot.lookup.next),
  );
  await waitFor(() =>
    assert.equal(
      ui.result.current.snapshot?.lookup.requests[0].id,
      historical.id,
    ),
  );
  await act(async () => ui.result.current.decide(historical.id, "revoke"));
  for (const command of [
    "spaces_decide_work_consent",
    "spaces_read_work_consent",
  ]) {
    const input = count(command)[0].args.input;
    assert.deepEqual(input.before, cursor);
    assert.equal(input.channelId, context.channelId);
    assert.equal(input.rootEventId, context.rootEventId);
    assert.equal(input.expectedScopeToken, identity.scopeToken);
  }
  await act(async () => ui.result.current.loadPage());
  await waitFor(() =>
    assert.equal(
      ui.result.current.snapshot?.lookup.requests[0].id,
      "consent_fixture",
    ),
  );
  assert.equal(
    count("spaces_query_work_consents").at(-1).args.input.before,
    undefined,
  );
});

test("changing native owner while paging clears every old request and cursor", async () => {
  handler = (command, input) =>
    command === "spaces_query_work_consents" && input.before
      ? { ...query(), scopeToken: "replacement_scope" }
      : normal(command);
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () =>
    ui.result.current.loadPage({
      createdAt: fixture.consent.createdAt,
      id: fixture.consent.id,
    }),
  );
  await waitFor(() => assert.equal(ui.result.current.phase, "access_lost"));
  assert.equal(ui.result.current.snapshot, null);
});

for (const failureAt of ["query", "read"]) {
  test(`unavailable intent ${failureAt} preserves the existing consent revoke path`, async () => {
    const approved = { ...record(), state: "approved" };
    handler = (command) => {
      if (command === "spaces_query_work_consents") return query([approved]);
      if (command === "spaces_query_work_consent_intents")
        return failureAt === "query" ? { state: "unavailable" } : intentQuery();
      if (command === "spaces_read_work_consent_intent")
        return { state: "unavailable" };
      if (command === "spaces_decide_work_consent")
        return { state: "confirmed", ...identity, result: fixture };
      return normal(command);
    };
    const { act } = await import("@testing-library/react");
    const ui = await mount();
    await ready(ui);
    assert.equal(ui.result.current.intentPhase, "unavailable");
    assert.deepEqual(ui.result.current.snapshot.lookup.requests, [approved]);
    await act(async () => ui.result.current.decide(approved.id, "revoke"));
    assert.equal(count("spaces_decide_work_consent").length, 1);
    assert.equal(
      ui.result.current.snapshot.lookup.requests[0].state,
      "revoked",
    );
  });
}

test("intent lookup loads only the selected owner's accounts and discards the previous choices", async () => {
  const first = intentRecord();
  const second = { ...intentRecord(), id: "intent_second" };
  handler = (command, input) => {
    if (command === "spaces_query_work_consent_intents")
      return intentQuery([first, second]);
    if (command === "spaces_read_work_consent_intent")
      return intentOwner({
        intent: input.intentId === first.id ? first : second,
      });
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  assert.equal(count("spaces_read_work_consent_intent").length, 1);
  assert.equal(ui.result.current.selectedIntentId, first.id);
  assert.deepEqual(Object.keys(ui.result.current.snapshot.intentOwners), [
    first.id,
  ]);
  await act(async () => ui.result.current.loadIntent(second.id));
  assert.equal(count("spaces_read_work_consent_intent").length, 2);
  assert.equal(ui.result.current.selectedIntentId, second.id);
  assert.deepEqual(Object.keys(ui.result.current.snapshot.intentOwners), [
    second.id,
  ]);
  assert.equal(count("spaces_read_connections").length, 0);
});

for (const invalid of ["scope", "organisation", "work", "owner"]) {
  test(`intent ${invalid} mismatch clears private account choices`, async () => {
    handler = (command) => {
      if (command === "spaces_query_work_consent_intents") {
        const result = intentQuery();
        if (invalid === "scope") result.scopeToken = "replacement_scope";
        if (invalid === "organisation")
          result.lookup.intents[0].terms.orgId = "org_other";
        if (invalid === "work") result.lookup.workId = "work_other";
        return result;
      }
      if (command === "spaces_read_work_consent_intent") {
        const foreign = record();
        foreign.terms.grantorId = "usr_other";
        return intentOwner({ consent: foreign });
      }
      return selecting(command);
    };
    const { waitFor } = await import("@testing-library/react");
    const ui = await mount();
    await waitFor(() => assert.equal(ui.result.current.phase, "access_lost"));
    assert.equal(ui.result.current.snapshot, null);
    assert.deepEqual(ui.result.current.pendingSelections, {});
    assert.equal(count("spaces_select_work_consent_account").length, 0);
  });
}

test("a bound terminal consent keeps its original account and cannot select a replacement", async () => {
  handler = (command) =>
    command === "spaces_read_work_consent_intent"
      ? intentOwner({ consent: structuredClone(intentFixture.consent) })
      : selecting(command);
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  const owner = ui.result.current.snapshot.intentOwners.intent_fixture;
  assert.equal(owner.accounts[0].accountId, "account_replacement");
  assert.equal(owner.consent.terms.accountId, "account_fixture");
  assert.equal(owner.consent.state, "revoked");
  assert.deepEqual(ui.result.current.snapshot.lookup.requests, [
    intentFixture.consent,
  ]);
  await act(async () =>
    ui.result.current.selectAccount(owner.intent.id, owner.accounts[0]),
  );
  assert.equal(count("spaces_select_work_consent_account").length, 0);
  assert.equal(count("spaces_decide_work_consent").length, 0);
});

test("account selection is explicit, single flight, and only creates a pending review", async () => {
  let finish;
  handler = (command) =>
    command === "spaces_select_work_consent_account"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : selecting(command);
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  assert.equal(count("spaces_select_work_consent_account").length, 0);
  const account = intentFixture.accounts[0];
  await act(async () => {
    void ui.result.current.selectAccount("intent_fixture", account);
    void ui.result.current.selectAccount("intent_fixture", account);
  });
  await waitFor(() => assert.equal(typeof finish, "function"));
  assert.equal(ui.result.current.busyIntentId, "intent_fixture");
  assert.equal(count("spaces_select_work_consent_account").length, 1);
  const input = count("spaces_select_work_consent_account")[0].args.input;
  assert.equal(input.intentId, "intent_fixture");
  assert.equal(input.expectedVersion, intentFixture.intent.version);
  assert.equal(input.intentDigest, intentFixture.intent.digest);
  assert.equal(input.accountId, account.accountId);
  assert.equal(input.accountVersion, account.accountVersion);
  assert.equal(input.expectedScopeToken, identity.scopeToken);
  assert.equal(input.actorId, undefined);
  const pending = record();
  pending.terms.accountId = account.accountId;
  pending.terms.accountVersion = account.accountVersion;
  await act(async () =>
    finish({ state: "confirmed", ...identity, consent: pending }),
  );
  assert.equal(ui.result.current.snapshot.lookup.requests[0].state, "pending");
  assert.equal(ui.result.current.busyIntentId, null);
  assert.equal(count("spaces_decide_work_consent").length, 0);
  assert.equal(count("send_message").length, 0);
  assert.ok(
    calls.every(
      ({ command }) =>
        command.startsWith("spaces_") || command.startsWith("plugin:event|"),
    ),
  );
});

test("uncertain account selection keeps the original operation across reload and account rotation", async () => {
  let rotated = false;
  handler = (command) => {
    if (command === "spaces_select_work_consent_account")
      return { state: "uncertain" };
    if (command === "spaces_read_work_consent_intent")
      return intentOwner({
        accounts: rotated
          ? [
              {
                ...intentFixture.accounts[0],
                accountId: "account_new",
                accountVersion: 3,
              },
            ]
          : structuredClone(intentFixture.accounts),
      });
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () =>
    ui.result.current.selectAccount(
      "intent_fixture",
      intentFixture.accounts[0],
    ),
  );
  assert.equal(ui.result.current.intentPhase, "uncertain");
  const first = count("spaces_select_work_consent_account")[0].args.input;
  assert.equal(
    ui.result.current.pendingSelections.intent_fixture.operationId,
    first.operationId,
  );
  rotated = true;
  await act(async () => ui.result.current.load());
  assert.equal(count("spaces_select_work_consent_account").length, 1);
  const currentAccount =
    ui.result.current.snapshot.intentOwners.intent_fixture.accounts[0];
  await act(async () =>
    ui.result.current.selectAccount("intent_fixture", currentAccount),
  );
  assert.equal(count("spaces_select_work_consent_account").length, 1);
  await act(async () => ui.result.current.retrySelection("intent_fixture"));
  assert.deepEqual(
    count("spaces_select_work_consent_account")[1].args.input,
    first,
  );
  assert.equal(count("spaces_decide_work_consent").length, 0);
});

test("native selection journal survives a complete renderer remount without an automatic retry", async () => {
  let journal = {};
  handler = (command, input) => {
    if (command === "spaces_query_work_consent_intents")
      return { ...intentQuery(), pendingSelections: journal };
    if (command === "spaces_read_work_consent_intent")
      return { ...intentOwner(), pendingSelections: journal };
    if (command === "spaces_select_work_consent_account") {
      journal = {
        intent_fixture: {
          operationId: input.operationId,
          expectedVersion: input.expectedVersion,
          intentDigest: input.intentDigest,
          accountId: input.accountId,
          accountVersion: input.accountVersion,
        },
      };
      return { state: "uncertain" };
    }
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const firstView = await mount();
  await ready(firstView);
  await act(async () =>
    firstView.result.current.selectAccount(
      "intent_fixture",
      intentFixture.accounts[0],
    ),
  );
  const original = structuredClone(journal.intent_fixture);
  await act(async () => firstView.unmount());
  const restored = await mount();
  await ready(restored);
  assert.deepEqual(
    restored.result.current.pendingSelections.intent_fixture,
    original,
  );
  assert.equal(count("spaces_select_work_consent_account").length, 1);
  await act(async () =>
    restored.result.current.retrySelection("intent_fixture"),
  );
  const replay = count("spaces_select_work_consent_account")[1].args.input;
  for (const [field, value] of Object.entries(original))
    assert.equal(replay[field], value);
});

test("selection conflict rereads the exact intent and requires a new explicit selection", async () => {
  let changed = false;
  const next = {
    ...intentFixture.accounts[0],
    accountId: "account_new",
    accountVersion: 3,
  };
  handler = (command) => {
    if (command === "spaces_select_work_consent_account") {
      changed = true;
      return { state: "conflict" };
    }
    if (command === "spaces_read_work_consent_intent")
      return intentOwner({
        accounts: changed ? [next] : structuredClone(intentFixture.accounts),
      });
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () =>
    ui.result.current.selectAccount(
      "intent_fixture",
      intentFixture.accounts[0],
    ),
  );
  assert.equal(count("spaces_select_work_consent_account").length, 1);
  assert.equal(count("spaces_read_work_consent_intent").length, 2);
  const read = count("spaces_read_work_consent_intent").at(-1).args.input;
  assert.equal(read.intentId, "intent_fixture");
  assert.equal(read.expectedScopeToken, identity.scopeToken);
  assert.deepEqual(
    ui.result.current.snapshot.intentOwners.intent_fixture.accounts,
    [next],
  );
  assert.deepEqual(ui.result.current.pendingSelections, {});
  await act(async () =>
    ui.result.current.selectAccount("intent_fixture", next),
  );
  const selections = count("spaces_select_work_consent_account");
  assert.equal(
    selections[1].args.input.intentDigest,
    intentFixture.intent.digest,
  );
  assert.equal(selections[1].args.input.accountId, next.accountId);
  assert.equal(selections[1].args.input.accountVersion, next.accountVersion);
  assert.notEqual(
    selections[1].args.input.operationId,
    selections[0].args.input.operationId,
  );
});

test("changed terms under the same immutable intent ID fail closed after conflict", async () => {
  let changed = false;
  handler = (command) => {
    if (command === "spaces_select_work_consent_account") {
      changed = true;
      return { state: "conflict" };
    }
    if (command === "spaces_read_work_consent_intent")
      return intentOwner({
        intent: changed
          ? { ...intentRecord(), version: 2, digest: "f".repeat(64) }
          : intentRecord(),
      });
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () =>
    ui.result.current.selectAccount(
      "intent_fixture",
      intentFixture.accounts[0],
    ),
  );
  assert.equal(ui.result.current.phase, "access_lost");
  assert.equal(ui.result.current.snapshot, null);
  assert.equal(count("spaces_select_work_consent_account").length, 1);
});

test("unavailable conflict reread retains the exact uncertain selection for recovery", async () => {
  let unavailable = false;
  handler = (command) => {
    if (command === "spaces_select_work_consent_account") {
      unavailable = true;
      return { state: "conflict" };
    }
    if (command === "spaces_read_work_consent_intent" && unavailable)
      return { state: "unavailable" };
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () =>
    ui.result.current.selectAccount(
      "intent_fixture",
      intentFixture.accounts[0],
    ),
  );
  assert.equal(ui.result.current.intentPhase, "uncertain");
  const original = count("spaces_select_work_consent_account")[0].args.input;
  await act(async () => ui.result.current.load());
  assert.equal(ui.result.current.intentPhase, "unavailable");
  assert.equal(
    ui.result.current.pendingSelections.intent_fixture.operationId,
    original.operationId,
  );
  unavailable = false;
  await act(async () => ui.result.current.load());
  assert.equal(count("spaces_select_work_consent_account").length, 1);
  await act(async () => ui.result.current.retrySelection("intent_fixture"));
  assert.deepEqual(
    count("spaces_select_work_consent_account")[1].args.input,
    original,
  );
});

for (const stage of ["read", "select"]) {
  test(`changing the thread discards a late private intent ${stage} response`, async () => {
    let finish;
    const deferred =
      stage === "read"
        ? "spaces_read_work_consent_intent"
        : "spaces_select_work_consent_account";
    handler = (command) =>
      command === deferred
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : selecting(command);
    const { act, waitFor } = await import("@testing-library/react");
    const ui = await mount();
    if (stage === "select") {
      await ready(ui);
      await act(async () => {
        void ui.result.current.selectAccount(
          "intent_fixture",
          intentFixture.accounts[0],
        );
      });
    }
    await waitFor(() => assert.equal(typeof finish, "function"));
    ui.rerender({ target: null });
    assert.equal(ui.result.current.snapshot, null);
    await act(async () =>
      finish(
        stage === "read"
          ? intentOwner()
          : { state: "confirmed", ...identity, consent: record() },
      ),
    );
    assert.equal(ui.result.current.snapshot, null);
    assert.equal(ui.result.current.phase, "idle");
    assert.deepEqual(ui.result.current.pendingSelections, {});
  });
}

test("a changed native owner rejects confirmed account selection and clears every private projection", async () => {
  handler = (command) =>
    command === "spaces_select_work_consent_account"
      ? {
          state: "confirmed",
          ...identity,
          scopeToken: "other_scope",
          consent: record(),
        }
      : selecting(command);
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () =>
    ui.result.current.selectAccount(
      "intent_fixture",
      intentFixture.accounts[0],
    ),
  );
  assert.equal(ui.result.current.phase, "access_lost");
  assert.equal(ui.result.current.snapshot, null);
  assert.deepEqual(ui.result.current.pendingSelections, {});
});

test("intent pagination and consent history preserve their independent cursors", async () => {
  const consentCursor = {
    createdAt: fixture.consent.createdAt,
    id: fixture.consent.id,
  };
  const intentCursor = {
    createdAt: intentFixture.intent.createdAt,
    id: intentFixture.intent.id,
  };
  const olderConsent = { ...record(), id: "consent_older", state: "expired" };
  const olderIntent = { ...intentRecord(), id: "intent_older" };
  handler = (command, input) => {
    if (command === "spaces_query_work_consents")
      return input.before
        ? query([olderConsent])
        : { ...query(), lookup: { ...query().lookup, next: consentCursor } };
    if (command === "spaces_query_work_consent_intents")
      return input.before
        ? intentQuery([olderIntent])
        : {
            ...intentQuery(),
            lookup: { ...intentQuery().lookup, next: intentCursor },
          };
    if (command === "spaces_read_work_consent_intent")
      return intentOwner({
        intent:
          input.intentId === olderIntent.id ? olderIntent : intentRecord(),
      });
    return normal(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => ui.result.current.loadPage(consentCursor));
  assert.deepEqual(
    count("spaces_query_work_consents").at(-1).args.input.before,
    consentCursor,
  );
  assert.equal(
    count("spaces_query_work_consent_intents").at(-1).args.input.before,
    undefined,
  );
  await act(async () => ui.result.current.loadIntentPage(intentCursor));
  assert.deepEqual(
    count("spaces_query_work_consents").at(-1).args.input.before,
    consentCursor,
  );
  assert.deepEqual(
    count("spaces_query_work_consent_intents").at(-1).args.input.before,
    intentCursor,
  );
  assert.deepEqual(
    count("spaces_read_work_consent_intent").at(-1).args.input.before,
    intentCursor,
  );
  assert.equal(
    ui.result.current.snapshot.lookup.requests[0].id,
    olderConsent.id,
  );
  assert.equal(ui.result.current.selectedIntentId, olderIntent.id);
  await act(async () => ui.result.current.loadIntentPage());
  assert.equal(
    count("spaces_query_work_consent_intents").at(-1).args.input.before,
    undefined,
  );
  assert.deepEqual(
    count("spaces_query_work_consents").at(-1).args.input.before,
    consentCursor,
  );
  assert.equal(ui.result.current.selectedIntentId, "intent_fixture");
});

test("a bound consent outside the history page keeps its source intent cursor for revoke", async () => {
  const cursor = {
    createdAt: intentFixture.intent.createdAt,
    id: "intent_newer",
  };
  const bound = { ...structuredClone(intentFixture.consent), state: "stale" };
  handler = (command) => {
    if (command === "spaces_read_work_consent_intent")
      return intentOwner({ consent: bound });
    if (command === "spaces_decide_work_consent") return { state: "conflict" };
    if (command === "spaces_read_work_consent")
      return {
        state: "ready",
        ...identity,
        consent: structuredClone(intentFixture.consent),
      };
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () => ui.result.current.loadIntentPage(cursor));
  assert.deepEqual(ui.result.current.snapshot.lookup.requests, [bound]);
  await act(async () => ui.result.current.decide(bound.id, "revoke"));
  for (const command of [
    "spaces_decide_work_consent",
    "spaces_read_work_consent",
  ]) {
    const input = count(command)[0].args.input;
    assert.equal(input.sourceIntentId, "intent_fixture");
    assert.deepEqual(input.sourceIntentBefore, cursor);
    assert.equal(input.before, undefined);
    assert.equal(input.expectedScopeToken, identity.scopeToken);
  }
  assert.equal(ui.result.current.snapshot.lookup.requests[0].state, "revoked");
  assert.equal(count("spaces_select_work_consent_account").length, 0);
});

for (const accountProjection of ["replacement", "empty"]) {
  test(`omitted known binding with ${accountProjection} accounts stays visible and cannot be selected again`, async () => {
    let excluded = false,
      omitted = false;
    const bound = structuredClone(intentFixture.consent);
    handler = (command) => {
      if (command === "spaces_query_work_consent_intents")
        return intentQuery(excluded ? [] : [intentRecord()]);
      if (command === "spaces_read_work_consent_intent")
        return omitted
          ? intentOwner({
              accounts:
                accountProjection === "empty"
                  ? []
                  : structuredClone(intentFixture.accounts),
            })
          : intentOwner({ consent: bound });
      return selecting(command);
    };
    const { act } = await import("@testing-library/react");
    const ui = await mount();
    await ready(ui);
    excluded = true;
    omitted = true;
    await act(async () => ui.result.current.load());
    assert.equal(ui.result.current.intentPhase, "unavailable");
    assert.deepEqual(ui.result.current.snapshot.lookup.requests, [bound]);
    assert.deepEqual(
      ui.result.current.snapshot.intentOwners.intent_fixture.consent,
      bound,
    );
    assert.deepEqual(ui.result.current.snapshot.unconfirmedConsents, [
      bound.id,
    ]);
    const read = count("spaces_read_work_consent_intent").at(-1).args.input;
    assert.equal(read.intentId, "intent_fixture");
    assert.equal(read.expectedConsentId, bound.id);
    assert.equal(read.expectedScopeToken, identity.scopeToken);
    await act(async () => {
      await ui.result.current.selectAccount(
        "intent_fixture",
        intentFixture.accounts[0],
      );
      await ui.result.current.decide(bound.id, "revoke");
    });
    assert.equal(count("spaces_select_work_consent_account").length, 0);
    assert.equal(count("spaces_decide_work_consent").length, 0);
    omitted = false;
    await act(async () => ui.result.current.load());
    assert.equal(ui.result.current.intentPhase, "ready");
    assert.deepEqual(ui.result.current.snapshot.unconfirmedConsents, []);
    assert.deepEqual(ui.result.current.snapshot.lookup.requests, [bound]);
  });
}

test("confirmed selection stays bound after the intent leaves the unbound query", async () => {
  let selected = false;
  const pending = record();
  Object.assign(pending.terms, {
    accountId: intentFixture.accounts[0].accountId,
    accountVersion: intentFixture.accounts[0].accountVersion,
  });
  const current = { ...pending, state: "revoked", version: 3 };
  handler = (command) => {
    if (command === "spaces_query_work_consent_intents")
      return intentQuery(selected ? [] : [intentRecord()]);
    if (command === "spaces_select_work_consent_account") {
      selected = true;
      return { state: "confirmed", ...identity, consent: pending };
    }
    if (command === "spaces_read_work_consent_intent")
      return selected ? intentOwner({ consent: current }) : intentOwner();
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () =>
    ui.result.current.selectAccount(
      "intent_fixture",
      intentFixture.accounts[0],
    ),
  );
  assert.deepEqual(ui.result.current.snapshot.lookup.requests, [pending]);
  await act(async () => ui.result.current.load());
  assert.deepEqual(ui.result.current.snapshot.intentLookup.intents, []);
  assert.deepEqual(ui.result.current.snapshot.lookup.requests, [current]);
  assert.equal(ui.result.current.selectedIntentId, "intent_fixture");
  assert.equal(ui.result.current.intentPhase, "ready");
  assert.equal(
    count("spaces_read_work_consent_intent").at(-1).args.input
      .expectedConsentId,
    current.id,
  );
  assert.equal(count("spaces_select_work_consent_account").length, 1);
  assert.equal(count("spaces_decide_work_consent").length, 0);
});

test("remount recovers an excluded intent from the native selection journal using only its owner read", async () => {
  let journal = {},
    remounted = false;
  const bound = structuredClone(intentFixture.consent);
  Object.assign(bound.terms, {
    accountId: intentFixture.accounts[0].accountId,
    accountVersion: intentFixture.accounts[0].accountVersion,
  });
  handler = (command, input) => {
    if (command === "spaces_query_work_consent_intents")
      return {
        ...intentQuery(remounted ? [] : [intentRecord()]),
        pendingSelections: journal,
      };
    if (command === "spaces_read_work_consent_intent")
      return remounted ? intentOwner({ consent: bound }) : intentOwner();
    if (command === "spaces_select_work_consent_account") {
      journal = {
        intent_fixture: {
          operationId: input.operationId,
          expectedVersion: input.expectedVersion,
          intentDigest: input.intentDigest,
          accountId: input.accountId,
          accountVersion: input.accountVersion,
        },
      };
      return { state: "uncertain" };
    }
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  await act(async () =>
    ui.result.current.selectAccount(
      "intent_fixture",
      intentFixture.accounts[0],
    ),
  );
  await act(async () => ui.unmount());
  remounted = true;
  const restored = await mount();
  await ready(restored);
  assert.deepEqual(restored.result.current.snapshot.intentLookup.intents, []);
  assert.deepEqual(restored.result.current.snapshot.lookup.requests, [bound]);
  assert.deepEqual(restored.result.current.pendingSelections, {});
  assert.equal(restored.result.current.selectedIntentId, "intent_fixture");
  assert.equal(
    count("spaces_read_work_consent_intent").at(-1).args.input.intentId,
    "intent_fixture",
  );
  assert.equal(count("spaces_select_work_consent_account").length, 1);
  assert.equal(count("spaces_decide_work_consent").length, 0);
});

test("a delayed same-owner refresh retains the selected account snapshot while both reads are pending", async () => {
  let refreshing = false,
    finishQuery,
    finishOwner,
    refresh;
  handler = (command) => {
    if (refreshing && command === "spaces_query_work_consent_intents")
      return new Promise((resolve) => {
        finishQuery = resolve;
      });
    if (refreshing && command === "spaces_read_work_consent_intent")
      return new Promise((resolve) => {
        finishOwner = resolve;
      });
    return selecting(command);
  };
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  const owners = ui.result.current.snapshot.intentOwners;
  refreshing = true;
  await act(async () => {
    refresh = ui.result.current.load();
  });
  await waitFor(() => assert.equal(typeof finishQuery, "function"));
  assert.equal(ui.result.current.phase, "ready");
  assert.equal(ui.result.current.selectedIntentId, "intent_fixture");
  assert.equal(ui.result.current.snapshot.intentOwners, owners);
  await act(async () => finishQuery(intentQuery()));
  await waitFor(() => assert.equal(typeof finishOwner, "function"));
  assert.equal(ui.result.current.phase, "ready");
  assert.equal(ui.result.current.snapshot.intentOwners, owners);
  await act(async () => {
    finishOwner(intentOwner());
    await refresh;
  });
  assert.equal(ui.result.current.intentPhase, "ready");
  assert.equal(ui.result.current.selectedIntentId, "intent_fixture");
  assert.equal(count("spaces_select_work_consent_account").length, 0);
});

function taskStatusResponse(overrides = {}) {
  return {
    state: "ready",
    ...identity,
    lookup: {
      orgId: identity.organisationId,
      ownerId: identity.principalId,
      workId: "work_fixture",
      observedAt: "2026-09-17T14:02:00Z",
      statuses: [
        {
          consentId: "consent_fixture",
          consentVersion: 2,
          termsDigest: fixture.consent.termsDigest,
          state: "running",
          revision: 1,
          updatedAt: "2026-09-17T14:01:50Z",
          leaseExpiresAt: "2026-09-17T14:02:30Z",
        },
      ],
      ...overrides,
    },
  };
}

test("owner task status uses the exact consent history origin and cursor without starting work", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  const before = { createdAt: "2026-09-17T13:50:00Z", id: "consent_older" };
  handler = (command) =>
    command === "spaces_query_work_consent_task_status"
      ? taskStatusResponse()
      : normal(command);
  const ui = await mount();
  await waitFor(() =>
    assert.equal(ui.result.current.snapshot?.statusPhase, "ready"),
  );
  assert.equal(
    ui.result.current.snapshot.taskStatusLookup.statuses[0].state,
    "running",
  );
  await act(async () => ui.result.current.loadPage(before));
  const input = count("spaces_query_work_consent_task_status").at(-1).args
    .input;
  assert.deepEqual(input.before, before);
  assert.equal(input.channelId, context.channelId);
  assert.equal(input.rootEventId, context.rootEventId);
  assert.equal(input.expectedScopeToken, identity.scopeToken);
  assert.equal(count("spaces_decide_work_consent").length, 0);
  assert.equal(count("spaces_select_work_consent_account").length, 0);
});

test("unavailable task status removes old progress while preserving owner consent cleanup", async () => {
  const { act, waitFor } = await import("@testing-library/react");
  let available = true;
  handler = (command) => {
    if (command === "spaces_query_work_consents")
      return query([{ ...record(), state: "approved", version: 2 }]);
    if (command === "spaces_query_work_consent_task_status")
      return available ? taskStatusResponse() : { state: "unavailable" };
    return normal(command);
  };
  const ui = await mount();
  await waitFor(() =>
    assert.equal(ui.result.current.snapshot?.statusPhase, "ready"),
  );
  available = false;
  await act(async () => ui.result.current.load());
  assert.equal(ui.result.current.phase, "ready");
  assert.equal(ui.result.current.snapshot.lookup.requests[0].state, "approved");
  assert.equal(ui.result.current.snapshot.statusPhase, "unavailable");
  assert.equal(ui.result.current.snapshot.taskStatusLookup, undefined);
});

test("a status lease that expires during transport is decoded as unconfirmed", async () => {
  const { waitFor } = await import("@testing-library/react");
  const response = taskStatusResponse({ observedAt: "2026-09-17T14:01:58Z" });
  response.lookup.statuses[0].leaseExpiresAt = "2026-09-17T14:01:59Z";
  handler = (command) =>
    command === "spaces_query_work_consent_task_status"
      ? response
      : normal(command);
  const ui = await mount();
  await waitFor(() =>
    assert.equal(ui.result.current.snapshot?.statusPhase, "ready"),
  );
  assert.equal(
    ui.result.current.snapshot.taskStatusLookup.statuses[0].state,
    "unconfirmed",
  );
  assert.equal(
    ui.result.current.snapshot.taskStatusLookup.statuses[0].leaseExpiresAt,
    undefined,
  );
});

for (const field of ["ownerId", "orgId", "workId"]) {
  test(`task status ${field} mismatch clears every private projection`, async () => {
    const { waitFor } = await import("@testing-library/react");
    handler = (command) =>
      command === "spaces_query_work_consent_task_status"
        ? taskStatusResponse({ [field]: "other_identity" })
        : normal(command);
    const ui = await mount();
    await waitFor(() => assert.equal(ui.result.current.phase, "access_lost"));
    assert.equal(ui.result.current.snapshot, null);
    assert.deepEqual(ui.result.current.pendingSelections, {});
  });
}

test("unexpected task metadata is unavailable while consent cleanup remains visible", async () => {
  const { waitFor } = await import("@testing-library/react");
  const response = taskStatusResponse();
  response.lookup.statuses[0].privateText = "must never enter status";
  handler = (command) =>
    command === "spaces_query_work_consent_task_status"
      ? response
      : normal(command);
  const ui = await mount();
  await waitFor(() =>
    assert.equal(ui.result.current.snapshot?.statusPhase, "unavailable"),
  );
  assert.equal(ui.result.current.snapshot.taskStatusLookup, undefined);
  assert.equal(ui.result.current.phase, "ready");
  assert.deepEqual(ui.result.current.snapshot.lookup.requests, [record()]);
});

test("status identity replacement clears all retained private projections", async () => {
  const { waitFor } = await import("@testing-library/react");
  handler = (command) =>
    command === "spaces_query_work_consent_task_status"
      ? { ...taskStatusResponse(), scopeToken: "other_scope" }
      : normal(command);
  const ui = await mount();
  await waitFor(() => assert.equal(ui.result.current.phase, "access_lost"));
  assert.equal(ui.result.current.snapshot, null);
  assert.deepEqual(ui.result.current.pendingSelections, {});
});

test("a monotonic stale intent version preserves exact frozen terms and bound cleanup", async () => {
  const stale = { ...intentRecord(), version: 2, state: "stale" };
  handler = (command) =>
    command === "spaces_read_work_consent_intent"
      ? intentOwner({
          intent: stale,
          consent: structuredClone(intentFixture.consent),
        })
      : selecting(command);
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  assert.equal(ui.result.current.phase, "ready");
  assert.deepEqual(
    ui.result.current.snapshot.intentOwners.intent_fixture.intent,
    stale,
  );
  assert.deepEqual(ui.result.current.snapshot.lookup.requests, [
    intentFixture.consent,
  ]);
  await act(async () =>
    ui.result.current.selectAccount(
      "intent_fixture",
      intentFixture.accounts[0],
    ),
  );
  assert.equal(count("spaces_select_work_consent_account").length, 0);
});

test("an excluded stale intent recovers an older native operation without changing its version", async () => {
  const operation = {
    operationId: "op_original_selection",
    expectedVersion: 1,
    intentDigest: intentFixture.intent.digest,
    accountId: intentFixture.accounts[0].accountId,
    accountVersion: intentFixture.accounts[0].accountVersion,
  };
  const stale = { ...intentRecord(), version: 2, state: "stale" };
  handler = (command) => {
    if (command === "spaces_query_work_consent_intents")
      return {
        ...intentQuery([]),
        pendingSelections: { intent_fixture: operation },
      };
    if (command === "spaces_read_work_consent_intent")
      return intentOwner({ intent: stale });
    if (command === "spaces_select_work_consent_account")
      return { state: "uncertain" };
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  assert.equal(
    ui.result.current.snapshot.intentOwners.intent_fixture.intent.state,
    "stale",
  );
  assert.deepEqual(
    ui.result.current.pendingSelections.intent_fixture,
    operation,
  );
  assert.equal(count("spaces_select_work_consent_account").length, 0);
  await act(async () => ui.result.current.retrySelection("intent_fixture"));
  const input = count("spaces_select_work_consent_account")[0].args.input;
  for (const [field, value] of Object.entries(operation))
    assert.equal(input[field], value);
});

test("recovery of another native pending intent does not reuse the previous intent's frozen terms", async () => {
  let recover = false;
  const other = {
    ...intentRecord(),
    id: "intent_other",
    digest: "f".repeat(64),
  };
  other.terms.task.requestId = "admission_other";
  other.terms.taskSummary = "A different bounded task";
  const operation = {
    operationId: "op_other",
    expectedVersion: 1,
    intentDigest: other.digest,
    accountId: intentFixture.accounts[0].accountId,
    accountVersion: intentFixture.accounts[0].accountVersion,
  };
  handler = (command) => {
    if (command === "spaces_query_work_consent_intents")
      return recover
        ? { ...intentQuery([]), pendingSelections: { intent_other: operation } }
        : intentQuery();
    if (command === "spaces_read_work_consent_intent")
      return intentOwner({ intent: recover ? other : intentRecord() });
    return selecting(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  recover = true;
  await act(async () => ui.result.current.load());
  assert.equal(ui.result.current.phase, "ready");
  assert.equal(ui.result.current.selectedIntentId, "intent_other");
  assert.deepEqual(Object.keys(ui.result.current.snapshot.intentOwners), [
    "intent_other",
  ]);
  assert.deepEqual(
    ui.result.current.snapshot.intentOwners.intent_other.intent,
    other,
  );
  assert.equal(
    count("spaces_read_work_consent_intent").at(-1).args.input.intentId,
    other.id,
  );
  assert.equal(count("spaces_select_work_consent_account").length, 0);
});

for (const outcome of ["confirmed", "conflict"]) {
  test(`${outcome} decision synchronizes its bound record before an unavailable refresh`, async () => {
    let decided = false;
    const approved = { ...record(), state: "approved", version: 2 };
    handler = (command) => {
      if (command === "spaces_query_work_consent_intents")
        return intentQuery(decided ? [] : [intentRecord()]);
      if (command === "spaces_read_work_consent_intent")
        return decided
          ? { state: "unavailable" }
          : intentOwner({ consent: record() });
      if (command === "spaces_decide_work_consent") {
        decided = true;
        return outcome === "conflict"
          ? { state: "conflict" }
          : {
              state: "confirmed",
              ...identity,
              result: { ...fixture, consent: approved },
            };
      }
      if (command === "spaces_read_work_consent")
        return { state: "ready", ...identity, consent: approved };
      return selecting(command);
    };
    const { act } = await import("@testing-library/react");
    const ui = await mount();
    await ready(ui);
    await act(async () =>
      ui.result.current.decide("consent_fixture", "approve"),
    );
    assert.deepEqual(ui.result.current.snapshot.lookup.requests, [approved]);
    assert.deepEqual(
      ui.result.current.snapshot.intentOwners.intent_fixture.consent,
      approved,
    );
    await act(async () => ui.result.current.load());
    assert.equal(ui.result.current.intentPhase, "unavailable");
    assert.deepEqual(ui.result.current.snapshot.lookup.requests, [approved]);
    assert.deepEqual(
      ui.result.current.snapshot.intentOwners.intent_fixture.consent,
      approved,
    );
    assert.deepEqual(ui.result.current.snapshot.unconfirmedConsents, [
      approved.id,
    ]);
  });
}

test("a late status response cannot overwrite a revocation made during refresh", async () => {
  let refresh = false,
    finish;
  handler = (command) => {
    if (command === "spaces_query_work_consents")
      return query([{ ...record(), state: "approved", version: 2 }]);
    if (command === "spaces_query_work_consent_task_status")
      return refresh
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : taskStatusResponse();
    if (command === "spaces_decide_work_consent")
      return { state: "confirmed", ...identity, result: fixture };
    return normal(command);
  };
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await waitFor(() =>
    assert.equal(ui.result.current.snapshot?.statusPhase, "ready"),
  );
  refresh = true;
  await act(async () => {
    void ui.result.current.load();
  });
  await waitFor(() => assert.equal(typeof finish, "function"));
  await act(async () => ui.result.current.decide("consent_fixture", "revoke"));
  await act(async () => finish(taskStatusResponse()));
  assert.equal(ui.result.current.snapshot.lookup.requests[0].state, "revoked");
  assert.equal(
    ui.result.current.snapshot.lookup.requests[0].version,
    fixture.consent.version,
  );
  assert.equal(count("spaces_decide_work_consent").length, 1);
});

test("a fresh ordinary consent page preserves revoke when its previously bound intent becomes unavailable", async () => {
  let intentAvailable = true;
  const approved = { ...record(), state: "approved", version: 2 };
  handler = (command) => {
    if (command === "spaces_query_work_consents") return query([approved]);
    if (command === "spaces_query_work_consent_intents")
      return intentAvailable ? intentQuery() : { state: "unavailable" };
    if (command === "spaces_read_work_consent_intent")
      return intentOwner({ consent: approved });
    if (command === "spaces_decide_work_consent")
      return { state: "confirmed", ...identity, result: fixture };
    return normal(command);
  };
  const { act } = await import("@testing-library/react");
  const ui = await mount();
  await ready(ui);
  intentAvailable = false;
  await act(async () => ui.result.current.load());
  assert.equal(ui.result.current.intentPhase, "unavailable");
  assert.deepEqual(ui.result.current.snapshot.lookup.requests, [approved]);
  assert.ok(
    !ui.result.current.snapshot.unconfirmedConsents?.includes(approved.id),
  );
  await act(async () => ui.result.current.decide(approved.id, "revoke"));
  assert.equal(count("spaces_decide_work_consent").length, 1);
  assert.equal(
    count("spaces_decide_work_consent")[0].args.input.sourceIntentId,
    undefined,
  );
});

for (const [state, version] of [
  ["approved", 2],
  ["expired", 1],
]) {
  test(`the final ${state} owner read retires an obsolete approval operation`, async () => {
    const old = {
      operationId: "op_unconfirmed_approval",
      expectedVersion: 1,
      termsDigest: fixture.consent.termsDigest,
      decision: "approve",
    };
    const current = { ...record(), state, version };
    handler = (command) => {
      if (command === "spaces_query_work_consents")
        return { ...query(), pendingDecisions: { consent_fixture: old } };
      if (command === "spaces_read_work_consent_intent")
        return { ...intentOwner({ consent: current }), pendingDecisions: {} };
      if (command === "spaces_decide_work_consent")
        return { state: "uncertain" };
      return selecting(command);
    };
    const { act } = await import("@testing-library/react");
    const ui = await mount();
    await ready(ui);
    assert.deepEqual(ui.result.current.pendingDecisions, {});
    assert.equal(ui.result.current.snapshot.lookup.requests[0].state, state);
    await act(async () =>
      ui.result.current.decide("consent_fixture", "revoke"),
    );
    const input = count("spaces_decide_work_consent")[0].args.input;
    assert.equal(input.decision, "revoke");
    assert.equal(input.expectedVersion, version);
    assert.notEqual(input.operationId, old.operationId);
  });
}

test("a newer revoked task status blocks decisions until the exact consent is refreshed", async () => {
  let refreshed = false;
  const approved = { ...record(), state: "approved", version: 2 };
  const revoked = { ...approved, state: "revoked", version: 3 };
  const status = taskStatusResponse({
    statuses: [
      {
        consentId: approved.id,
        consentVersion: 3,
        termsDigest: approved.termsDigest,
        state: "revoked",
        revision: 0,
      },
    ],
  });
  handler = (command) => {
    if (command === "spaces_query_work_consents")
      return query([refreshed ? revoked : approved]);
    if (command === "spaces_query_work_consent_task_status") return status;
    return normal(command);
  };
  const { act, waitFor } = await import("@testing-library/react");
  const ui = await mount();
  await waitFor(() =>
    assert.equal(ui.result.current.snapshot?.statusPhase, "ready"),
  );
  assert.deepEqual(ui.result.current.snapshot.unconfirmedConsents, [
    approved.id,
  ]);
  await act(async () => ui.result.current.decide(approved.id, "revoke"));
  assert.equal(count("spaces_decide_work_consent").length, 0);
  refreshed = true;
  await act(async () => ui.result.current.load());
  assert.equal(ui.result.current.snapshot.lookup.requests[0].state, "revoked");
  assert.ok(
    !ui.result.current.snapshot.unconfirmedConsents?.includes(revoked.id),
  );
});
