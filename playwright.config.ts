import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests of the web SDK as a page embeds it: the README's quick start
 * (the relay on the keyless demo backend, the example shop serving the widget
 * from the relay with one script tag) in Chromium, Firefox and WebKit.
 * Needs `npm run build:sdk` first: the relay serves dist/sdk.
 */
const RELAY_PORT = 8799;
// The example's webhook tool points at port 3000 (examples/web-embed/assistant.config.json).
const SHOP_PORT = 3000;
const secrets = { RELAY_AUTH_TOKEN: "browser-test-relay-secret", TOOL_WEBHOOK_SECRET: "browser-test-webhook-secret" };
// Made once per run: the workers that load this file again inherit it through the environment.
process.env.MAX_BROWSER_TEST_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "max-browser-tests-"));
const relayHome = process.env.MAX_BROWSER_TEST_HOME;

export default defineConfig({
  testDir: "browser-tests",
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: `http://localhost:${SHOP_PORT}`, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }
      }
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        launchOptions: {
          firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true }
        }
      }
    },
    // Playwright's WebKit builds capture from a mock device once the permission is granted.
    { name: "webkit", use: { ...devices["Desktop Safari"], permissions: ["microphone"] } }
  ],
  webServer: [
    {
      command: "npx tsx server/index.ts",
      url: `http://localhost:${RELAY_PORT}/health`,
      reuseExistingServer: false,
      env: {
        ...secrets,
        PORT: String(RELAY_PORT),
        VOICE_PROVIDER: "mock",
        ASSISTANT_CONFIG: "examples/web-embed/assistant.config.json",
        // Keep everything the relay writes (Studio, accounts, QA sessions and release-gate history, usage) out
        // of the developer's home: these mock sessions must not count in real testing metrics.
        HOME: relayHome,
        STUDIO_DIR: relayHome,
        TESTING_DATABASE: "off",
        TESTING_HISTORY_DIR: "off"
      }
    },
    {
      command: "node examples/web-embed/server.mjs",
      url: `http://localhost:${SHOP_PORT}/`,
      reuseExistingServer: false,
      env: { ...secrets, PORT: String(SHOP_PORT), RELAY_URL: `http://localhost:${RELAY_PORT}` }
    }
  ]
});
