import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  outputDir: "tests/e2e/artifacts",
  reporter: "list",
  use: {
    headless: true,
    viewport: { width: 1280, height: 960 },
    channel: "chrome",
  },
});
