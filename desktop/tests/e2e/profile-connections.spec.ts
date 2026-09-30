import { expect, test, type Page } from "@playwright/test";
import { installFakeCamera } from "../helpers/fakeCamera";
import {
  connectionEntry,
  connectionsFixture,
} from "../fixtures/profileConnections";
import { catalogLogoExpectations } from "../fixtures/connectionProviderLogos";
import { installMockBridge, openCreateChannelDialog } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import { openSettings } from "../helpers/settings";

function logoConnectionsFixture() {
  const snapshot = connectionsFixture();
  snapshot.entries.push(
    ...(
      [
        ["granola-mcp", "Granola", "granola-mcp", "identity"],
        ["github", "GitHub", "github", "organisation"],
        ["vercel", "Vercel", "vercel", "organisation"],
        ["custom-provider", "Custom connection", "custom-provider", "identity"],
      ] as const
    ).map(([id, name, provider, scope]) =>
      connectionEntry({
        connection_id: id,
        alias: id,
        name,
        provider,
        credential_scope: scope,
        setup: { kind: "none", connector_id: id, browser_supported: false },
      }),
    ),
  );
  return snapshot;
}

async function prepare(
  page: Page,
  mode: "light" | "dark",
  snapshot = connectionsFixture(),
) {
  await page.emulateMedia({ colorScheme: mode, reducedMotion: "reduce" });
  await page.addInitScript(
    ({ mode }) => {
      localStorage.setItem(
        "buzz-theme",
        mode === "dark" ? "symmitri-dark" : "symmitri",
      );
      localStorage.setItem("buzz-follow-system", "false");
    },
    { mode },
  );
  await installMockBridge(page);
  await page.goto("/");
  await page.getByTestId("open-settings").waitFor();
  await page.evaluate((snapshot) => {
    const internal = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args?: unknown) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    const original = internal.invoke;
    internal.invoke = async (command, args) => {
      if (command === "spaces_read_connections")
        return { state: "ready", snapshot };
      if (command === "spaces_cancel_connections") return null;
      return original(command, args);
    };
  }, snapshot);
  await openSettings(page, "profile");
}

for (const mode of ["light", "dark"] as const) {
  test(`${mode}: native profile tabs retain draft and connections are keyboard accessible`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await prepare(page, mode, logoConnectionsFixture());
    await page.getByTestId("profile-metadata-edit").click();
    const description = page.getByTestId("profile-about");
    await description.fill("My unsaved profile draft");
    const tab = page.getByRole("tab", { name: "Overview", exact: true });
    await tab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("tab", { name: "Connections", exact: true }),
    ).toBeFocused();
    const row = page.getByTestId("profile-connection-google-workspace");
    await expect(row).toBeVisible();
    await expect(row.locator("summary")).toHaveAccessibleName(
      /^Google Workspace\./,
    );
    await expect(
      page.getByRole("tab", { name: "Connections", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    for (const [id, brand, themed, file] of [
      ["google-workspace", "google", false, "google.svg"],
      ["linear", "linear", false, "linear.svg"],
      ["notion", "notion", false, "notion.svg"],
      ["slack", "slack", false, "slack.svg"],
      ["granola-mcp", "granola", true, `granola-${mode}.svg`],
      ["github", "github", true, `github_${mode}.svg`],
      [
        "vercel",
        "vercel",
        true,
        mode === "dark" ? "vercel_dark.svg" : "vercel.svg",
      ],
    ] as const) {
      const logo = page
        .getByTestId(`profile-connection-${id}`)
        .locator(`[data-provider-logo="${brand}"]`);
      await logo.scrollIntoViewIfNeeded();
      const visibleImage = logo.locator("img:visible");
      await expect(visibleImage).toHaveCount(1);
      await expect(visibleImage).toHaveAttribute(
        "data-logo-theme",
        themed ? mode : "any",
      );
      await expect(visibleImage).toHaveAttribute(
        "src",
        `/connection-logos/${file}`,
      );
      await expect
        .poll(() =>
          visibleImage.evaluate((element) => {
            const image = element as HTMLImageElement;
            const url = new URL(image.currentSrc, location.href);
            return (
              image.complete &&
              image.naturalWidth > 0 &&
              url.origin === location.origin &&
              url.pathname.startsWith("/connection-logos/")
            );
          }),
        )
        .toBe(true);
    }
    const unknown = page.getByTestId("profile-connection-custom-provider");
    await expect(
      unknown.getByRole("heading", { name: "Custom connection", exact: true }),
    ).toBeVisible();
    await expect(unknown.locator("summary")).toHaveAccessibleName(
      /^Custom connection\./,
    );
    await expect(
      unknown.locator('[data-provider-logo="unknown"]'),
    ).toBeVisible();
    await expect(unknown.locator("img")).toHaveCount(0);
    await row.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(
      row.getByText("alex@example.test", { exact: true }),
    ).toBeVisible();
    await expect(row.getByRole("switch")).toHaveAccessibleName(
      "Enable Google Workspace for me",
    );
    await waitForAnimations(page);
    await page.screenshot({
      path: `test-results/profile-connections/${mode}-connections.png`,
      fullPage: true,
    });
    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await expect(description).toHaveValue("My unsaved profile draft");
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    await expect(row).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const mode of ["light", "dark"] as const) {
  test(`${mode}: every catalog logo loads locally across bounded pages and exact aliases`, async ({
    page,
  }) => {
    const snapshot = connectionsFixture();
    snapshot.accounts = [];
    const expected = [
      ...catalogLogoExpectations.map(([id, brand, light, dark]) => ({
        id,
        provider: id,
        alias: id,
        connectorId: "",
        brand,
        light,
        dark,
      })),
      {
        id: "custom-notion-alias",
        provider: "custom",
        alias: "notion",
        connectorId: "",
        brand: "notion",
        light: "/connection-logos/notion.svg",
        dark: "",
      },
      {
        id: "provider-precedes-alias",
        provider: "github",
        alias: "notion",
        connectorId: "notion",
        brand: "github",
        light: "/connection-logos/github_light.svg",
        dark: "/connection-logos/github_dark.svg",
      },
      {
        id: "GitHub",
        provider: "custom",
        alias: "tenant-tool",
        connectorId: "",
        brand: "unknown",
        light: "",
        dark: "",
      },
    ];
    snapshot.entries = expected.map((item, index) =>
      connectionEntry({
        connection_id: `logo-${index}`,
        alias: item.alias,
        name: `${String(index).padStart(3, "0")} · ${item.id}`,
        provider: item.provider,
        credential_scope: "organisation",
        auth_mode: "bearer",
        entitlement: "denied",
        activation: { enabled: false, source: "default", version: 0 },
        readiness: "unavailable",
        setup: {
          kind: "none",
          connector_id: item.connectorId,
          browser_supported: false,
        },
      }),
    );
    await prepare(page, mode, snapshot);
    await page.getByRole("tab", { name: "Connections", exact: true }).click();
    for (let offset = 0; offset < expected.length; offset += 40) {
      await expect(
        page.locator('[data-testid^="profile-connection-"]'),
      ).toHaveCount(Math.min(40, expected.length - offset));
      for (const [index, item] of expected
        .slice(offset, offset + 40)
        .entries()) {
        const row = page.getByTestId(
          `profile-connection-logo-${offset + index}`,
        );
        const logo = row.locator(`[data-provider-logo="${item.brand}"]`);
        await logo.scrollIntoViewIfNeeded();
        await expect(logo).toBeVisible();
        if (item.brand === "unknown") {
          await expect(row.locator("img")).toHaveCount(0);
          await expect(row.locator("summary")).toHaveAccessibleName(/GitHub/);
          continue;
        }
        const visibleImage = logo.locator("img:visible");
        await expect(visibleImage).toHaveCount(1);
        await expect(visibleImage).toHaveAttribute(
          "src",
          mode === "dark" && item.dark ? item.dark : item.light,
        );
        await expect(visibleImage).toHaveAttribute(
          "data-logo-theme",
          item.dark ? mode : "any",
        );
        await expect
          .poll(() =>
            visibleImage.evaluate((element) => {
              const image = element as HTMLImageElement;
              return (
                image.complete &&
                image.naturalWidth > 0 &&
                image.naturalHeight > 0 &&
                new URL(image.currentSrc).origin === location.origin
              );
            }),
          )
          .toBe(true);
      }
      if (offset + 40 < expected.length)
        await page.getByRole("button", { name: "Next", exact: true }).click();
    }
  });
}

for (const platform of ["MacIntel", "Linux x86_64"]) {
  test(`${platform}: Profile shortcut stays in Settings and preserves the chat draft`, async ({
    page,
  }) => {
    await page.addInitScript((value) => {
      Object.defineProperty(navigator, "platform", { value });
    }, platform);
    await prepare(page, "light");
    const modifier = platform === "MacIntel" ? "Meta" : "Control";
    await page.getByTestId("settings-nav-appearance").click();
    await page.keyboard.press(`${modifier}+Shift+P`);
    await expect(page.getByTestId("settings-profile-panel")).toBeVisible();
    await page.getByTestId("settings-back-to-app").click();
    await page.getByTestId("channel-general").click();
    const composer = page.getByTestId("message-input");
    await composer.fill("Keep this chat draft");
    await page.keyboard.press(`${modifier}+Shift+P`);
    await expect(page.getByTestId("settings-profile-panel")).toBeVisible();
    await page.keyboard.press(`${modifier}+Shift+P`);
    await expect(page.getByTestId("settings-profile-panel")).toBeVisible();
    await page.keyboard.press(`${modifier}+Comma`);
    await expect(composer).toContainText("Keep this chat draft");
    await openCreateChannelDialog(page);
    const dialog = page.getByTestId("create-channel-dialog");
    const channelName = dialog.getByTestId("create-channel-name");
    await channelName.fill("keep-this-dialog-draft");
    await page.keyboard.press(`${modifier}+Shift+P`);
    await expect(dialog).toBeVisible();
    await expect(channelName).toHaveValue("keep-this-dialog-draft");
    await expect(page.getByTestId("settings-profile-panel")).toHaveCount(0);
  });
}

for (const hideDuring of ["live", "recording", "hidden document"] as const) {
  test(`leaving Overview during ${hideDuring} stops camera capture and preserves text draft`, async ({
    page,
  }) => {
    await installFakeCamera(page);
    await prepare(page, "light");
    await page.evaluate(() => {
      const media = navigator.mediaDevices;
      const original = media.getUserMedia.bind(media);
      const fixture = window as unknown as {
        __PROFILE_CAPTURE_TRACKS__: MediaStreamTrack[];
      };
      fixture.__PROFILE_CAPTURE_TRACKS__ = [];
      Object.defineProperty(media, "getUserMedia", {
        configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          const stream = await original(constraints);
          fixture.__PROFILE_CAPTURE_TRACKS__.push(...stream.getTracks());
          return stream;
        },
      });
    });
    await page.getByTestId("profile-metadata-edit").click();
    await page
      .getByTestId("profile-about")
      .fill("Keep my unsaved profile draft");
    await page.getByTestId("profile-avatar-edit").click();
    await page.getByRole("tab", { name: "Animated", exact: true }).click();
    await page.getByTestId("profile-avatar-animated-camera-computer").click();
    await expect(
      page.getByTestId("profile-avatar-animated-record"),
    ).toBeVisible();
    if (hideDuring === "recording") {
      await page.getByTestId("profile-avatar-animated-record").click();
      await expect(
        page.getByTestId("profile-avatar-animated-timer-ring"),
      ).toBeVisible();
    }
    if (hideDuring === "hidden document") {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } else {
      await page.getByRole("tab", { name: "Connections", exact: true }).click();
      await expect(page.getByTestId("profile-connections")).toBeVisible();
    }
    await expect(page.getByTestId("profile-avatar-animated")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const tracks = (
            window as unknown as {
              __PROFILE_CAPTURE_TRACKS__: MediaStreamTrack[];
            }
          ).__PROFILE_CAPTURE_TRACKS__;
          return (
            tracks.length > 0 &&
            tracks.every((track) => track.readyState === "ended")
          );
        }),
      )
      .toBe(true);
    if (hideDuring === "hidden document") {
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    } else {
      await page.getByRole("tab", { name: "Overview", exact: true }).click();
    }
    await expect(page.getByTestId("profile-avatar-editor-shell")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("profile-about")).toHaveValue(
      "Keep my unsaved profile draft",
    );
  });
}
