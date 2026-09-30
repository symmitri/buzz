// Symmitri modification: native palette choices for Spaces Alpha.
// References: https://www.symmitri.ai/ and https://www.symmitri.ai/brand
// Bright brand colors use darker companions where small text needs contrast.
type SymmitriPalette = {
  baseTheme: "github-light-default" | "github-dark";
  background: string;
  foreground: string;
  muted: string;
  sidebar: string;
  surface: string;
  border: string;
  input: string;
  accent: string;
  added: string;
  deleted: string;
  modified: string;
};

const palettes: Readonly<Record<string, SymmitriPalette>> = {
  symmitri: {
    baseTheme: "github-light-default",
    background: "#faf9f6",
    foreground: "#292925",
    muted: "#686862",
    sidebar: "#f0efe9",
    surface: "#efeaf4",
    border: "#ddddd5",
    input: "#85857a",
    accent: "#76509b",
    added: "#356742",
    deleted: "#a33229",
    modified: "#86600d",
  },
  "symmitri-dark": {
    baseTheme: "github-dark",
    background: "#242420",
    foreground: "#f5f3ea",
    muted: "#b2b0a5",
    sidebar: "#1a1a17",
    surface: "#34332e",
    border: "#45443d",
    input: "#818075",
    accent: "#c2a9da",
    added: "#a8d3ad",
    deleted: "#ff9c8d",
    modified: "#e8c07d",
  },
  "symmitri-classic": {
    baseTheme: "github-light-default",
    background: "#fafaf7",
    foreground: "#101010",
    muted: "#62596b",
    sidebar: "#eee8f5",
    surface: "#e8f2e5",
    border: "#d7cede",
    input: "#8c8098",
    accent: "#7540bc",
    added: "#2c6d37",
    deleted: "#a33229",
    modified: "#86600d",
  },
  "symmitri-classic-dark": {
    baseTheme: "github-dark",
    background: "#101010",
    foreground: "#fafaf7",
    muted: "#bcb5c6",
    sidebar: "#1a1a1a",
    surface: "#2d2d2b",
    border: "#45404d",
    input: "#807588",
    accent: "#b880ff",
    added: "#ccfdbf",
    deleted: "#ff9c8d",
    modified: "#e8c07d",
  },
};

/** Return the fixed branded palette without changing saved accent preferences. */
export function getSymmitriPalette(name: string | undefined) {
  return name && Object.hasOwn(palettes, name) ? palettes[name] : undefined;
}
