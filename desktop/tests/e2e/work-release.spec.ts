import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import fixture from "../fixtures/work-release.json" with { type: "json" };
import consentFixture from "../fixtures/work-consent.json" with {
  type: "json",
};
import { encodeBuzzReleasePayload } from "../../../.spaces-axis-contracts/buzz-release-contract.ts";
import { encodeBuzzReviewedDisclosureMaterial } from "../../../.spaces-axis-contracts/buzz-reviewed-publication-contract.ts";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const SHOTS =
  process.env.WORK_RELEASE_SCREENSHOT_DIR ?? "test-results/work-release";
const CHANNEL = "engineering";
const CHANNEL_ID = "1c7e1c02-87bb-5e88-b2da-5a7a9432d0c9";
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function sample(markdown?: string) {
  const selected = structuredClone(fixture.preview);
  selected.markdown =
    markdown ??
    "1. Improve the first-use setup checklist.\nWhy: both synthetic morning meetings identified the same onboarding gap.\nExisting work: continue the tracked onboarding issue; avoid a duplicate proposal.\nSource: https://meetings.synthetic.example/morning-a#notes\n\n2. Add a clear owner for release validation.\nNew proposal: define the acceptance evidence before implementation.\nSource: https://meetings.synthetic.example/morning-b#notes\n\nRoadmap checks used authorized company-service reads. No issues have been created.\nEXACT SELECTED MESSAGE ENDS HERE";
  const terms = selected.release.terms;
  terms.candidate.contentDigest = hash(selected.markdown);
  terms.candidate.byteLength = Buffer.byteLength(selected.markdown);
  terms.destination.channelId = CHANNEL_ID;
  terms.disclosure.channelId = CHANNEL_ID;
  terms.publicationMaterial.channel_id = CHANNEL_ID;
  terms.payloadTags[0][1] = CHANNEL_ID;
  terms.publicationMaterialDigest = hash(
    encodeBuzzReviewedDisclosureMaterial(terms.publicationMaterial),
  );
  terms.payloadDigest = hash(
    encodeBuzzReleasePayload({
      agentPubkey: terms.agentPubkey,
      content: selected.markdown,
      tags: terms.payloadTags,
    }),
  );
  selected.candidate = structuredClone(terms.candidate);
  // The shared fixture uses canonical property order. Production parsers check
  // this independently before any selected text reaches the real review card.
  selected.release.termsDigest = hash(JSON.stringify(terms));
  return selected;
}
type TestState = {
  calls: Array<{ command: string; input: Record<string, unknown> }>;
  preview: ReturnType<typeof sample>;
  pending: Record<string, unknown> | null;
  uncertain: boolean;
  denied: boolean;
  cached: boolean;
};
type FixtureWindow = Window & {
  __WORK_RELEASE_TEST__: TestState;
  __TAURI_INTERNALS__: {
    invoke: (command: string, args?: unknown) => Promise<unknown>;
  };
};
async function prepare(
  page: Page,
  theme: "light" | "dark",
  combined = false,
  markdown?: string,
) {
  await page.clock.setFixedTime(new Date("2027-01-15T08:05:00Z"));
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.addInitScript((mode) => {
    localStorage.setItem(
      "buzz-theme",
      mode === "dark" ? "symmitri-dark" : "symmitri",
    );
    localStorage.setItem("buzz-follow-system", "false");
    localStorage.setItem("buzz.channels.threadViewMode", "split");
  }, theme);
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("open-settings").waitFor();
  const selected = sample(markdown);
  selected.release.publicationEnabled = combined;
  const consent = structuredClone(consentFixture.consent);
  consent.id = selected.candidate.execution.consentId;
  consent.version = selected.candidate.execution.consentVersion;
  consent.state = "approved";
  consent.termsDigest = selected.candidate.execution.termsDigest;
  consent.createdAt = "2027-01-15T08:00:00Z";
  Object.assign(consent.terms, {
    orgId: selected.release.terms.orgId,
    grantorId: selected.release.terms.ownerId,
    applicationId: selected.release.terms.applicationId,
    workloadIdentityId: selected.release.terms.workloadIdentityId,
    task: selected.candidate.task,
    accountId: selected.release.terms.accountId,
    accountVersion: selected.release.terms.accountVersion,
    connectionId: selected.release.terms.connectionId,
    expiresAt: selected.release.terms.expiresAt,
  });
  consent.terms.outputAudience.ownerId = selected.release.terms.ownerId;
  consent.terms.scope.meetingStart = "2027-01-14T13:00:00Z";
  consent.terms.scope.meetingEnd = "2027-01-14T17:00:00Z";
  await page.evaluate(
    ({ selected, consent, combined }) => {
      const w = window as FixtureWindow;
      const original = w.__TAURI_INTERNALS__.invoke;
      const state: TestState = {
        calls: [],
        preview: selected,
        pending: null,
        uncertain: false,
        denied: false,
        cached: false,
      };
      w.__WORK_RELEASE_TEST__ = state;
      const identity = {
        scopeToken: "synthetic-owner-scope",
        principalId: "human_owner",
        organisationId: "org_synthetic",
      };
      w.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command === "send_message")
          state.calls.push({ command, input: args as Record<string, unknown> });
        if (command.includes("work_consent")) {
          if (!combined) return { state: "unsupported" };
          const input = (args as { input: Record<string, unknown> }).input;
          if (command === "spaces_cancel_work_consent") return null;
          if (command === "spaces_work_consent_context")
            return {
              state: "ready",
              context: {
                ...input,
                expectedRelayUrl: "wss://reviewed.synthetic.example",
              },
            };
          if (command === "spaces_query_work_consents")
            return {
              state: "ready",
              ...identity,
              displays: {
                [consent.id]: {
                  accountLabel: "owner@example.test",
                  agentLabel: "Symi",
                  initiatorLabel: "Original requester",
                },
              },
              lookup: {
                workId: "work_synthetic",
                requests: [consent],
                participants: [],
              },
            };
          if (command === "spaces_query_work_consent_intents")
            return {
              state: "ready",
              ...identity,
              lookup: { workId: "work_synthetic", intents: [] },
            };
          if (command === "spaces_query_work_consent_task_status")
            return {
              state: "ready",
              ...identity,
              lookup: {
                orgId: "org_synthetic",
                ownerId: "human_owner",
                workId: "work_synthetic",
                observedAt: "2027-01-15T08:05:00Z",
                statuses: [
                  {
                    consentId: consent.id,
                    consentVersion: consent.version,
                    termsDigest: consent.termsDigest,
                    state: "candidate_ready",
                    revision: 3,
                    updatedAt: "2027-01-15T08:05:00Z",
                  },
                ],
              },
            };
          throw Error(`Unexpected synthetic consent command ${command}`);
        }
        if (!command.includes("work_release")) return original(command, args);
        const input = (args as { input: Record<string, unknown> }).input;
        state.calls.push({ command, input });
        if (command === "spaces_cancel_work_release") return null;
        if (state.denied) return { state: "access_lost" };
        if (command === "spaces_work_release_context")
          return {
            state: "ready",
            context: {
              ...input,
              expectedRelayUrl: "wss://reviewed.synthetic.example",
            },
          };
        if (command === "spaces_query_work_releases")
          return {
            state: "ready",
            ...identity,
            lookup: {
              workId: "work_synthetic",
              releases: [state.preview.release],
              truncated: false,
            },
            previews: state.cached ? { release_synthetic: state.preview } : {},
            pendingDecisions: state.pending
              ? { release_synthetic: state.pending }
              : {},
          };
        if (command === "spaces_preview_work_release") {
          state.cached = true;
          return { state: "ready", ...identity, preview: state.preview };
        }
        if (command === "spaces_decide_work_release") {
          state.pending = {
            operationId: input.operationId,
            expectedVersion: input.expectedVersion,
            termsDigest: input.termsDigest,
            payloadDigest: input.payloadDigest,
            decision: input.decision,
          };
          if (state.uncertain) {
            state.uncertain = false;
            return { state: "uncertain" };
          }
          state.preview.release = {
            ...state.preview.release,
            version: state.preview.release.version + 1,
            state:
              input.decision === "approve"
                ? "approved"
                : input.decision === "decline"
                  ? "declined"
                  : "revoked",
          };
          state.cached = false;
          state.pending = null;
          return {
            state: "confirmed",
            ...identity,
            result: {
              release: state.preview.release,
              receipt: {
                receiptId: "receipt_synthetic",
                operationId: input.operationId,
                actorId: identity.principalId,
                releaseId: state.preview.release.id,
                termsDigest: input.termsDigest,
                payloadDigest: input.payloadDigest,
                version: state.preview.release.version,
                decision: input.decision,
                decidedAt: "2027-01-15T08:05:00Z",
              },
            },
          };
        }
        throw Error(`Unexpected release command ${command}`);
      };
    },
    { selected, consent, combined },
  );
  await page.getByTestId(`channel-${CHANNEL}`).click();
  await expect
    .poll(() =>
      page.evaluate(
        (name) =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: name,
          }) ?? false,
        CHANNEL,
      ),
    )
    .toBe(true);
  const rootId = await page.evaluate(
    ({ channel, root }) => {
      const event = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: channel,
        id: root,
        pubkey: "deadbeef".repeat(8),
        content:
          "Symi, read my latest two morning meetings and suggest useful starting work.",
      });
      if (!event) throw Error("Synthetic thread missing");
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: channel,
        parentEventId: event.id,
        content:
          "Your selected contribution will need a separate private review.",
      });
      return event.id;
    },
    { channel: CHANNEL, root: fixture.expected.origin.rootEventId },
  );
  await page.getByTestId(`reply-message-${rootId}`).click({ force: true });
  const panel = page.getByTestId("message-thread-panel");
  const card = panel.getByTestId("work-contribution-review");
  await expect(card).toBeVisible();
  const composer = panel.getByTestId("message-input");
  await composer.fill("Keep these proposals focused on useful starting work.");
  return { panel, card, composer };
}
for (const theme of ["light", "dark"] as const) {
  test(`${theme}: real release thread exact preview and preserved draft at wide and narrow widths`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1600 });
    const { panel, card, composer } = await prepare(page, theme);
    await card.getByRole("button", { name: "Review draft" }).click();
    const body = card.getByTestId("work-release-preview");
    await expect(body).toHaveText(sample().markdown);
    await expect(card.locator("a,img,iframe,video,audio")).toHaveCount(0);
    await expect(
      card.getByRole("button", { name: "Share selected contribution" }),
    ).toBeDisabled();
    await expect(card).toContainText(
      "silent members and directly admitted Agents",
    );
    await expect(card).toContainText("cannot retract copies");
    const hide = card.getByRole("button", { name: "Hide selected message" });
    await hide.focus();
    await page.keyboard.press("Enter");
    await expect(body).toHaveCount(0);
    await card.getByRole("button", { name: "Show selected message" }).click();
    await expect(body).toHaveText(sample().markdown);
    await card.scrollIntoViewIfNeeded();
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/${theme}-wide-native-release-preview.png`,
    });
    await panel
      .getByRole("button", { name: "Expand thread", exact: true })
      .click();
    await page.setViewportSize({ width: 600, height: 1400 });
    await expect(composer).toHaveText(
      "Keep these proposals focused on useful starting work.",
    );
    await card.getByRole("button", { name: "Show selected message" }).click();
    await expect(body).toHaveText(sample().markdown);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${SHOTS}/${theme}-narrow-native-release-preview.png`,
    });
    expect(
      await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    ).toBe(true);
    await page.evaluate(() => {
      (window as FixtureWindow).__WORK_RELEASE_TEST__.uncertain = true;
    });
    const decline = card.getByRole("button", { name: "Decline" });
    await decline.focus();
    await page.keyboard.press("Enter");
    await expect(card).toContainText("outcome is unknown");
    await expect(card.getByRole("button", { name: "Decline" })).toBeDisabled();
    await card.getByRole("button", { name: "Check status" }).click();
    await expect(card.getByRole("button", { name: "Decline" })).toBeEnabled();
    expect(
      await page.evaluate(
        () =>
          (window as FixtureWindow).__WORK_RELEASE_TEST__.calls.filter(
            (c) => c.command === "spaces_decide_work_release",
          ).length,
      ),
    ).toBe(1);
    await card.getByRole("button", { name: "Decline" }).click();
    await expect(
      card.getByRole("heading", { name: "Contribution declined" }),
    ).toBeFocused();
    await expect(body).toHaveCount(0);
    await expect(composer).toHaveText(
      "Keep these proposals focused on useful starting work.",
    );
    const posts = await page.evaluate(() =>
      (window as FixtureWindow).__WORK_RELEASE_TEST__.calls
        .filter((c) => c.command === "spaces_decide_work_release")
        .map((c) => c.input),
    );
    expect(posts).toHaveLength(2);
    expect(posts[0].operationId).toBe(posts[1].operationId);
    expect(posts[0].payloadDigest).toBe(posts[1].payloadDigest);
  });
}
test("native identity loss clears selected bytes and private review metadata", async ({
  page,
}) => {
  const { card } = await prepare(page, "light");
  await card.getByRole("button", { name: "Review draft" }).click();
  await expect(card.getByTestId("work-release-preview")).toBeVisible();
  await page.evaluate(() => {
    (window as FixtureWindow).__WORK_RELEASE_TEST__.denied = true;
    return window.__BUZZ_E2E_EMIT_TAURI_EVENT__?.(
      "spaces-connections-invalidated",
      null,
    );
  });
  await expect(page.getByTestId("work-release-preview")).toHaveCount(0);
  await expect(page.getByTestId("work-contribution-review")).toHaveCount(0);
  await expect(
    page.getByText(
      "Private contribution review is unavailable. Refresh to check your current access.",
    ),
  ).toBeVisible();
});

test("combined ready-to-review journey discovers exact draft and records a separate deliberate Share", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  const { panel, card, composer } = await prepare(page, "light", true);
  await expect(panel.getByTestId("work-consent-task-status")).toHaveText(
    "Your draft is ready to review",
  );
  const review = card.getByRole("button", { name: "Review draft" });
  await expect(review).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Share selected contribution" }),
  ).toBeDisabled();
  await review.focus();
  await expect(review).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("work-release-preview")).toHaveText(
    sample().markdown,
  );
  await expect(
    card.getByRole("button", { name: "Share selected contribution" }),
  ).toBeEnabled();
  await waitForAnimations(page);
  await page.screenshot({
    path: `${SHOTS}/light-combined-native-ready-and-release-preview.png`,
  });
  const share = card.getByRole("button", {
    name: "Share selected contribution",
  });
  await share.focus();
  await page.keyboard.press("Enter");
  await expect(
    card.getByRole("heading", { name: "Sharing decision saved" }),
  ).toBeFocused();
  await expect(card).toContainText("Delivery has not been confirmed");
  await expect(composer).toHaveText(
    "Keep these proposals focused on useful starting work.",
  );
  const posts = await page.evaluate(() =>
    (window as FixtureWindow).__WORK_RELEASE_TEST__.calls.filter(
      (c) => c.command === "spaces_decide_work_release",
    ),
  );
  expect(posts).toHaveLength(1);
  expect(
    await page.evaluate(() =>
      (window as FixtureWindow).__WORK_RELEASE_TEST__.calls.filter(
        (c) => c.command === "send_message",
      ),
    ),
  ).toHaveLength(0);
  expect(posts[0].input.decision).toBe("approve");
  expect(posts[0].input.payloadDigest).toBe(
    sample().release.terms.payloadDigest,
  );
  expect(posts[0].input.rootEventId).toBe(fixture.expected.origin.rootEventId);
});

test("hidden direction controls block exact visual review and sharing without rewriting the candidate", async ({
  page,
}) => {
  const text = "Source: https://synthetic.example/\u202edeceptive";
  const { card, composer } = await prepare(page, "light", true, text);
  await card.getByRole("button", { name: "Review draft" }).click();
  await expect(card.getByRole("alert")).toContainText(
    "Sharing is unavailable for this version",
  );
  await expect(card.getByTestId("work-release-preview")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Share selected contribution" }),
  ).toBeDisabled();
  await expect(composer).toHaveText(
    "Keep these proposals focused on useful starting work.",
  );
  expect(
    await page.evaluate(
      () => (window as FixtureWindow).__WORK_RELEASE_TEST__.preview.markdown,
    ),
  ).toBe(text);
  expect(
    await page.evaluate(() =>
      (window as FixtureWindow).__WORK_RELEASE_TEST__.calls.filter(
        (c) =>
          c.command === "spaces_decide_work_release" ||
          c.command === "send_message",
      ),
    ),
  ).toHaveLength(0);
});
