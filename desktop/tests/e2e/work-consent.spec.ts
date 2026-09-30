import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import type { WorkTaskStatusLookupResult } from "@axis/gateway-client/work-task-status";
import type { WorkConsentIntentSelectionInput } from "@axis/gateway-client";
import fixture from "../fixtures/work-consent.json" with { type: "json" };
import intentFixture from "../fixtures/work-consent-intent.json" with {
  type: "json",
};
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const SHOTS =
  process.env.WORK_CONSENT_SCREENSHOT_DIR ?? "test-results/work-consent";
const CHANNEL = "engineering";
type FixtureWindow = Window & {
  __WORK_CONSENT_TEST__: {
    calls: Array<{ command: string; args: { input: Record<string, unknown> } }>;
    uncertain: boolean;
    denied: boolean;
    empty: boolean;
    current: typeof fixture.consent;
    intentMode: "off" | "no-account" | "eligible" | "bound";
    intent: typeof intentFixture.intent;
    accounts: typeof intentFixture.accounts;
    intentBound: boolean;
    selectionUncertain: boolean;
    intentUnavailable: boolean;
    intentDiscovered: boolean;
    intentExcluded: boolean;
    omitBoundConsent: boolean;
    taskStatus: WorkTaskStatusLookupResult;
    statusOffline: boolean;
    pendingSelections: Record<string, WorkConsentIntentSelectionInput>;
    rootId: string | null;
    notReady: boolean;
  };
  __TAURI_INTERNALS__: {
    invoke: (command: string, args?: unknown) => Promise<unknown>;
  };
};

async function prepare(
  page: Page,
  mode: "light" | "dark",
  intentMode: FixtureWindow["__WORK_CONSENT_TEST__"]["intentMode"] = "off",
  directEdge = false,
) {
  await page.clock.setFixedTime(new Date("2026-09-17T14:05:00Z"));
  await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" });
  await page.addInitScript((theme) => {
    localStorage.setItem(
      "buzz-theme",
      theme === "dark" ? "symmitri-dark" : "symmitri",
    );
    localStorage.setItem("buzz-follow-system", "false");
    localStorage.setItem("buzz.channels.threadViewMode", "split");
  }, mode);
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("open-settings").waitFor();
  await page.evaluate(
    ({ sample, intentSample, initialIntentMode }) => {
      const bridge = (window as FixtureWindow).__TAURI_INTERNALS__;
      const original = bridge.invoke;
      const state: FixtureWindow["__WORK_CONSENT_TEST__"] = {
        calls: [],
        uncertain: false,
        denied: false,
        empty: initialIntentMode !== "off",
        current:
          initialIntentMode === "bound"
            ? intentSample.consent
            : { ...sample.consent, state: "pending", version: 1 },
        intentMode: initialIntentMode,
        intent: intentSample.intent,
        accounts:
          initialIntentMode === "no-account" ? [] : intentSample.accounts,
        intentBound: initialIntentMode === "bound",
        selectionUncertain: false,
        intentUnavailable: false,
        intentDiscovered: false,
        intentExcluded: false,
        omitBoundConsent: false,
        taskStatus: {
          orgId: "org_fixture",
          ownerId: "usr_owner",
          workId: "work_fixture",
          observedAt: "2026-09-17T14:05:00Z",
          statuses: [],
        },
        statusOffline: false,
        pendingSelections: {},
        rootId: null,
        notReady: false,
      };
      (window as FixtureWindow).__WORK_CONSENT_TEST__ = state;
      const identity = {
        scopeToken: "synthetic-owner-scope",
        principalId: "usr_owner",
        organisationId: "org_fixture",
      };
      const displays = () => ({
        consent_fixture: {
          accountLabel:
            state.current.terms.accountId === "account_replacement"
              ? "Owner's Granola"
              : "alex@example.test",
          accountEmail:
            state.current.terms.accountId === "account_replacement"
              ? "owner@example.test"
              : undefined,
          agentLabel: "Symi",
          initiatorLabel: "Alex",
        },
      });
      const intentDisplays = {
        intent_fixture: { agentLabel: "Symi", initiatorLabel: "Alex" },
      };
      bridge.invoke = async (command, args) => {
        // This first-milestone lane retains the real native release gate off.
        if (command === "spaces_work_release_context") {
          const input = (args as { input: Record<string, unknown> }).input;
          return { state: input.rootEventId === state.rootId ? "unsupported" : "unavailable" };
        }
        if (!command.includes("work_consent")) return original(command, args);
        const input = (args as { input: Record<string, unknown> }).input;
        state.calls.push({ command, args: { input } });
        if (command === "spaces_cancel_work_consent") return null;
        if (state.denied) return { state: "access_lost" };
        // Exact production origin: a stray agent response cannot stand in for
        // the admitted human root. Keep this before every query and decision.
        const context = (input.context ?? input) as Record<string, unknown>;
        if (context.rootEventId !== state.rootId) {
          if (command === "spaces_work_consent_context") return { state: "unavailable" };
          throw new Error("Consent command escaped its original root");
        }
        if (command === "spaces_query_work_consent_task_status") {
          if (state.statusOffline) return new Promise(() => {});
          return { state: "ready", ...identity, lookup: state.taskStatus };
        }
        if (command === "spaces_read_work_consent_result") {
          const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), x => x.toString(16).padStart(2,"0")).join("");
          const record=state.current;
          const id="contribution_"+await hash(JSON.stringify([record.id,record.termsDigest,record.version]));
          const markdown="Private synthetic next steps: resolve the roadmap blocker.";
          return {state:"ready",...identity,result:{candidate:{candidateId:"candidate_"+await hash(id),contentDigest:await hash(markdown),version:1,execution:{id,consentId:record.id,consentVersion:record.version,termsDigest:record.termsDigest},task:record.terms.task,mediaType:"text/markdown",byteLength:new TextEncoder().encode(markdown).length,createdAt:"2026-09-17T14:04:00.000Z"},markdown}};
        }
        if (command === "spaces_work_consent_context")
          return {
            state: "ready",
            context: {
              ...input,
              admissionRequestId: "admission_fixture",
              expectedRelayUrl: "wss://spaces-preview.example.test",
            },
          };
        if (command === "spaces_query_work_consents")
          return {
            state: "ready",
            ...identity,
            displays: displays(),
            lookup: {
              workId: "work_fixture",
              requests: state.empty ? [] : [state.current],
              participants: [{ grantorId: "usr_peer", state: "pending" }],
            },
          };
        if (command === "spaces_query_work_consent_intents") {
          // A simultaneous owner decision can bind between discovery and GET.
          // Every later successful query excludes already bound intents.
          const intents =
            state.intentMode !== "off" &&
            !state.intentExcluded &&
            (!state.intentBound || !state.intentDiscovered)
              ? [state.intent]
              : [];
          state.intentDiscovered = true;
          return state.intentUnavailable
            ? { state: "unavailable" }
            : {
                state: "ready",
                ...identity,
                displays: displays(),
                intentDisplays,
                pendingSelections: state.pendingSelections,
                lookup: {
                  workId: "work_fixture",
                  intents,
                },
              };
        }
        if (command === "spaces_read_work_consent_intent")
          return {
            state: "ready",
            ...identity,
            displays: displays(),
            intentDisplays,
            ownerResult: {
              intent: state.intent,
              accounts: state.accounts,
              ...(state.intentBound && !state.omitBoundConsent
                ? { consent: state.current }
                : {}),
            },
            pendingSelections: state.pendingSelections,
          };
        if (command === "spaces_select_work_consent_account") {
          state.pendingSelections[String(input.intentId)] = {
            operationId: String(input.operationId),
            expectedVersion: Number(input.expectedVersion),
            intentDigest: String(input.intentDigest),
            accountId: String(input.accountId),
            accountVersion: Number(input.accountVersion),
          };
          if (state.selectionUncertain) {
            state.selectionUncertain = false;
            return { state: "uncertain" };
          }
          if (state.intent.state !== "select_account") {
            delete state.pendingSelections[String(input.intentId)];
            return { state: "conflict" };
          }
          const account = intentSample.accounts[0];
          state.current = {
            ...sample.consent,
            version: 1,
            state: "pending",
            terms: {
              ...sample.consent.terms,
              ...state.intent.terms,
              accountId: account.accountId,
              accountVersion: account.accountVersion,
              connectionId: account.connectionId,
            },
          };
          state.intentBound = true;
          delete state.pendingSelections[String(input.intentId)];
          state.empty = false;
          return {
            state: "confirmed",
            ...identity,
            displays: displays(),
            consent: state.current,
          };
        }
        if (command === "spaces_read_work_consent")
          return { state: "ready", ...identity, consent: state.current };
        if (command === "spaces_decide_work_consent") {
          if (state.notReady && input.decision === "approve") return { state: "not_ready" };
          const decision = input.decision as "approve" | "decline" | "revoke";
          state.current = {
            ...state.current,
            version: state.current.version + 1,
            state:
              decision === "approve"
                ? "approved"
                : decision === "decline"
                  ? "declined"
                  : "revoked",
          };
          if (state.uncertain) {
            state.uncertain = false;
            return { state: "uncertain" };
          }
          return {
            state: "confirmed",
            ...identity,
            result: {
              consent: state.current,
              receipt: {
                ...sample.receipt,
                decision,
                operationId: input.operationId,
                version: state.current.version,
              },
            },
          };
        }
        throw new Error(`Unexpected work consent command: ${command}`);
      };
    },
    {
      sample: fixture,
      intentSample: intentFixture,
      initialIntentMode: intentMode,
    },
  );
  await page.getByTestId(`channel-${CHANNEL}`).click();
  await expect
    .poll(() =>
      page.evaluate(
        (channelName) =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName }) ??
          false,
        CHANNEL,
      ),
    )
    .toBe(true);
  let rootId = await page.evaluate((channelName) => {
    const root = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName,
      pubkey: "deadbeef".repeat(8),
      content:
        "Symi, turn my two latest morning meetings into source-linked roadmap proposals.",
    });
    if (!root) throw new Error("Synthetic thread root was not created");
    (window as FixtureWindow).__WORK_CONSENT_TEST__.rootId = root.id;
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName,
      parentEventId: root.id,
      content: "I’ll keep the proposals together in this thread.",
    });
    return root.id;
  }, CHANNEL);
  if (directEdge) {
    const channelId = await page.evaluate(async () => {
      const event=window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({channelName:"engineering",content:"Synthetic channel metadata"});
      const id=event?.tags.find(tag=>tag[0]==="h")?.[1];if(!id) throw new Error("Missing synthetic channel ID");return id;
    });
    const driver=process.env.AXIS_PERMISSION_EDGE_DRIVER;
    if(!driver) throw new Error("Set AXIS_PERMISSION_EDGE_DRIVER to the built direct-edge fixture");
    const events=JSON.parse(execFileSync("node",[driver],{input:JSON.stringify({channelId,createdAt:Math.floor(Date.parse("2026-09-17T14:05:00Z")/1000)}),encoding:"utf8",timeout:30000,maxBuffer:65536}));
    rootId=await page.evaluate(({source,reply,requestId})=>{
      for(const event of [source,reply]) window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({channelName:"engineering",id:event.id,content:event.content,pubkey:event.pubkey,createdAt:event.created_at,extraTags:event.tags.filter((tag:string[])=>tag[0]!=="h")});
      const state=(window as FixtureWindow).__WORK_CONSENT_TEST__;
      state.rootId=source.id;
      state.current.terms.task.requestId=requestId;
      state.intent.terms.task.requestId=requestId;
      state.current.terms.taskSummary=source.content;
      state.intent.terms.taskSummary=source.content;
      return source.id;
    },events);
    expect(events.reply.tags.filter((tag:string[])=>tag[0]==="e")).toEqual([["e",rootId,"","root"],["e",rootId,"","reply"]]);
  }
  await page.getByTestId(`reply-message-${rootId}`).click({ force: true });
  const panel = page.getByTestId("message-thread-panel");
  await expect(panel).toBeVisible();
  await expect(
    panel.getByTestId(
      intentMode === "no-account" || intentMode === "eligible"
        ? "work-consent-account-card"
        : "work-consent-card",
    ),
  ).toBeVisible();
  const composer = panel.getByTestId("message-input");
  await composer.fill("Keep the proposals focused on next steps.");
  return {
    panel,
    composer,
    card: panel.getByTestId("work-consent-card"),
    accountCard: panel.getByTestId("work-consent-account-card"),
    rootId,
  };
}

test.use({ viewport: { width: 1440, height: 1100 } });

test("access starts compact after the conversation and collapses after authorization", async ({page})=>{
  const {panel,card,composer}=await prepare(page,"light");
  const details=card.locator("details").first();
  await expect(details).not.toHaveAttribute("open","");
  await expect(card.getByText("alex@example.test",{exact:true})).not.toBeVisible();
  await expect(card.getByText("alex@example.test · Granola",{exact:true})).toBeVisible();
  await expect(card.getByRole("button",{name:"Authorize"})).toBeVisible();
  const order=await panel.evaluate(element=>{
    const replies=element.querySelector('[data-testid="message-thread-replies"]')!;
    const access=element.querySelector('[data-testid="work-consent-thread"]')!;
    return Boolean(replies.compareDocumentPosition(access)&Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order).toBe(true);
  await card.getByText("See details",{exact:true}).click();
  await expect(details).toHaveAttribute("open","");
  await card.getByRole("button",{name:"Authorize"}).click();
  await expect(card.getByRole("heading",{name:"Access approved"})).toBeVisible();
  await expect(details).not.toHaveAttribute("open","");
  await expect(composer).toHaveText("Keep the proposals focused on next steps.");
});

test("incomplete recording coverage is shown instead of an empty morning or completed draft", async ({page})=>{
  const {card}=await prepare(page,"light");
  await card.getByRole("button",{name:"Authorize"}).click();
  await page.evaluate(()=>{
    const state=(window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.taskStatus.statuses=[{consentId:state.current.id,consentVersion:state.current.version,termsDigest:state.current.termsDigest,state:"failed",revision:1,updatedAt:"2026-09-17T14:05:00Z",failureReason:"coverage_incomplete"}];
    window.dispatchEvent(new Event("online"));
  });
  await expect(card).toContainText("Could not verify complete recording coverage within the approved limits");
  await expect(card).not.toContainText("Ready to review");
  expect(await page.evaluate(()=>(window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(({command})=>command==="spaces_decide_work_consent").length)).toBe(1);
});

test("signed production direct-edge reply opens the exact human-root permission card", async ({page})=>{
  test.skip(!process.env.AXIS_PERMISSION_EDGE_DRIVER,"explicit cross-zone direct-edge lane");
  const {card,composer,rootId}=await prepare(page,"light","eligible",true);
  await page.getByTestId("work-consent-account-card").getByRole("button",{name:"Review access"}).click();
  await expect(card.getByRole("button",{name:"Authorize"})).toBeVisible();
  expect(await page.evaluate(()=>(window as FixtureWindow).__WORK_CONSENT_TEST__.rootId)).toBe(rootId);
  expect(await page.evaluate(()=>(window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(({command})=>command==="spaces_decide_work_consent").length)).toBe(0);
  await expect(composer).toHaveText("Keep the proposals focused on next steps.");
});

test("missing runtime access is not mistaken for uncertain approval and Decline remains usable", async ({ page }) => {
  const { card, composer } = await prepare(page, "light");
  await page.evaluate(() => { (window as FixtureWindow).__WORK_CONSENT_TEST__.notReady=true; });
  await card.getByRole("button",{name:"Authorize"}).click();
  await expect(card.getByRole("heading",{name:"Symi is not ready to use this account"})).toBeVisible();
  await expect(card).toContainText("No approval was saved");
  await expect(card.getByRole("button",{name:"Authorize"})).toHaveCount(0);
  await expect(card).not.toContainText("We couldn’t confirm the result");
  await expect(composer).toHaveText("Keep the proposals focused on next steps.");
  await card.getByRole("button",{name:"Decline"}).click();
  await expect(card.getByRole("heading",{name:"Access declined"})).toBeVisible();
});

test("day-wide review shows New York access separately from the original first-two task", async ({ page }) => {
  const { panel, card, composer } = await prepare(page, "light");
  await page.evaluate(() => {
    const state=(window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.current.terms.taskSummary="Use my first two distinct morning meetings";
    Object.assign(state.current.terms.scope,{mechanicsVersion:2,selection:"day_meetings",maxNotes:150,timeZone:"America/New_York",meetingStart:"2026-09-17T04:00:00Z",meetingEnd:"2026-09-18T04:00:00Z"});
    window.dispatchEvent(new Event("online"));
  });
  await expect(card).toContainText("Use my first two distinct morning meetings");
  await expect(card).toContainText("Meetings from this calendar day; the task determines which distinct meetings to use");
  await expect(card).toContainText("America/New_York");
  await expect(card).not.toContainText("latest meetings in this window");
  await expect(card.getByRole("button",{name:"Authorize"})).toBeVisible();
  expect(await page.evaluate(()=>(window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(({command})=>command==="spaces_decide_work_consent").length)).toBe(0);
  await expect(composer).toHaveText("Keep the proposals focused on next steps.");
  await expect(panel.getByRole("button",{name:/Review draft|Share draft/})).toHaveCount(0);
});

test("a misplaced response root cannot authorize the retained human request or erase its draft", async ({ page }) => {
  const { panel, card, composer, rootId } = await prepare(page, "light");
  const responseId = await page.evaluate((channelName) => {
    const response = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({ channelName, content: "Legacy unthreaded acknowledgement" });
    if (!response) throw new Error("Missing legacy response fixture");
    return response.id;
  }, CHANNEL);
  await panel.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByTestId(`reply-message-${responseId}`).scrollIntoViewIfNeeded();
  await page.getByTestId(`reply-message-${responseId}`).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate((id) => (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.some(
    ({command,args}) => command === "spaces_work_consent_context" && args.input.rootEventId === id), responseId)).toBe(true);
  await expect(panel.getByTestId("work-consent-card")).toHaveCount(0);
  await expect(panel).not.toContainText("Just for you");
  await expect(panel).not.toContainText("Private contribution review is unavailable");
  await expect(panel.getByRole("button", { name: "Authorize" })).toHaveCount(0);
  await expect(panel).not.toContainText("alex@example.test");
  await panel.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole("button", { name: /View thread with 1 reply/ }).click();
  await expect(card.getByRole("button", { name: "Authorize" })).toBeVisible();
  await expect(composer).toHaveText("Keep the proposals focused on next steps.");
  const writes = await page.evaluate(() => (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
    ({ command }) => command === "spaces_decide_work_consent" || command === "spaces_select_work_consent_account"));
  expect(writes).toHaveLength(0);
});

test("current invalidation replaces historical approval without a retry or a new task", async ({ page }) => {
  const { card, composer } = await prepare(page, "dark");
  await card.getByRole("button", { name: "Authorize" }).click();
  await expect(card.getByRole("heading", { name: "Access approved" })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.current = { ...state.current, state: "stale", version: state.current.version + 1 };
    window.dispatchEvent(new Event("online"));
  });
  await expect(card.getByRole("heading", { name: "Access is no longer valid" })).toBeVisible();
  await expect(card).not.toContainText("Your approval is saved for this task");
  await expect(card.getByRole("button", { name: "Authorize" })).toHaveCount(0);
  await expect(composer).toHaveText("Keep the proposals focused on next steps.");
  expect(await page.evaluate(() => (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
    ({ command }) => command === "spaces_decide_work_consent").length)).toBe(1);
});

for (const mode of ["light", "dark"] as const) {
  test(`${mode}: real thread consent preview, keyboard decisions and preserved composer`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { panel, composer, card } = await prepare(page, mode);
    await expect(card).toContainText("alex@example.test");
    await expect(card).toContainText("America/New_York");
    await expect(card).toContainText("Notes and results stay private to you");
    await expect(card).not.toContainText(
      /only (?:participants|members)|running/i,
    );
    const allow = card.getByRole("button", { name: "Authorize" });
    await allow.focus();
    await expect(allow).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(card.getByRole("button", { name: "Decline" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(allow).toBeFocused();
    await card.scrollIntoViewIfNeeded();
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/${mode}-native-thread-preview.png`,
    });
    await panel.screenshot({
      path: `${SHOTS}/${mode}-native-thread-detail-preview.png`,
    });
    await panel
      .getByRole("button", { name: "Expand thread", exact: true })
      .click();
    await expect(
      panel.getByRole("button", { name: "Show thread beside channel" }),
    ).toBeVisible();
    await expect(composer).toHaveText(
      "Keep the proposals focused on next steps.",
    );
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/${mode}-expanded-native-thread-preview.png`,
    });
    await card.locator("summary", { hasText: "See details" }).click();
    const limits = card.locator("summary", { hasText: "Access limits" });
    await limits.focus();
    await page.keyboard.press("Enter");
    await expect(limits.locator("..")).toHaveAttribute("open", "");
    await waitForAnimations(page);
    await page.screenshot({
      path: `${SHOTS}/${mode}-native-limits-preview.png`,
    });
    await limits.focus();
    await page.keyboard.press("Enter");
    await expect(limits.locator("..")).not.toHaveAttribute("open", "");
    await allow.focus();
    await expect(allow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      card.getByRole("heading", { name: "Access approved" }),
    ).toBeFocused();
    await expect(
      card.getByRole("button", { name: "Stop access" }),
    ).toBeVisible();
    await expect(card).not.toContainText(/running|task (?:started|resumed)/i);
    await expect(composer).toHaveText(
      "Keep the proposals focused on next steps.",
    );
    const writes = await page.evaluate(() =>
      (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
        (call) => call.command === "spaces_decide_work_consent",
      ),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].args.input).toMatchObject({
      expectedVersion: 1,
      termsDigest: fixture.consent.termsDigest,
      decision: "approve",
    });
    expect(writes[0].args.input).not.toHaveProperty("actorId");
    await card.getByRole("button", { name: "Stop access" }).click();
    await expect(
      card.getByRole("heading", { name: "Access stopped" }),
    ).toBeVisible();
    await expect(
      card.getByRole("button", { name: "Authorize" }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("uncertain decision reconciles without duplicate approval; access loss removes private details", async ({
  page,
}) => {
  const { card, composer } = await prepare(page, "light");
  await page.evaluate(() => {
    (window as FixtureWindow).__WORK_CONSENT_TEST__.uncertain = true;
  });
  await card.getByRole("button", { name: "Authorize" }).click();
  await expect(
    card.getByRole("button", { name: "Check access status" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Authorize" })).toHaveCount(
    0,
  );
  await card.getByRole("button", { name: "Check access status" }).click();
  await expect(
    card.getByRole("heading", { name: "Access approved" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
          (call) => call.command === "spaces_decide_work_consent",
        ).length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    (window as FixtureWindow).__WORK_CONSENT_TEST__.denied = true;
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    card.getByRole("heading", { name: "Check your account access" }),
  ).toBeVisible();
  await expect(card).not.toContainText("alex@example.test");
  await expect(card).not.toContainText("Granola");
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
});

test("narrow native thread keeps exact terms and decision controls within its scroll surface", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 1000 });
  const { card, panel, composer } = await prepare(page, "dark");
  await card.scrollIntoViewIfNeeded();
  const overflow = await card.evaluate(
    (element) => element.scrollWidth - element.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(
    card.getByRole("button", { name: "Authorize" }),
  ).toBeVisible();
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
  await waitForAnimations(page);
  await panel.screenshot({
    path: `${SHOTS}/dark-narrow-native-thread-preview.png`,
  });
  await card.getByRole("button", { name: "Decline" }).click();
  await expect(
    card.getByRole("heading", { name: "Access declined" }),
  ).toBeVisible();
});

test("an expired consent still permits explicit cleanup through Stop access", async ({
  page,
}) => {
  const { card, composer } = await prepare(page, "light");
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.current = {
      ...state.current,
      state: "expired",
      version: 4,
      terms: { ...state.current.terms, expiresAt: "2026-09-17T14:00:00Z" },
    };
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    card.getByRole("heading", { name: "Access expired" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Authorize" })).toHaveCount(
    0,
  );
  await card.getByRole("button", { name: "Stop access" }).click();
  await expect(
    card.getByRole("heading", { name: "Access stopped" }),
  ).toBeVisible();
  const writes = await page.evaluate(() =>
    (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
      (call) => call.command === "spaces_decide_work_consent",
    ),
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].args.input).toMatchObject({
    expectedVersion: 4,
    decision: "revoke",
  });
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
});

test("an unreadable timezone hides consent controls without breaking the thread composer", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { card, composer } = await prepare(page, "dark");
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.current = {
      ...state.current,
      terms: {
        ...state.current.terms,
        scope: { ...state.current.terms.scope, timeZone: "Invalid/Timezone" },
      },
    };
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    card.getByRole("heading", { name: "Personal access is unavailable" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Authorize" })).toHaveCount(
    0,
  );
  await expect(card).not.toContainText("alex@example.test");
  await composer.fill("The conversation remains ready.");
  await expect(composer).toHaveText("The conversation remains ready.");
  expect(errors).toEqual([]);
});

test("timestamp checks remain explicit when transcript text is excluded, with keyboard access to exact limits", async ({
  page,
}) => {
  const { card } = await prepare(page, "light");
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.current = {
      ...state.current,
      terms: {
        ...state.current.terms,
        scope: {
          ...state.current.terms.scope,
          includeTranscript: false,
          maxTranscriptPagesPerNote: 0,
        },
      },
    };
    window.dispatchEvent(new Event("online"));
  });
  await card.locator("summary", { hasText: "See details" }).click();
  await expect(
    card.getByText("Check recording timestamps to identify eligible meetings", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    card.getByText("Read their notes", { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByText("Read their notes and transcripts", { exact: true }),
  ).toHaveCount(0);
  const summary = card.locator("summary", { hasText: "Access limits" });
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(summary.locator("..")).toHaveAttribute("open", "");
  await expect(
    card.getByText("Transcript text is not included", { exact: true }),
  ).toBeVisible();
  await expect(card).toContainText(
    "Search up to 150 meeting entries (5 pages of 30)",
  );
  await expect(card).toContainText(
    "Recording-time checks: up to 8 pages per meeting; only timestamps are used",
  );
  await expect(card).toContainText(
    "Up to 128 account requests and 16,777,216 bytes in total",
  );
});

test("authoritative empty lookup quietly hides private controls without losing the task draft", async ({
  page,
}) => {
  const { panel, composer } = await prepare(page, "dark");
  await page.evaluate(() => {
    (window as FixtureWindow).__WORK_CONSENT_TEST__.empty = true;
    window.dispatchEvent(new Event("online"));
  });
  await expect(panel.getByTestId("work-consent-thread")).toHaveCount(0);
  await expect(panel.getByTestId("work-consent-card")).toHaveCount(0);
  await expect(
    panel.getByText("Connect an account to continue", { exact: true }),
  ).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Refresh account requests", exact: true })).toHaveCount(0);
  await expect(panel).toBeVisible();
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
});

test("empty older request pages retain a route back to current requests",async({page})=>{
  const {panel,card,composer}=await prepare(page,"light");
  await page.evaluate(()=>{
    const bridge=(window as FixtureWindow).__TAURI_INTERNALS__;const original=bridge.invoke;
    bridge.invoke=async(command,args)=>{
      const value=await original(command,args) as {lookup?:{requests?:unknown[];next?:unknown}};
      if(command==="spaces_query_work_consents"&&value.lookup){
        const input=(args as {input:Record<string,unknown>}).input;
        value.lookup=input.before?{...value.lookup,requests:[],next:undefined}:{...value.lookup,next:{createdAt:"2026-09-17T12:00:00Z",id:"consent_fixture"}};
      }
      return value;
    };
    window.dispatchEvent(new Event("online"));
  });
  await panel.getByRole("button",{name:"Older access requests"}).click();
  await expect(card).toHaveCount(0);
  await panel.getByRole("button",{name:"Back to latest requests"}).click();
  await expect(card.getByRole("button",{name:"Authorize"})).toBeVisible();
  await expect(composer).toHaveText("Keep the proposals focused on next steps.");
});

for (const mode of ["light", "dark"] as const) {
  test(`${mode}: account choice binds the frozen request before separate explicit approval`, async ({
    page,
  }) => {
    const { panel, composer, card, accountCard } = await prepare(
      page,
      mode,
      "eligible",
    );
    await expect(accountCard).toContainText("Requested by Alex");
    await expect(accountCard).toContainText("owner@example.test");
    await expect(accountCard.getByRole("radio")).toBeChecked();
    await expect(panel.getByRole("button", { name: /Review draft|Share draft/ })).toHaveCount(0);
    await expect(panel.getByText("Private contribution review is unavailable.")).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Authorize" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
            (call) => call.command === "spaces_select_work_consent_account",
          ).length,
      ),
    ).toBe(0);
    const review = accountCard.getByRole("button", { name: "Review access" });
    await review.focus();
    await expect(review).toBeFocused();
    await waitForAnimations(page);
    await panel.screenshot({
      path: `${SHOTS}/${mode}-native-account-choice-preview.png`,
    });
    if (mode === "dark") {
      await page.setViewportSize({ width: 800, height: 1000 });
      expect(
        await accountCard.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        ),
      ).toBeLessThanOrEqual(1);
      await waitForAnimations(page);
      await panel.screenshot({
        path: `${SHOTS}/dark-narrow-native-account-choice-preview.png`,
      });
      await review.focus();
      await expect(review).toBeFocused();
    }
    await page.keyboard.press("Enter");
    await expect(accountCard).toHaveCount(0);
    await expect(
      card.getByRole("heading", { name: "Review personal access" }),
    ).toBeFocused();
    await expect(card).toContainText("Requested by Alex");
    await expect(card).toContainText("owner@example.test");
    await expect(card).not.toContainText(/access approved|running/i);
    const selections = await page.evaluate(() =>
      (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
        (call) => call.command === "spaces_select_work_consent_account",
      ),
    );
    expect(selections).toHaveLength(1);
    expect(selections[0].args.input).toMatchObject({
      intentId: intentFixture.intent.id,
      expectedVersion: intentFixture.intent.version,
      intentDigest: intentFixture.intent.digest,
      accountId: intentFixture.accounts[0].accountId,
      accountVersion: intentFixture.accounts[0].accountVersion,
    });
    expect(selections[0].args.input).not.toHaveProperty("actorId");
    expect(
      await page.evaluate(
        () =>
          (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
            (call) => call.command === "spaces_decide_work_consent",
          ).length,
      ),
    ).toBe(0);
    await card.getByRole("button", { name: "Authorize" }).click();
    await expect(
      card.getByRole("heading", { name: "Access approved" }),
    ).toBeVisible();
    await expect(card).not.toContainText(/running|task (?:started|resumed)/i);
    await expect(composer).toHaveText(
      "Keep the proposals focused on next steps.",
    );
    expect(
      await page.evaluate(
        () =>
          (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
            (call) => call.command === "spaces_decide_work_consent",
          ).length,
      ),
    ).toBe(1);
  });
}

test("an unbound task returns from existing Connections with its new eligible account and original draft", async ({
  page,
}) => {
  const { panel, composer, accountCard } = await prepare(
    page,
    "dark",
    "no-account",
  );
  await expect(
    accountCard.getByRole("heading", {
      name: "Connect an account for this task",
    }),
  ).toBeVisible();
  await expect(accountCard.getByRole("radio")).toHaveCount(0);
  await accountCard
    .getByRole("button", { name: "Open Connections", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Connections", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  // Synthetic completion of the existing Connections flow; no personal grant is installed.
  await page.evaluate((accounts) => {
    (window as FixtureWindow).__WORK_CONSENT_TEST__.accounts = accounts;
  }, intentFixture.accounts);
  await page.getByTestId("settings-back-to-app").click();
  await expect(panel).toBeVisible();
  await expect(
    accountCard.getByRole("heading", {
      name: "Choose an account for this task",
    }),
  ).toBeVisible();
  await expect(accountCard).toContainText("owner@example.test");
  await expect(accountCard).toContainText("Requested by Alex");
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
          (call) =>
            call.command === "spaces_select_work_consent_account" ||
            call.command === "spaces_decide_work_consent",
        ).length,
    ),
  ).toBe(0);
});

test("a returned revoked binding remains its original cleanup card even when another account is eligible", async ({
  page,
}) => {
  const { panel, card, composer, accountCard } = await prepare(
    page,
    "light",
    "bound",
  );
  await expect(
    card.getByRole("heading", { name: "Access stopped" }),
  ).toBeVisible();
  await expect(accountCard).toHaveCount(0);
  await expect(card).toContainText("alex@example.test");
  await expect(card).not.toContainText("owner@example.test");
  await expect(
    panel.getByRole("button", {
      name: /Review account|Review access|Authorize/,
    }),
  ).toHaveCount(0);
  await card.getByRole("button", { name: "Refresh personal access" }).click();
  await expect(
    card.getByRole("heading", { name: "Access stopped" }),
  ).toBeVisible();
  await expect(accountCard).toHaveCount(0);
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
          (call) => call.command === "spaces_select_work_consent_account",
        ).length,
    ),
  ).toBe(0);
});

test("an uncertain account selection reads status and retries the exact operation without another choice", async ({
  page,
}) => {
  const { accountCard, card, composer } = await prepare(
    page,
    "dark",
    "eligible",
  );
  await page.evaluate(() => {
    (window as FixtureWindow).__WORK_CONSENT_TEST__.selectionUncertain = true;
  });
  await accountCard.getByRole("button", { name: "Review access" }).click();
  await expect(
    accountCard.getByRole("button", { name: "Retry selection" }),
  ).toBeVisible();
  await expect(accountCard.getByRole("radio")).toHaveCount(0);
  await accountCard
    .getByRole("button", { name: "Check account selection" })
    .click();
  await expect(
    accountCard.getByRole("button", { name: "Retry selection" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
          (call) => call.command === "spaces_select_work_consent_account",
        ).length,
    ),
  ).toBe(1);
  await accountCard.getByRole("button", { name: "Retry selection" }).click();
  await expect(
    card.getByRole("heading", { name: "Review personal access" }),
  ).toBeVisible();
  const selections = await page.evaluate(() =>
    (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
      (call) => call.command === "spaces_select_work_consent_account",
    ),
  );
  expect(selections).toHaveLength(2);
  expect(selections[1].args.input).toEqual(selections[0].args.input);
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
          (call) => call.command === "spaces_decide_work_consent",
        ).length,
    ),
  ).toBe(0);
});

test("changed or expired account-free terms cannot offer account selection", async ({
  page,
}) => {
  const { accountCard, composer } = await prepare(page, "light", "eligible");
  for (const state of ["stale", "expired"] as const) {
    await page.evaluate((next) => {
      (window as FixtureWindow).__WORK_CONSENT_TEST__.intent.state = next;
      window.dispatchEvent(new Event("online"));
    }, state);
    await expect(
      accountCard.getByRole("heading", {
        name:
          state === "stale"
            ? "Access request changed"
            : "Access request expired",
      }),
    ).toBeVisible();
    await expect(accountCard.getByRole("radio")).toHaveCount(0);
    await expect(
      accountCard.getByRole("button", { name: "Review access" }),
    ).toHaveCount(0);
  }
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
});

test("an excluded expired intent retains only the exact uncertain selection retry", async ({
  page,
}) => {
  const { accountCard, composer, panel } = await prepare(
    page,
    "dark",
    "eligible",
  );
  await page.evaluate(() => {
    (window as FixtureWindow).__WORK_CONSENT_TEST__.selectionUncertain = true;
  });
  await accountCard.getByRole("button", { name: "Review access" }).click();
  await expect(
    accountCard.getByRole("button", { name: "Retry selection" }),
  ).toBeVisible();
  await page.clock.setFixedTime(new Date("2026-09-17T18:00:01Z"));
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.intentExcluded = true;
    state.intent.state = "expired";
    state.accounts = [
      { ...state.accounts[0], accountVersion: 3, label: "Replacement Granola" },
    ];
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    accountCard.getByRole("button", { name: "Retry selection" }),
  ).toBeVisible();
  await expect(accountCard.getByRole("radio")).toHaveCount(0);
  await expect(accountCard).not.toContainText("Replacement Granola");
  await expect(
    panel.getByText("No personal access request is waiting for you in this thread."),
  ).toHaveCount(0);
  await accountCard
    .getByRole("button", { name: "Check account selection" })
    .click();
  await expect(
    accountCard.getByRole("button", { name: "Retry selection" }),
  ).toBeVisible();
  await accountCard.getByRole("button", { name: "Retry selection" }).click();
  await expect(
    accountCard.getByRole("heading", { name: "Access request expired" }),
  ).toBeVisible();
  await expect(accountCard.getByRole("radio")).toHaveCount(0);
  await expect(
    accountCard.getByRole("button", { name: "Review access" }),
  ).toHaveCount(0);
  const selections = await page.evaluate(() =>
    (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
      (call) => call.command === "spaces_select_work_consent_account",
    ),
  );
  expect(selections).toHaveLength(2);
  expect(selections[1].args.input).toEqual(selections[0].args.input);
  expect(selections[1].args.input.accountVersion).toBe(2);
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
});

test("owner result is readable privately and revocation clears it without disturbing the draft", async ({page}) => {
  const {panel,composer}=await prepare(page,"light");
  await page.evaluate(()=>{
    const s=(window as FixtureWindow).__WORK_CONSENT_TEST__;
    s.current={...s.current,state:"approved",version:2};
    s.taskStatus.statuses=[{consentId:s.current.id,consentVersion:2,termsDigest:s.current.termsDigest,state:"candidate_ready",revision:3,updatedAt:"2026-09-17T14:04:00Z"}];
    window.dispatchEvent(new Event("online"));
  });
  const result=panel.getByTestId("work-consent-result");
  await result.getByRole("button",{name:"View private result"}).click();
  await expect(result).toContainText("Private synthetic next steps: resolve the roadmap blocker.");
  await expect(composer).toHaveText("Keep the proposals focused on next steps.");
  await page.evaluate(()=>{const s=(window as FixtureWindow).__WORK_CONSENT_TEST__;s.current.state="revoked";s.current.version=3;window.dispatchEvent(new Event("online"));});
  await expect(result).toHaveCount(0);
  await expect(page.getByText("Private synthetic next steps: resolve the roadmap blocker.")).toHaveCount(0);
  await expect(composer).toHaveText("Keep the proposals focused on next steps.");
  expect(await page.evaluate(()=>(window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(c=>c.command==="spaces_decide_work_consent").length)).toBe(0);
});

test("an unavailable intent query cannot be presented as an empty successful request lookup", async ({
  page,
}) => {
  const { panel } = await prepare(page, "light");
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.empty = true;
    state.intentUnavailable = true;
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    panel.getByText("We couldn’t check account requests for this task."),
  ).toBeVisible();
  await expect(
    panel.getByText("No personal access request is waiting for you in this thread."),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as FixtureWindow).__WORK_CONSENT_TEST__.intentUnavailable = false;
  });
  await panel.getByRole("button", { name: "Refresh account requests" }).click();
  await expect(
    panel.getByText("No personal access request is waiting for you in this thread."),
  ).toHaveCount(0);
  await expect(panel.getByTestId("work-consent-thread")).toHaveCount(0);
});

test("an omitted existing binding stays uncertain until fresh owner proof restores its exact review", async ({
  page,
}) => {
  const { accountCard, card, panel, composer } = await prepare(
    page,
    "light",
    "eligible",
  );
  await accountCard.getByRole("button", { name: "Review access" }).click();
  await expect(
    card.getByRole("heading", { name: "Review personal access" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.empty = true;
    state.omitBoundConsent = true;
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    card.getByRole("button", { name: "Check access status" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Authorize" })).toHaveCount(
    0,
  );
  await expect(accountCard).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: "Review account" }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (window as FixtureWindow).__WORK_CONSENT_TEST__.omitBoundConsent = false;
  });
  await card.getByRole("button", { name: "Check access status" }).click();
  await expect(
    card.getByRole("button", { name: "Authorize" }),
  ).toBeVisible();
  await expect(card).toContainText("owner@example.test");
  await expect(accountCard).toHaveCount(0);
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
  expect(
    await page.evaluate(
      () =>
        (window as FixtureWindow).__WORK_CONSENT_TEST__.calls.filter(
          (call) => call.command === "spaces_select_work_consent_account",
        ).length,
    ),
  ).toBe(1);
});

test("private task progress requires the current exact consent version and digest", async ({
  page,
}) => {
  const { card, composer, panel } = await prepare(page, "light");
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.current.state = "approved";
    state.current.version = 2;
    state.taskStatus.statuses = [
      {
        consentId: state.current.id,
        consentVersion: 2,
        termsDigest: state.current.termsDigest,
        state: "queued",
        revision: 1,
        updatedAt: "2026-09-17T14:05:00Z",
        leaseExpiresAt: "2026-09-17T14:06:00Z",
      },
    ];
    window.dispatchEvent(new Event("online"));
  });
  await expect(card.getByTestId("work-consent-task-status")).toHaveText(
    "Waiting to start",
  );
  await page.evaluate(() => {
    (
      window as FixtureWindow
    ).__WORK_CONSENT_TEST__.taskStatus.statuses[0].state = "running";
    window.dispatchEvent(new Event("online"));
  });
  await expect(card.getByTestId("work-consent-task-status")).toHaveText(
    "Working privately",
  );
  for (const mismatch of ["version", "digest", "consent"] as const) {
    await page.evaluate((field) => {
      const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
      const status = state.taskStatus.statuses[0];
      status.consentId =
        field === "consent" ? "consent_other" : state.current.id;
      status.consentVersion =
        field === "version" ? state.current.version + 1 : state.current.version;
      status.termsDigest =
        field === "digest" ? "f".repeat(64) : state.current.termsDigest;
      window.dispatchEvent(new Event("online"));
    }, mismatch);
    await expect(card.getByTestId("work-consent-task-status")).toHaveText(
      "Status unconfirmed",
    );
  }
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.taskStatus.statuses = [
      {
        consentId: state.current.id,
        consentVersion: state.current.version,
        termsDigest: state.current.termsDigest,
        state: "candidate_ready",
        revision: 3,
        updatedAt: "2026-09-17T14:05:00Z",
      },
    ];
    window.dispatchEvent(new Event("online"));
  });
  await expect(card.getByTestId("work-consent-task-status")).toHaveText(
    "Ready to review",
  );
  await waitForAnimations(page);
  await panel.screenshot({
    path: `${SHOTS}/light-native-task-ready-preview.png`,
  });
  await panel
    .getByRole("button", { name: "Expand thread", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Show thread beside channel" }),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: `${SHOTS}/light-expanded-native-task-ready-preview.png`,
  });
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
});

test("a private candidate is ready to review and revoked consent overrides its old progress", async ({
  page,
}) => {
  const { card, composer, panel } = await prepare(page, "dark");
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.current.state = "approved";
    state.current.version = 2;
    state.taskStatus.statuses = [
      {
        consentId: state.current.id,
        consentVersion: 2,
        termsDigest: state.current.termsDigest,
        state: "candidate_ready",
        revision: 2,
        updatedAt: "2026-09-17T14:05:00Z",
      },
    ];
    window.dispatchEvent(new Event("online"));
  });
  await expect(card.getByTestId("work-consent-task-status")).toHaveText(
    "Ready to review",
  );
  await expect(
    card.getByRole("button", { name: /share|publish|continue/i }),
  ).toHaveCount(0);
  await expect(card).not.toContainText(/published|shared with/i);
  await waitForAnimations(page);
  await panel.screenshot({
    path: `${SHOTS}/dark-native-task-ready-preview.png`,
  });
  await panel
    .getByRole("button", { name: "Expand thread", exact: true })
    .click();
  await expect(
    panel.getByRole("button", { name: "Show thread beside channel" }),
  ).toBeVisible();
  await waitForAnimations(page);
  await page.screenshot({
    path: `${SHOTS}/dark-expanded-native-task-ready-preview.png`,
  });
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.current.state = "revoked";
    state.current.version = 3;
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    card.getByRole("heading", { name: "Access stopped" }),
  ).toBeVisible();
  await expect(card.getByTestId("work-consent-task-status")).toHaveCount(0);
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
});

test("an execution lease expires locally while an offline status read cannot respond", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-09-17T14:05:00Z") });
  const { card, composer } = await prepare(page, "light");
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.current.state = "approved";
    state.current.version = 2;
    state.taskStatus.statuses = [
      {
        consentId: state.current.id,
        consentVersion: 2,
        termsDigest: state.current.termsDigest,
        state: "running",
        revision: 1,
        updatedAt: "2026-09-17T14:05:00Z",
        leaseExpiresAt: "2026-09-17T14:05:10Z",
      },
    ];
    window.dispatchEvent(new Event("online"));
  });
  await expect(card.getByTestId("work-consent-task-status")).toHaveText(
    "Working privately",
  );
  await page.evaluate(() => {
    (window as FixtureWindow).__WORK_CONSENT_TEST__.statusOffline = true;
  });
  await page.context().setOffline(true);
  await page.clock.setSystemTime(new Date("2026-09-17T14:05:00Z"));
  await page.clock.fastForward(11_000);
  await expect(card.getByTestId("work-consent-task-status")).toHaveText(
    "Status unconfirmed",
  );
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
});

test("a wrong-owner status projection clears private consent data", async ({
  page,
}) => {
  const { card, composer } = await prepare(page, "dark");
  await page.evaluate(() => {
    const state = (window as FixtureWindow).__WORK_CONSENT_TEST__;
    state.taskStatus.ownerId = "usr_peer";
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    card.getByRole("heading", { name: "Check your account access" }),
  ).toBeVisible();
  await expect(card).not.toContainText("alex@example.test");
  await expect(card).not.toContainText("Granola");
  await expect(card.getByTestId("work-consent-task-status")).toHaveCount(0);
  await expect(composer).toHaveText(
    "Keep the proposals focused on next steps.",
  );
});
