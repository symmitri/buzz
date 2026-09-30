import { defineConfig } from "@playwright/test";
import base from "./playwright.perf.config";
export default defineConfig({ ...base, use: { ...base.use, baseURL: "http://127.0.0.1:19423" }, webServer: { command: "python3 -m http.server 19423 --bind 127.0.0.1 --directory alpha-perf-dist", cwd: ".", reuseExistingServer: false, url: "http://127.0.0.1:19423" } });
