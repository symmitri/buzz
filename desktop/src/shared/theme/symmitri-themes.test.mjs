// Symmitri modification: opt-in branded themes through the existing appearance contract.
import assert from "node:assert/strict";
import test from "node:test";
import { codeToTokens } from "shiki";
import { createThemeVars, hexToHsl, luminance } from "./adaptive-theme.ts";
import { getSymmitriPalette } from "./symmitri-themes.ts";
import {
  SYNTAX_THEMES,
  extractThemeInfo,
  getThemePair,
  isLightTheme,
  loadThemeData,
  resolveShikiThemeName,
  resolveSystemTheme,
} from "./theme-loader.ts";
import {
  DEFAULT_COMMUNITY_THEME,
  parseCommunityThemePreference,
} from "./communityThemePreference.ts";

const names = [
  "symmitri",
  "symmitri-dark",
  "symmitri-classic",
  "symmitri-classic-dark",
];
const contrast = (a, b) =>
  (Math.max(luminance(a), luminance(b)) + 0.05) /
  (Math.min(luminance(a), luminance(b)) + 0.05);

for (const name of names) {
  test(`${name}: real loader supplies readable UI, semantic colors and syntax`, async () => {
    assert.ok(SYNTAX_THEMES.includes(name));
    const palette = getSymmitriPalette(name);
    const info = extractThemeInfo(name, await loadThemeData(name));
    const { vars, isDark } = createThemeVars(
      info.bg,
      info.fg,
      info.comment,
      info,
      name,
    );
    assert.equal(isDark, !isLightTheme(name));
    assert.equal(vars["--background"], hexToHsl(palette.background));
    assert.equal(vars["--sidebar-background"], hexToHsl(palette.sidebar));
    assert.equal(vars["--ring"], hexToHsl(palette.accent));
    assert.equal(vars["--sidebar-ring"], hexToHsl(palette.accent));
    for (const foreground of [
      info.fg,
      info.comment,
      info.added,
      info.deleted,
      info.modified,
      palette.accent,
    ]) {
      for (const background of [
        palette.background,
        palette.sidebar,
        palette.surface,
      ]) {
        assert.ok(
          contrast(foreground, background) >= 4.5,
          `${name}: ${foreground} on ${background} needs 4.5:1`,
        );
      }
    }
    for (const background of [palette.background, palette.sidebar]) {
      assert.ok(
        contrast(palette.input, background) >= 3,
        `${name}: input boundary needs 3:1`,
      );
    }
    assert.ok(
      Math.max(
        contrast(palette.accent, "#ffffff"),
        contrast(palette.accent, "#000000"),
      ) >= 4.5,
    );
    const highlighted = await codeToTokens("const ready = true;", {
      lang: "typescript",
      theme: resolveShikiThemeName(name),
    });
    assert.ok(
      new Set(highlighted.tokens.flat().map((token) => token.color)).size > 1,
    );
    for (const token of highlighted.tokens.flat()) {
      if (!token.content.trim()) continue;
      assert.ok(
        contrast(token.color, palette.surface) >= 4.5,
        `${name}: code token ${token.color} needs 4.5:1`,
      );
    }
  });

  test(`${name}: paired System resolution and existing preference format round-trip`, () => {
    const pair = getThemePair(name);
    assert.equal(getThemePair(pair), name);
    assert.equal(isLightTheme(resolveSystemTheme(name, false)), true);
    assert.equal(isLightTheme(resolveSystemTheme(name, true)), false);
    const saved = {
      version: 1,
      theme: name,
      accent: "#06b6d4",
      followSystem: true,
    };
    assert.deepEqual(parseCommunityThemePreference(saved), saved);
    assert.equal(DEFAULT_COMMUNITY_THEME.theme, "buzz");
  });
}

test("existing themes keep their identities, pairs and Shiki palette", async () => {
  assert.deepEqual(SYNTAX_THEMES.slice(0, 2), ["buzz", "buzz-dark"]);
  assert.equal(getThemePair("buzz"), "buzz-dark");
  assert.equal(getThemePair("github-light"), "github-dark");
  assert.equal(resolveShikiThemeName("buzz"), "github-light");
  assert.equal(resolveShikiThemeName("houston"), "houston");
  assert.equal(getSymmitriPalette("houston"), undefined);
  const original = extractThemeInfo(
    "github-light",
    await loadThemeData("github-light"),
  );
  const vars = createThemeVars(
    original.bg,
    original.fg,
    original.comment,
    original,
  );
  assert.deepEqual(
    createThemeVars(
      original.bg,
      original.fg,
      original.comment,
      original,
      "github-light",
    ),
    vars,
  );
});
