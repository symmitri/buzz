// Symmitri modification: exercise actual Appearance and conversation surfaces.
import { expect, test, type Page } from "@playwright/test";
import { hexToHsl } from "../../src/shared/theme/adaptive-theme";
import { getSymmitriPalette } from "../../src/shared/theme/symmitri-themes";
import { installMockBridge } from "../helpers/bridge";
import { openSettings } from "../helpers/settings";
import { waitForAnimations } from "../helpers/animations";

const SHOTS = "test-results/symmitri-themes";
const SAVED_ACCENT = "#06b6d4";

async function expectTheme(page: Page, name: string) {
  const palette = getSymmitriPalette(name);
  if (!palette) throw new Error(`Missing theme: ${name}`);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--background"),
      ),
    )
    .toBe(hexToHsl(palette.background));
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--primary"),
      ),
    )
    .toBe(hexToHsl(palette.accent));
  await expect(page.locator("html")).toHaveClass(
    name.endsWith("-dark") ? /dark/ : /light/,
  );
  await expect(page.locator("html")).not.toHaveAttribute("data-buzz-sidebar");
  expect(
    await page.evaluate(() => localStorage.getItem("buzz-accent-color")),
  ).toBe(SAVED_ACCENT);
}

test("community switching restores its theme, System mode and saved accent", async ({
  page,
}) => {
  const pubkey = "deadbeef".repeat(8);
  const communities = [
    {
      id: "theme-studio",
      name: "Studio",
      relayUrl: "ws://localhost:3000",
      pubkey,
      addedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "theme-lab",
      name: "Lab",
      relayUrl: "ws://localhost:3001",
      pubkey,
      addedAt: "2026-01-02T00:00:00.000Z",
    },
  ];
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(
    ({ communities, pubkey, accent }) => {
      localStorage.setItem("buzz-communities", JSON.stringify(communities));
      localStorage.setItem("buzz-active-community-id", communities[0].id);
      localStorage.setItem("buzz-theme", "buzz");
      localStorage.setItem("buzz-accent-color", accent);
      localStorage.setItem("buzz-follow-system", "false");
      localStorage.setItem(
        `buzz-community-theme.v1:${pubkey}:${encodeURIComponent(communities[1].relayUrl)}`,
        JSON.stringify({
          version: 1,
          theme: "github-light",
          accent: "#ef4444",
          followSystem: false,
        }),
      );
    },
    { communities, pubkey, accent: SAVED_ACCENT },
  );
  await installMockBridge(page, undefined, { skipCommunitySeed: true });
  await page.goto("/");
  await openSettings(page, "appearance");
  await page.getByTestId("appearance-mode-system").click();
  await page.getByTestId("theme-style-trigger").click();
  await page.getByTestId("theme-pair-symmitri-classic").click();
  await expectTheme(page, "symmitri-classic-dark");
  await page.getByTestId("settings-back-to-app").click();
  await page.getByTestId("community-rail-button-theme-lab").click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("buzz-theme")))
    .toBe("github-light");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--primary"),
      ),
    )
    .toBe(hexToHsl("#ef4444"));
  expect(
    await page.evaluate(() => localStorage.getItem("buzz-follow-system")),
  ).toBe("false");
  await page.getByTestId("community-rail-button-theme-studio").click();
  await expectTheme(page, "symmitri-classic-dark");
  expect(await page.evaluate(() => localStorage.getItem("buzz-theme"))).toBe(
    "symmitri-classic",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("buzz-follow-system")),
  ).toBe("true");
});

async function openThemePicker(page: Page) {
  await page.addInitScript(
    ({ accent }) => {
      if (localStorage.getItem("symmitri-e2e-seeded")) return;
      localStorage.setItem("symmitri-e2e-seeded", "true");
      localStorage.setItem("buzz-theme", "buzz");
      localStorage.setItem("buzz-follow-system", "false");
      localStorage.setItem("buzz-accent-color", accent);
      localStorage.setItem("buzz.channels.threadViewMode", "split");
    },
    { accent: SAVED_ACCENT },
  );
  await installMockBridge(page);
  await page.goto("/");
  await openSettings(page, "appearance");
  expect(await page.evaluate(() => localStorage.getItem("buzz-theme"))).toBe(
    "buzz",
  );
  await page.getByTestId("theme-style-trigger").click();
}

async function sampleConversation(page: Page) {
  await page.getByTestId("settings-back-to-app").click();
  await page.getByTestId("channel-general").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
          channelName: "general",
          kind: 9,
        }),
      ),
    )
    .toBe(true);
  const rootId = await page.evaluate(() => {
    const emit = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
    if (!emit) throw new Error("Mock message bridge unavailable");
    const now = Math.floor(Date.now() / 1000);
    const root = emit({
      channelName: "general",
      content:
        "A quieter place to do good work.\n\nThe new workspace brings conversations, decisions and next steps together. **Ready for review.**",
      createdAt: now,
    });
    emit({
      channelName: "general",
      content:
        "The details feel right. I checked the light and dark views, including the composer and unread messages.",
      parentEventId: root.id,
      createdAt: now + 1,
    });
    emit({
      channelName: "general",
      content:
        "A small example for the handoff:\n```typescript\nconst workspace = { name: 'Spaces', ready: true };\nawait share(workspace);\n```",
      createdAt: now + 2,
    });
    return root.id;
  });
  await expect(page.locator("[data-code-block]").last()).toBeVisible();
  const highlighted = page
    .locator("[data-code-block]")
    .last()
    .locator("span[style]");
  await expect(highlighted.first()).toBeVisible();
  const composer = page.getByTestId("message-input").first();
  await composer.fill("Looks good. I’ll add the final notes here.");
  await expect(composer).toHaveCSS("font-family", /Inter/);
  await expect(composer).toHaveText(
    "Looks good. I’ll add the final notes here.",
  );
  return rootId;
}

for (const family of ["symmitri", "symmitri-classic"]) {
  for (const mode of ["light", "dark"] as const) {
    const name = mode === "dark" ? `${family}-dark` : family;
    test(`${name}: select, preview, chat and thread`, async ({ page }) => {
      await page.emulateMedia({
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      await openThemePicker(page);
      await page.getByTestId(`appearance-mode-${mode}`).click();
      const tile = page.getByTestId(`theme-option-${name}`);
      await tile.click();
      await expect(tile).toHaveAttribute("aria-pressed", "true");
      await expectTheme(page, name);
      await tile.focus();
      await expect(tile).toBeFocused();
      expect(
        await tile
          .locator("div")
          .first()
          .evaluate((el) => getComputedStyle(el).boxShadow),
      ).not.toBe("none");
      await waitForAnimations(page);
      await page.screenshot({ path: `${SHOTS}/${name}-appearance.png` });
      const rootId = await sampleConversation(page);
      await waitForAnimations(page);
      await page.screenshot({ path: `${SHOTS}/${name}-conversation.png` });
      await page
        .locator(
          `[data-testid="message-thread-summary"][data-thread-head-id="${rootId}"]`,
        )
        .click();
      await expect(page.getByTestId("message-thread-panel")).toBeVisible();
      await waitForAnimations(page);
      await page.screenshot({ path: `${SHOTS}/${name}-thread.png` });
    });
  }

  test(`${family}: System follows OS, survives reload and restores the saved accent`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await openThemePicker(page);
    await page.getByTestId("appearance-mode-system").click();
    const tile = page.getByTestId(`theme-pair-${family}`);
    await tile.click();
    await expectTheme(page, family);
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    const lightFill = await tile
      .locator("svg rect")
      .first()
      .getAttribute("fill");
    const palette = getSymmitriPalette(family);
    if (!palette) throw new Error("Missing paired palette");
    expect(lightFill).toBe(`hsl(${hexToHsl(palette.background)})`);
    await page.emulateMedia({ colorScheme: "dark" });
    await expectTheme(page, `${family}-dark`);
    expect(await page.evaluate(() => localStorage.getItem("buzz-theme"))).toBe(
      family,
    );
    expect(
      await page.evaluate(() => localStorage.getItem("buzz-follow-system")),
    ).toBe("true");
    await page.reload();
    await expectTheme(page, `${family}-dark`);
    expect(await page.evaluate(() => localStorage.getItem("buzz-theme"))).toBe(
      family,
    );
    expect(
      await page.evaluate(() => localStorage.getItem("buzz-follow-system")),
    ).toBe("true");
    await page.emulateMedia({ colorScheme: "light" });
    await expectTheme(page, family);
    if (!(await page.getByTestId("settings-theme").isVisible())) {
      await openSettings(page, "appearance");
    }
    if (
      (await page
        .getByTestId("theme-style-trigger")
        .getAttribute("aria-expanded")) !== "true"
    ) {
      await page.getByTestId("theme-style-trigger").click();
    }
    await page.getByTestId("theme-pair-github-light").click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--primary"),
        ),
      )
      .toBe(hexToHsl(SAVED_ACCENT));
  });
}
