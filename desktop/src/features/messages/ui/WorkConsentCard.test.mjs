import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";
import { JSDOM } from "jsdom";
import { workConsentView } from "../../../../tests/fixtures/workConsentView.ts";

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

async function mount(view = workConsentView()) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { WorkConsentCard } = await import("./WorkConsentCard.tsx");
  const decisions = [];
  let refreshes = 0;
  let connections = 0;
  const props = {
    view,
    onDecision: (decision) => decisions.push(decision),
    onRefresh: () => refreshes++,
    onOpenConnections: () => connections++,
  };
  const ui = render(createElement(WorkConsentCard, props));
  return {
    ...ui,
    decisions,
    refreshes: () => refreshes,
    connections: () => connections,
    show: (next) =>
      ui.rerender(createElement(WorkConsentCard, { ...props, view: next })),
  };
}

test("renders the exact private account, actions, meeting window, sharing policy and finite expiry", async () => {
  const { screen } = await import("@testing-library/react");
  const ui = await mount();
  assert.ok(screen.getByRole("region", { name: "Review personal access" }));
  assert.ok(screen.getByText("alex@example.test"));
  assert.ok(screen.getByText("Read meeting notes and transcripts"));
  assert.ok(screen.getByText("Your two latest morning meetings"));
  assert.ok(
    screen.getByText("September 17, 2026 · 8:00–12:00 · America/New_York"),
  );
  assert.ok(
    screen.getByText(
      "Results stay private to you. Sharing a draft needs your separate review.",
    ),
  );
  const expiry = screen.getByText("September 17, 2026 at 1:30 PM EDT");
  assert.equal(expiry.getAttribute("datetime"), "2026-09-17T17:30:00Z");
  assert.doesNotMatch(
    ui.container.textContent,
    /only (?:participants|members)|running|forever|Gateway|digest/i,
  );
  assert.equal(
    ui.container.querySelectorAll("input, textarea, [contenteditable]").length,
    0,
  );
});

test("decisions invoke only the offered action and do not manufacture approval state", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  fireEvent.click(screen.getByRole("button", { name: "Authorize" }));
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  assert.deepEqual(ui.decisions, ["approve", "decline"]);
  assert.ok(screen.getByRole("heading", { name: "Review personal access" }));
  assert.equal(screen.queryByText("Access approved"), null);
});

test("approved private task status is separate from approval and adds no execution or sharing controls", async () => {
  const { screen } = await import("@testing-library/react");
  const ui = await mount(
    workConsentView({
      consentState: "approved",
      availableDecisions: ["revoke"],
      taskStatusLabel: "Working privately",
    }),
  );
  assert.ok(screen.getByRole("heading", { name: "Access approved" }));
  assert.equal(
    screen.getByTestId("work-consent-task-status").textContent,
    "Working privately",
  );
  ui.show(
    workConsentView({
      consentState: "approved",
      availableDecisions: ["revoke"],
      taskStatusLabel: "Ready to review",
    }),
  );
  assert.equal(
    screen.getByTestId("work-consent-task-status").textContent,
    "Ready to review",
  );
  assert.equal(
    screen.queryByRole("button", { name: /share|publish|continue/i }),
    null,
  );
  assert.deepEqual(ui.decisions, []);
});

test("non-approved consent overrides any retained private execution label", async () => {
  const { screen } = await import("@testing-library/react");
  const ui = await mount(
    workConsentView({
      consentState: "approved",
      taskStatusLabel: "Working privately",
    }),
  );
  for (const consentState of [
    "pending",
    "declined",
    "revoked",
    "expired",
    "stale",
  ]) {
    ui.show(
      workConsentView({ consentState, taskStatusLabel: "Working privately" }),
    );
    assert.equal(screen.queryByTestId("work-consent-task-status"), null);
    assert.equal(screen.queryByText("Working privately"), null);
  }
});

test("uncertain or lost owner access cannot retain a confirmed execution label", async () => {
  const { screen } = await import("@testing-library/react");
  const ui = await mount(
    workConsentView({
      consentState: "approved",
      phase: "uncertain",
      taskStatusLabel: "Working privately",
    }),
  );
  assert.equal(
    screen.getByTestId("work-consent-task-status").textContent,
    "Status unconfirmed",
  );
  ui.show(
    workConsentView({
      consentState: "approved",
      phase: "access-lost",
      taskStatusLabel: "Working privately",
    }),
  );
  assert.equal(screen.queryByTestId("work-consent-task-status"), null);
});

test("exact access limits use a native disclosure and clear with lost owner access", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const view = workConsentView();
  view.terms.limits = [
    "At most 2 eligible meetings",
    "At most 128 provider requests",
  ];
  const ui = await mount(view);
  const summary = screen.getByText("Access limits");
  const details = summary.closest("details");
  assert.equal(details.open, false);
  fireEvent.click(summary);
  assert.equal(details.open, true);
  assert.ok(screen.getByText("At most 2 eligible meetings"));
  assert.ok(screen.getByText("At most 128 provider requests"));
  ui.show({ ...view, phase: "access-lost" });
  assert.equal(screen.queryByText("Access limits"), null);
  assert.equal(screen.queryByText("At most 128 provider requests"), null);
});

test("pending write disables every action while preserving the reviewed terms", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount(workConsentView({ busyDecision: "approve" }));
  const button = screen.getByRole("button", { name: "Saving approval…" });
  assert.equal(button.disabled, true);
  assert.equal(screen.getByRole("button", { name: "Decline" }).disabled, true);
  assert.equal(
    screen.getByRole("button", { name: "Refresh personal access" }).disabled,
    true,
  );
  fireEvent.click(button);
  assert.deepEqual(ui.decisions, []);
  assert.ok(screen.getByText("alex@example.test"));
});

test("an uncertain result offers a read and cannot replay an approval", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount(workConsentView({ phase: "uncertain" }));
  assert.equal(screen.queryByRole("button", { name: "Authorize" }), null);
  assert.equal(screen.queryByRole("button", { name: "Decline" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Check access status" }));
  assert.equal(ui.refreshes(), 1);
  assert.deepEqual(ui.decisions, []);
  assert.ok(
    screen.getByText(
      "We couldn’t confirm the result. Check status before trying again.",
    ),
  );
});

for (const phase of ["loading", "access-lost", "unavailable", "no-account"]) {
  test(`${phase} removes all retained private account and request terms`, async () => {
    const { screen } = await import("@testing-library/react");
    const ui = await mount();
    ui.show(workConsentView({ phase }));
    assert.equal(screen.queryByText("alex@example.test"), null);
    assert.equal(screen.queryByText("Granola"), null);
    assert.equal(
      screen.queryByText("Read meeting notes and transcripts"),
      null,
    );
    assert.equal(screen.queryByText("September 17, 2026 at 1:30 PM EDT"), null);
    assert.equal(screen.queryByRole("button", { name: "Authorize" }), null);
    assert.equal(screen.queryByRole("button", { name: "Decline" }), null);
  });
}

test("missing account opens the existing Connections path without a chat action", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount(workConsentView({ phase: "no-account" }));
  fireEvent.click(screen.getByRole("button", { name: "Open Connections" }));
  assert.equal(ui.connections(), 1);
  assert.deepEqual(ui.decisions, []);
});

test("authoritative approval offers Stop access on expansion without claiming task execution", async () => {
  const { fireEvent, screen, waitFor } = await import("@testing-library/react");
  const ui = await mount(
    workConsentView({
      consentState: "approved",
      availableDecisions: ["revoke"],
    }),
  );
  assert.ok(screen.getByRole("heading", { name: "Access approved" }));
  assert.doesNotMatch(
    ui.container.textContent,
    /running|completed|working on|task (?:started|resumed)/i,
  );
  assert.equal(screen.queryByRole("button", { name: "Stop access" }), null);
  fireEvent.click(ui.container.querySelector("summary"));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Stop access" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop access" }));
  assert.deepEqual(ui.decisions, ["revoke"]);
});

test("confirmed decision restores focus to status when the activated control disappears", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  const allow = screen.getByRole("button", { name: "Authorize" });
  allow.focus();
  fireEvent.click(allow);
  ui.show(workConsentView({ busyDecision: "approve" }));
  ui.show(
    workConsentView({
      consentState: "approved",
      availableDecisions: ["revoke"],
    }),
  );
  assert.equal(
    document.activeElement,
    screen.getByRole("heading", { name: "Access approved" }),
  );
});

test("confirmed decision preserves focus moved to the existing composer during I/O", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  const allow = screen.getByRole("button", { name: "Authorize" });
  allow.focus();
  fireEvent.click(allow);
  ui.show(workConsentView({ busyDecision: "approve" }));
  const composer = document.createElement("textarea");
  document.body.append(composer);
  composer.focus();
  ui.show(
    workConsentView({
      consentState: "approved",
      availableDecisions: ["revoke"],
    }),
  );
  assert.equal(document.activeElement, composer);
  composer.remove();
});

for (const [consentState, heading] of [
  ["declined", "Access declined"],
  ["revoked", "Access stopped"],
  ["expired", "Access expired"],
  ["stale", "Access is no longer valid"],
]) {
  test(`current ${consentState} record cannot offer an approval, even with a retained old action`, async () => {
    const { screen } = await import("@testing-library/react");
    await mount(
      workConsentView({ consentState, availableDecisions: ["approve"] }),
    );
    assert.ok(screen.getByRole("heading", { name: heading }));
    assert.equal(screen.queryByRole("button", { name: "Authorize" }), null);
  });
}

test("an offered decline or revocation stays available for changed terms", async () => {
  const { fireEvent, screen, waitFor } = await import("@testing-library/react");
  const ui = await mount(
    workConsentView({
      consentState: "stale",
      availableDecisions: ["decline", "revoke"],
    }),
  );
  fireEvent.click(ui.container.querySelector("summary"));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Decline" })));
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  fireEvent.click(ui.container.querySelector("summary"));
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Stop access" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop access" }));
  assert.deepEqual(ui.decisions, ["decline", "revoke"]);
});

test("uncertain refresh distinguishes historical approval from current authority", async () => {
  const { screen } = await import("@testing-library/react");
  await mount(workConsentView({ phase: "uncertain", consentState: "approved", availableDecisions: ["approve", "revoke"] }));
  assert.ok(screen.getByText("An approval was previously saved. Current access and task progress could not be confirmed."));
  assert.ok(screen.getByRole("heading", { name: "Current access unconfirmed" }));
  assert.ok(screen.getByText("Previously approved reads"));
  assert.equal(screen.queryByRole("heading", { name: "Access approved" }), null);
  assert.equal(screen.queryByText("Symi can"), null);
  assert.equal(screen.queryByText(/Your approval is saved for this task/), null);
  assert.equal(screen.queryByRole("button", { name: "Authorize" }), null);
});

test("definitively missing execution access preserves Decline without claiming a saved approval", async () => {
  const { screen, fireEvent } = await import("@testing-library/react");
  const ui = await mount(workConsentView({ executionUnavailable: true, availableDecisions: ["approve", "decline"] }));
  assert.ok(screen.getByRole("heading", { name: "Symi is not ready to use this account" }));
  assert.ok(screen.getByText(/No approval was saved/));
  assert.equal(screen.queryByRole("button", { name: "Authorize" }), null);
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  assert.deepEqual(ui.decisions, ["decline"]);
});
