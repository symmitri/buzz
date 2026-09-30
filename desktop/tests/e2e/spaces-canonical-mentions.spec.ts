import { expect, test, type Page } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const ADAM = TEST_IDENTITIES.bob.pubkey;
const EVE = TEST_IDENTITIES.charlie.pubkey;
const GROUP = "d1ec7000-d000-4000-8000-000000000003";
type State = { revoked: boolean; sameName: boolean; calls: Array<{ command: string; args: any }> };
type FixtureWindow = Window & { __CANONICAL_MENTIONS__: State };

async function prepare(page: Page, stream = false) {
  await installMockBridge(page, {
    managedAgents: ["Fizz", "Honey", "Pollen"].map((name, index) => ({
      pubkey: String(index + 1).repeat(64), name,
    })),
    personas: [{ id: "legacy-persona", displayName: "Legacy Persona", systemPrompt: "Synthetic", isActive: true }],
    teams: [{ id: "legacy-team", name: "Legacy Team", personaIds: ["legacy-persona"] }],
    searchProfiles: [
      { pubkey: ADAM, displayName: "Adam", isAgent: true },
      { pubkey: EVE, displayName: "Eve", isAgent: true },
      { pubkey: "f".repeat(64), displayName: "Legacy Search Agent", isAgent: true },
    ],
  });
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke));
  await page.evaluate(({ adam, eve }) => {
    const state: State = { revoked: false, sameName: false, calls: [] };
    (window as FixtureWindow).__CANONICAL_MENTIONS__ = state;
    const original = window.__TAURI_INTERNALS__!.invoke.bind(window.__TAURI_INTERNALS__);
    window.__TAURI_INTERNALS__!.invoke = async (command, args: any = {}, options) => {
      if (command !== "spaces_list_company_channel_mentions" && command !== "spaces_revalidate_company_channel_mentions")
        return original(command, args, options);
      state.calls.push({ command, args });
      if (state.revoked) throw new Error("Synthetic membership changed");
      return {
        relay_url: "ws://localhost:3000", human_pubkey: "deadbeef".repeat(8), channel_id: args.channelId,
        agents: [{ company_agent_id: "agent-adam", pubkey: adam, name: "Adam", channel_ids: [args.channelId] },
          { company_agent_id: "agent-eve", pubkey: eve, name: "Eve", channel_ids: [args.channelId] }]
          .map(agent => ({...agent, name: state.sameName ? "Review Agent" : agent.name}))
          .filter(agent => !args.pubkeys || args.pubkeys.includes(agent.pubkey)),
      };
    };
  }, { adam: ADAM, eve: EVE });
  if (stream) await page.getByTestId("channel-general").click();
  else await page.getByRole("button", { name: "Adam, Eve", exact: true }).click();
  await page.evaluate(async () => {
    await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({ queryKey: ["spaces-company-mentions"] });
  });
  return page.getByTestId("message-input");
}

async function sentTags(page: Page, text: string) {
  return page.evaluate(content => {
    const signed = (window.__BUZZ_E2E_SIGNED_EVENTS__ ?? []).filter(event => event.content === content);
    if (signed.length) return signed.flatMap(event => event.tags);
    return (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).flatMap(call => {
      const payload = call.payload as { content?: string; mentionPubkeys?: string[]; mentionTags?: string[][]; parentEventId?: string };
      return call.command === "send_channel_message" && payload.content === content
        ? [...(payload.mentionTags ?? []), ...(payload.mentionPubkeys ?? []).map(key => ["p", key]), ...(payload.parentEventId ? [["e", payload.parentEventId]] : [])] : [];
    });
  }, text);
}
async function recipients(page: Page, text: string) { return (await sentTags(page, text)).filter(tag => tag[0] === "p").map(tag => tag[1]).sort(); }
async function validatedMentions(page: Page) {
  return page.evaluate(() => (window as FixtureWindow).__CANONICAL_MENTIONS__.calls.filter(call => call.command === "spaces_revalidate_company_channel_mentions").at(-1)?.args.pubkeys);
}

test("Alpha group autocomplete uses canonical Agents and shows editable chips before sending", async ({ page }) => {
  const composer = await prepare(page);
  await composer.fill("@Legacy");
  await expect.poll(() => page.evaluate(() => (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).some(call => call.command === "search_users" && JSON.stringify(call.payload).includes("legacy")))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__BUZZ_E2E_QUERY_CLIENT__?.isFetching())).toBe(0);
  await expect(page.locator('[data-testid^="mention-suggestion-"]').filter({hasText:/Legacy/})).toHaveCount(0);
  await composer.fill("@");
  await expect(page.getByTestId(`mention-suggestion-${ADAM}`)).toContainText("Adam");
  await expect(page.getByTestId(`mention-suggestion-${EVE}`)).toContainText("Eve");
  for (const key of ["1", "2", "3"]) await expect(page.getByTestId(`mention-suggestion-${key.repeat(64)}`)).toHaveCount(0);
  await expect(page.locator('[data-testid^="mention-suggestion-"]').filter({hasText:/Legacy Persona|Legacy Team/})).toHaveCount(0);
  await page.getByTestId(`mention-suggestion-${ADAM}`).locator("button").first().click();
  await expect(composer.locator(".mention-chip")).toHaveText(/Adam/);
  await page.keyboard.type("please review");
  const text = await composer.innerText();
  await page.getByTestId("send-message").click();
  // DM transport addresses the whole existing participant set. Verify the
  // explicitly selected binding separately at the final validation boundary.
  await expect.poll(() => recipients(page, text)).toEqual([ADAM, EVE].sort());
  expect(await validatedMentions(page)).toEqual([ADAM]);
  const calls = await page.evaluate(() => (window as FixtureWindow).__CANONICAL_MENTIONS__.calls);
  expect(calls.some(call => call.command === "spaces_revalidate_company_channel_mentions" && call.args.channelId === GROUP && call.args.pubkeys.includes(ADAM))).toBe(true);
});

test("exact-name keyboard selection decorates the group composer and a stale Agent cannot send", async ({ page }) => {
  const composer = await prepare(page);
  await composer.focus();
  await page.keyboard.type("@eve ");
  await expect(composer.locator(".mention-chip")).toHaveText(/Eve/i);
  await page.keyboard.type("check this");
  const text = await composer.innerText();
  await page.evaluate(() => { (window as FixtureWindow).__CANONICAL_MENTIONS__.revoked = true; });
  await page.getByTestId("send-message").click();
  await expect(page.getByText(/Could not authorize a mentioned agent/)).toBeVisible();
  await expect(composer).toHaveText(text);
  expect(await recipients(page, text)).toEqual([]);
});

test("Alpha stream and group thread composers use the same canonical choices", async ({ page }) => {
  const composer = await prepare(page, true);
  await composer.fill("@Ad");
  await expect(page.getByTestId(`mention-suggestion-${ADAM}`)).toContainText("Adam");
  await page.keyboard.press("Enter");
  await expect(composer.locator(".mention-chip")).toHaveText(/Adam/);
  await composer.fill("");
  await page.getByRole("button", { name: "Adam, Eve", exact: true }).click();
  const rootId = await page.evaluate(() => {
    const event = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({ channelName: "Group DM (3)", content: "Synthetic review thread" });
    if (!event) throw new Error("No thread fixture");
    return event.id;
  });
  await page.getByTestId(`reply-message-${rootId}`).click({ force: true });
  const panel = page.getByTestId("message-thread-panel");
  const thread = panel.getByTestId("message-input");
  await thread.fill("@Ev");
  await expect(panel.getByTestId(`mention-suggestion-${EVE}`)).toContainText("Eve");
  await page.keyboard.press("Tab");
  await expect(thread.locator(".mention-chip")).toHaveText(/Eve/);
  await page.keyboard.type("review this reply");
  const text = await thread.innerText();
  await panel.getByTestId("send-message").click();
  await expect.poll(() => recipients(page, text)).toEqual([ADAM, EVE].sort());
  expect(await validatedMentions(page)).toEqual([EVE]);
  expect((await sentTags(page, text)).filter(tag => tag[0] === "e").map(tag => tag[1])).toContain(rootId);
  await expect(composer.first()).toHaveText("");
});

test("membership refresh hides stale Agent choices and same-name choices retain their exact keys", async ({page}) => {
  const composer = await prepare(page);
  await page.evaluate(async channelId => {
    (window as FixtureWindow).__CANONICAL_MENTIONS__.sameName = true;
    await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({queryKey:["channels",channelId,"members"]});
  }, GROUP);
  await composer.fill("@Review");
  await expect(page.getByTestId(`mention-suggestion-${ADAM}`)).toContainText("Review Agent");
  await expect(page.getByTestId(`mention-suggestion-${EVE}`)).toContainText("Review Agent");
  await page.getByTestId(`mention-suggestion-${EVE}`).locator("button").first().click();
  await expect(composer.locator(".mention-chip")).toContainText("Review Agent");
  await page.keyboard.type("same-name selection");
  const text = await composer.innerText();
  await page.getByTestId("send-message").click();
  await expect.poll(() => recipients(page, text)).toEqual([ADAM, EVE].sort());
  expect(await validatedMentions(page)).toEqual([EVE]);
  await page.evaluate(async channelId => {
    (window as FixtureWindow).__CANONICAL_MENTIONS__.revoked = true;
    await window.__BUZZ_E2E_QUERY_CLIENT__?.invalidateQueries({queryKey:["channels",channelId,"members"]});
  }, GROUP);
  await composer.fill("@Review");
  await expect(page.getByTestId(`mention-suggestion-${ADAM}`)).toHaveCount(0);
  await expect(page.getByTestId(`mention-suggestion-${EVE}`)).toHaveCount(0);
  await expect(composer).toHaveText("@Review");
  await composer.fill("@Legacy");
  await expect(page.locator('[data-testid^="mention-suggestion-"]')).toHaveCount(0);
});
