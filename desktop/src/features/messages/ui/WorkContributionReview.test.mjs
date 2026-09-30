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
before(() =>
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    IS_REACT_ACT_ENVIRONMENT: true,
  }),
);
afterEach(async () => (await import("@testing-library/react")).cleanup());
after(() => dom.window.close());
async function mount(overrides = {}) {
  const { createElement } = await import("react");
  const { render } = await import("@testing-library/react");
  const { WorkContributionReview } = await import(
    "./WorkContributionReview.tsx"
  );
  const decisions = [];
  let fetches = 0,
    refreshes = 0;
  const props = {
    record: structuredClone(fixture.preview.release),
    preview: structuredClone(fixture.preview),
    phase: "ready",
    onPreview: () => fetches++,
    onDecision: (d) => decisions.push(d),
    onRefresh: () => refreshes++,
    ...overrides,
  };
  const ui = render(createElement(WorkContributionReview, props));
  return {
    ...ui,
    decisions,
    fetches: () => fetches,
    refreshes: () => refreshes,
    show: (next) =>
      ui.rerender(createElement(WorkContributionReview, { ...props, ...next })),
  };
}
test("complete selected text and URLs render as inert text without media or truncation", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const preview = structuredClone(fixture.preview);
  preview.markdown =
    "# Proposal\n![private](https://private.example.test/beacon)\n[Source](https://private.example.test/note?token=synthetic)\n<script>PRIVATE_SENTINEL</script>\n" +
    "Complete source context. ".repeat(300) +
    "EXACT_FINAL_SUFFIX";
  const ui = await mount({ preview });
  fireEvent.click(
    screen.getByRole("button", { name: "Show selected message" }),
  );
  assert.equal(
    screen.getByTestId("work-release-preview").textContent,
    preview.markdown,
  );
  assert.equal(
    ui.container.querySelectorAll(
      "a,img,iframe,video,audio,script,input,textarea,[contenteditable]",
    ).length,
    0,
  );
  assert.equal(screen.getByTestId("work-release-preview").style.maxHeight, "");
  assert.equal(
    screen.getByRole("button", { name: "Share selected contribution" })
      .disabled,
    true,
  );
  assert.match(
    ui.container.textContent,
    /silent members and directly admitted Agents/,
  );
  assert.match(ui.container.textContent, /cannot retract copies/);
});
test("review fetch is separate from deliberate sharing and disabled source cannot approve", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount({ preview: undefined });
  fireEvent.click(screen.getByRole("button", { name: "Review draft" }));
  assert.equal(ui.fetches(), 1);
  assert.deepEqual(ui.decisions, []);
  fireEvent.click(
    screen.getByRole("button", { name: "Share selected contribution" }),
  );
  assert.deepEqual(ui.decisions, []);
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  assert.deepEqual(ui.decisions, ["decline"]);
});
test("changed candidate version and access loss remove private bytes and hidden terms", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Show selected message" }),
  );
  assert.ok(screen.queryByTestId("work-release-preview"));
  ui.show({ record: { ...fixture.preview.release, version: 2 } });
  assert.equal(screen.queryByTestId("work-release-preview"), null);
  ui.show({ phase: "access_lost" });
  assert.equal(screen.queryByText("Review details"), null);
  assert.equal(screen.queryByTestId("work-release-preview"), null);
  assert.doesNotMatch(
    ui.container.textContent,
    /candidate_|human_owner|Synthetic owner-reviewed contribution/,
  );
});
test("uncertain publication offers status and never claims delivery or repeats decision", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount({ phase: "uncertain" });
  fireEvent.click(
    screen.getByRole("button", { name: "Share selected contribution" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  assert.deepEqual(ui.decisions, []);
  fireEvent.click(screen.getByRole("button", { name: "Check status" }));
  assert.equal(ui.refreshes(), 1);
  assert.match(ui.container.textContent, /outcome is unknown/);
  assert.equal(
    screen.queryByRole("heading", { name: "Contribution shared" }),
    null,
  );
});
test("benign collapse preserves exact private text; current expiry hides it", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Show selected message" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Hide selected message" }),
  );
  assert.equal(screen.queryByTestId("work-release-preview"), null);
  fireEvent.click(
    screen.getByRole("button", { name: "Show selected message" }),
  );
  assert.equal(
    screen.getByTestId("work-release-preview").textContent,
    fixture.preview.markdown,
  );
  ui.show({
    record: {
      ...fixture.preview.release,
      terms: {
        ...fixture.preview.release.terms,
        expiresAt: "2020-01-01T00:00:00Z",
      },
    },
  });
  assert.equal(screen.queryByTestId("work-release-preview"), null);
  assert.equal(
    screen.queryByRole("button", { name: "Share selected contribution" }),
    null,
  );
});
test("decision completion restores card focus without stealing composer focus", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const ui = await mount();
  const decline = screen.getByRole("button", { name: "Decline" });
  decline.focus();
  fireEvent.click(decline);
  ui.show({
    record: { ...fixture.preview.release, state: "declined", version: 2 },
  });
  assert.equal(
    document.activeElement,
    screen.getByRole("heading", { name: "Contribution declined" }),
  );
  ui.show({ record: fixture.preview.release });
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  const composer = document.createElement("textarea");
  composer.value = "Keep my thread draft";
  document.body.append(composer);
  composer.focus();
  ui.show({
    record: { ...fixture.preview.release, state: "declined", version: 2 },
  });
  assert.equal(document.activeElement, composer);
  assert.equal(composer.value, "Keep my thread draft");
  composer.remove();
});
test("delegated Agent policy is explicit and historical delivered state has no new share action", async () => {
  const { screen } = await import("@testing-library/react");
  const record = structuredClone(fixture.preview.release);
  record.terms.disclosure.readers =
    "admitted-realm-members-and-owner-delegated-agents";
  record.state = "delivered";
  const ui = await mount({ record });
  assert.match(ui.container.textContent, /applicable owner-delegated Agents/);
  assert.ok(screen.getByRole("heading", { name: "Contribution shared" }));
  assert.equal(
    screen.queryByRole("button", { name: "Share selected contribution" }),
    null,
  );
});

test("hidden direction controls cannot become a visual review or sharing approval", async () => {
  const { fireEvent, screen } = await import("@testing-library/react");
  const preview = structuredClone(fixture.preview);
  preview.release.publicationEnabled = true;
  preview.markdown = "Source: https://synthetic.example/\u202edeceptive";
  const ui = await mount({ record: preview.release, preview });
  assert.match(
    screen.getByRole("alert").textContent,
    /Sharing is unavailable for this version/,
  );
  assert.equal(screen.queryByTestId("work-release-preview"), null);
  assert.equal(
    screen.queryByRole("button", { name: "Show selected message" }),
    null,
  );
  assert.equal(
    screen.getByRole("button", { name: "Share selected contribution" })
      .disabled,
    true,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Share selected contribution" }),
  );
  assert.deepEqual(ui.decisions, []);
  assert.equal(
    preview.markdown,
    "Source: https://synthetic.example/\u202edeceptive",
  );
  fireEvent.click(screen.getByRole("button", { name: "Decline" }));
  assert.deepEqual(ui.decisions, ["decline"]);
});
