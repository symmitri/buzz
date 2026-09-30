import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
before(() => Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
}));
afterEach(async () => (await import("@testing-library/react")).cleanup());
after(() => dom.window.close());

test("receipt retains exact acknowledgment time across slot removal, and clears on identity replacement", async () => {
  const { createElement: h, useRef } = await import("react");
  const { render, screen } = await import("@testing-library/react");
  const { WorkConsentPlacement } = await import("./WorkConsentPlacement.tsx");
  const ack = { id: "a".repeat(64), pubkey: "b".repeat(64), createdAt: 200, tags: [["client", "request"]] };
  function Scene({ visible = true, scope = "owner-one", available = true }) {
    const container = useRef(null);
    const correlations = useRef(new Map());
    return h("div", { ref: container },
      h("div", { "data-work-consent-fallback": "" }),
      visible && h("div", { "data-work-consent-anchor": ack.id }),
      available && h(WorkConsentPlacement, { timeline: { container, messages: visible ? [ack] : [], anchors: correlations.current }, scopeKey: scope,
        requestId: "request", agentPubkey: ack.pubkey, requestedAt: new Date(100_000).toISOString() },
      at => h("time", { "data-testid": "receipt", dateTime: at }, at)));
  }
  const ui = render(h(Scene));
  const stamp = new Date(200_000).toISOString();
  assert.equal(screen.getByTestId("receipt").dateTime, stamp);
  assert.equal(screen.getByTestId("receipt").parentElement.dataset.workConsentAnchor, ack.id);
  ui.rerender(h(Scene, { visible: false }));
  assert.equal(screen.getByTestId("receipt").dateTime, stamp);
  assert.ok(screen.getByTestId("receipt").parentElement.hasAttribute("data-work-consent-fallback"));
  ui.rerender(h(Scene, { visible: false, available: false }));
  assert.equal(screen.queryByTestId("receipt"), null, "unavailable snapshot redacts controls");
  ui.rerender(h(Scene, { visible: false }));
  assert.equal(screen.getByTestId("receipt").dateTime, stamp, "same-scope recovery retains the original acknowledgment");
  ui.rerender(h(Scene));
  assert.equal(screen.getByTestId("receipt").dateTime, stamp);
  assert.equal(screen.getByTestId("receipt").parentElement.dataset.workConsentAnchor, ack.id);
  ui.rerender(h(Scene, { visible: false, scope: "owner-two" }));
  assert.equal(screen.getByTestId("receipt").dateTime, new Date(100_000).toISOString());
  assert.equal(screen.queryAllByTestId("receipt").length, 1);
});

test("a valid no-checkpoint status visibly reports uncertainty without inventing a timestamp", async () => {
  const { createElement: h } = await import("react");
  const { render, screen } = await import("@testing-library/react");
  const { WorkConsentProgress } = await import("./WorkConsentProgress.tsx");
  const ui = render(h(WorkConsentProgress, {
    status: { consentId: "consent", consentVersion: 2, termsDigest: "a".repeat(64), state: "unconfirmed", revision: 0 },
    record: { id: "consent" }, snapshot: {},
  }));
  assert.match(screen.getByRole("status").textContent, /can’t confirm the latest progress/);
  assert.equal(ui.container.querySelector("time"), null);
  assert.equal(ui.container.querySelector("button"), null);
});
