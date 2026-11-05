import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { build, preview } from "vite";
import { assertFixtureBase } from "./prepare-fixture-apps";

const root = process.cwd();
const out = resolve(process.env.MCP_GATEWAY_UI_OUTPUT ?? ".cache/update-acceptance/ui");
const bundle = resolve(out, "bundle");
await assertFixtureBase(out);
await mkdir(dirname(out), { recursive: true });
await mkdir(out, { mode: 0o700 });
await mkdir(resolve(".cache/tmp"), { recursive: true });
process.env.TMPDIR = resolve(root, ".cache/tmp");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/playwright");
await build({
  root,
  base: "/",
  build: {
    outDir: bundle,
    emptyOutDir: true,
    rollupOptions: { input: resolve(root, "tests/ui/index.html") },
  },
});
const server = await preview({
  root,
  build: { outDir: bundle },
  preview: { host: "127.0.0.1", port: 0, open: false },
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 960 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Preview unavailable");
  await page.goto(`http://127.0.0.1:${address.port}/tests/ui/index.html`);
  await expect(page.getByRole("heading", { name: "No servers configured" })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.screenshot({ path: resolve(out, "updates-desktop-idle.png"), fullPage: true });

  await page.evaluate(() =>
    window.uiFixture.setUpdate({
      supported: true,
      installationEnabled: false,
      automaticUpdates: true,
      installedVersion: "0.3.1",
      availableVersion: "0.3.2",
      availableHash: "next123456",
      readyVersion: null,
      phase: "available",
      recoveryRequired: false,
      recoveryPath: null,
      error: null,
      preferenceError: null,
      checkedAt: new Date().toISOString(),
    }),
  );
  await page.waitForTimeout(2300);
  await expect(page.getByText("Version 0.3.2 is available.")).toBeVisible();
  await page.screenshot({ path: resolve(out, "updates-desktop-available.png"), fullPage: true });

  await page.evaluate(() =>
    window.uiFixture.setUpdate({
      supported: true,
      installationEnabled: true,
      automaticUpdates: true,
      installedVersion: "0.3.1",
      availableVersion: "0.3.2",
      availableHash: "next123456",
      readyVersion: "0.3.2",
      phase: "ready",
      recoveryRequired: false,
      recoveryPath: null,
      error: null,
      preferenceError: null,
      checkedAt: new Date().toISOString(),
    }),
  );
  await page.waitForTimeout(2300);
  await expect(page.getByRole("button", { name: "Restart to Update" })).toBeEnabled();
  await page.screenshot({ path: resolve(out, "updates-desktop-ready.png"), fullPage: true });
  await expect(page.getByText(/Logs and unsaved drafts remain available only in/)).toBeVisible();
  const restart = page.getByRole("button", { name: "Restart to Update", exact: true });
  await restart.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Restart to update?" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(restart).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(out, "updates-narrow-ready.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.evaluate(() =>
    window.uiFixture.setUpdate({
      supported: true,
      installationEnabled: true,
      automaticUpdates: true,
      installedVersion: "0.3.1",
      availableVersion: "0.3.2",
      availableHash: "next123456",
      readyVersion: null,
      phase: "error",
      recoveryRequired: false,
      recoveryPath: null,
      error: "The downloaded application signature was rejected.",
      preferenceError: null,
      checkedAt: new Date().toISOString(),
    }),
  );
  await page.waitForTimeout(2300);
  await expect(page.getByRole("button", { name: "Retry Download" })).toBeVisible();
  await page.screenshot({ path: resolve(out, "updates-narrow-error.png"), fullPage: true });

  await page.evaluate(() =>
    window.uiFixture.setUpdate({
      supported: true,
      installationEnabled: false,
      automaticUpdates: false,
      installedVersion: "0.3.1",
      availableVersion: "0.3.2",
      availableHash: "next123456",
      readyVersion: null,
      phase: "downloading",
      recoveryRequired: false,
      recoveryPath: null,
      error: null,
      preferenceError: null,
      checkedAt: null,
    }),
  );
  await page.waitForTimeout(2300);
  await expect(page.getByRole("progressbar", { name: "Update progress" })).toBeVisible();
  await page.screenshot({ path: resolve(out, "updates-narrow-progress.png"), fullPage: true });
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ ok: true, screenshots: 6, keyboardRestartCancel: true, errors }));
} finally {
  await browser?.close();
  await new Promise<void>((resolveClose, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolveClose())),
  );
  await rm(bundle, { recursive: true, force: true });
}
