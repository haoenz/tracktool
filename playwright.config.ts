import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  // Suites share a temporary archive and global render fault fixtures.
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:18765",
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
  webServer: {
    command: "node tests/e2e/server.ts",
    url: "http://127.0.0.1:18765/settings",
    reuseExistingServer: false,
  },
});
