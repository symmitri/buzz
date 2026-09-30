// Symmitri modification: cover the native Notes to yourself workflow.
import { expect, test, type Locator, type Page } from "@playwright/test";

import { installMockBridge, openNewMessagePage } from "../helpers/bridge";

const SELF_PUBKEY = "deadbeef".repeat(8);
const SELF_NAME = "Jonathan Poma";
const SELF_LABEL = `${SELF_NAME} (you)`;
const SELF_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Crect width='32' height='32' fill='%238a67b1'/%3E%3C/svg%3E";
const NOTES_LABEL = "Notes to yourself";
const MOCK_SELF_DM_CHANNEL_NAME = "Group DM (1)";

async function selectSelfRecipient(page: Page) {
  await openNewMessagePage(page);

  const search = page.getByTestId("new-dm-search");
  await search.fill("Jonathan");
  const self = page.getByTestId(`new-dm-result-${SELF_PUBKEY}`);
  await expect(self).toContainText(SELF_LABEL);
  await expect(self).toContainText("Only you.");
  await expect(self.getByTestId("new-dm-agent-icon")).toHaveCount(0);
  await self.click();

  await expect(
    page.getByTestId(`new-dm-selected-${SELF_PUBKEY}`),
  ).toHaveAttribute("aria-label", `Remove ${SELF_LABEL}`);
  await expect(search).toHaveValue("");
  await expect(
    page.getByTestId("message-input").locator("[data-placeholder]").first(),
  ).toHaveAttribute("data-placeholder", "Write a note");
  return search;
}

function selfDmButton(page: Page): Locator {
  return page
    .getByTestId("dm-list")
    .locator("button[data-channel-id]")
    .filter({ hasText: NOTES_LABEL });
}

function selfDmSidebarItem(page: Page): Locator {
  return selfDmButton(page).locator(
    "xpath=ancestor::*[@data-sidebar='menu-item'][1]",
  );
}

async function expectSelfDmRowInsideSidebar(page: Page) {
  const [rowBox, scrollBox] = await Promise.all([
    selfDmButton(page).boundingBox(),
    page.locator('[data-sidebar="content"]').boundingBox(),
  ]);
  expect(rowBox).not.toBeNull();
  expect(scrollBox).not.toBeNull();
  if (!rowBox || !scrollBox) return;
  expect(rowBox.y).toBeGreaterThanOrEqual(scrollBox.y);
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(
    scrollBox.y + scrollBox.height,
  );
}

async function expectNoSelfNotificationOrUnread(page: Page) {
  const item = selfDmSidebarItem(page);
  await expect(item.locator('[data-testid^="channel-unread"]')).toHaveCount(0);
  await expect(item.locator('[data-testid^="channel-dm-count"]')).toHaveCount(
    0,
  );
  await expect(item.locator('[data-testid^="channel-presence-"]')).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              __BUZZ_E2E_NOTIFICATIONS__?: unknown[];
            }
          ).__BUZZ_E2E_NOTIFICATIONS__?.length ?? 0,
      ),
    )
    .toBe(0);
}

async function releaseSelfAuthoredEchoAwayFromChannel(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        (channelName) =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({ channelName }) ??
          false,
        MOCK_SELF_DM_CHANNEL_NAME,
      ),
    )
    .toBe(true);

  await page
    .getByTestId("sidebar-primary-menu")
    .getByRole("button", { name: "Inbox", exact: true })
    .click();
  await expect(page.getByTestId("home-inbox-list")).toBeVisible();

  const releasedEchoes = await page.evaluate(
    () => window.__BUZZ_E2E_RELEASE_SEND_MESSAGE_LIVE_ECHO__?.() ?? 0,
  );
  expect(releasedEchoes).toBe(1);
  await page.waitForTimeout(100);
  await expectNoSelfNotificationOrUnread(page);
}

test.beforeEach(async ({ page }) => {
  await installMockBridge(page, {
    deferSendMessageLiveEcho: true,
    searchProfiles: [
      {
        pubkey: SELF_PUBKEY,
        displayName: SELF_NAME,
        avatarUrl: SELF_AVATAR,
      },
    ],
  });
  await page.goto("/");
});

test("the signed-in human is searchable and can only be selected alone", async ({
  page,
}) => {
  const search = await selectSelfRecipient(page);

  await search.fill("alice");
  await expect(page.locator('[data-testid^="new-dm-result-"]')).toHaveCount(0);
  await expect(page.getByTestId("new-dm-empty")).toHaveText(
    "No matching users.",
  );
  await expect(
    page.locator('button[data-testid^="new-dm-selected-"]'),
  ).toHaveCount(1);
  await expect(
    page.getByTestId(`new-dm-selected-${SELF_PUBKEY}`),
  ).toBeVisible();
});

test("a self note keeps its label and history when hidden and reopened", async ({
  page,
}) => {
  await selectSelfRecipient(page);

  const firstNote = "Remember to review the launch checklist";
  await page.getByTestId("message-input").fill(firstNote);
  await page.getByTestId("send-message").click();

  await expect(page.getByTestId("chat-title")).toHaveText(NOTES_LABEL);
  await expect(page.getByTestId("chat-presence-badge")).toHaveCount(0);
  await expect(page.getByTestId("chat-header-dm-avatar-image")).toHaveAttribute(
    "src",
    SELF_AVATAR,
  );
  await expect(page.getByTestId("message-dm-intro")).toContainText(
    "A private space for your notes and reminders.",
  );
  await expect(page.getByTestId("message-timeline")).toContainText(firstNote);
  await expect(selfDmButton(page)).toHaveCount(1);
  await expectSelfDmRowInsideSidebar(page);
  await expect(
    selfDmSidebarItem(page).getByRole("img", {
      name: `${SELF_NAME} avatar`,
    }),
  ).toHaveAttribute("src", SELF_AVATAR);
  const originalChannelId =
    await selfDmButton(page).getAttribute("data-channel-id");
  expect(originalChannelId).toBeTruthy();
  await releaseSelfAuthoredEchoAwayFromChannel(page);

  const item = selfDmSidebarItem(page);
  await item.hover();
  await item.getByRole("button", { name: "Close direct message" }).click();
  await expect(selfDmButton(page)).toHaveCount(0);

  await selectSelfRecipient(page);
  const secondNote = "Draft the customer follow-up tomorrow";
  await page.getByTestId("message-input").fill(secondNote);
  await page.getByTestId("send-message").click();

  await expect(page.getByTestId("chat-title")).toHaveText(NOTES_LABEL);
  await expect(page.getByTestId("message-timeline")).toContainText(firstNote);
  await expect(page.getByTestId("message-timeline")).toContainText(secondNote);
  await expect(selfDmButton(page)).toHaveAttribute(
    "data-channel-id",
    originalChannelId ?? "",
  );
  await expectSelfDmRowInsideSidebar(page);
  await releaseSelfAuthoredEchoAwayFromChannel(page);
});
