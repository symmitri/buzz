import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["profile-connections.spec.ts"],
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 1100 },
    baseURL: "http://127.0.0.1:4257",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "python3 -m http.server 4257 -d dist",
    cwd: ".",
    url: "http://127.0.0.1:4257",
    reuseExistingServer: false,
  },
});
