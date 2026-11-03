import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { build, preview } from "vite";

const root = process.cwd();
process.env.TMPDIR = resolve(root, ".cache/tmp");
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(root, ".cache/playwright");
const artifacts = resolve(root, "tests/ui/artifacts");
await mkdir(process.env.TMPDIR, { recursive: true });
await mkdir(artifacts, { recursive: true });
const bundle = resolve(root, "tests/ui/.bundle");
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
  const productionHtml = await readFile(resolve(root, "src/mainview/index.html"), "utf8");
  const fixtureHtml = await readFile(resolve(root, "tests/ui/index.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/;
  expect(fixtureHtml.match(csp)?.[1]).toBe(productionHtml.match(csp)?.[1]);
  const page = await browser.newPage({
    viewport: { width: 1280, height: 960 },
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("dialog", (dialog) => void dialog.accept());
  const address = server.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Preview listener unavailable.");
  await page.goto(`http://127.0.0.1:${address.port}/tests/ui/index.html`);
  await expect(page.getByRole("heading", { name: "No servers configured" })).toBeVisible();
  await page.screenshot({ path: `${artifacts}/01-empty.png`, fullPage: true });
  const add = page.getByRole("button", { name: "Add server", exact: true });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(add).toBeFocused();

  await page.getByRole("button", { name: /Bear preset/ }).click();
  await expect(page.getByLabel("Command", { exact: false })).toHaveValue(
    "/Applications/Bear.app/Contents/MacOS/bearcli",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(() => Object.keys(window.uiFixture.state().config.mcpServers)),
  ).toEqual([]);
  await add.click();
  await page.getByLabel("Server name", { exact: false }).fill("local-tools");
  await page.getByLabel("Command", { exact: false }).fill("/usr/bin/synthetic-mcp");
  await page.getByLabel("Arguments (JSON array)").fill("{}");
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Arguments must be a JSON array of strings." }),
  ).toBeVisible();
  await expect(page.getByLabel("Command", { exact: true })).toHaveValue("/usr/bin/synthetic-mcp");
  await page.getByLabel("Arguments (JSON array)").fill('["serve","--label","two words"]');
  await page.getByLabel("Environment (JSON object)").fill('{"MODE":"test"}');
  await page.getByLabel("Working directory", { exact: false }).fill("/synthetic/workspace");
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Configuration saved.", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => window.uiFixture.state().config.mcpServers["local-tools"]),
  ).toEqual({
    command: "/usr/bin/synthetic-mcp",
    args: ["serve", "--label", "two words"],
    env: { MODE: "test" },
    cwd: "/synthetic/workspace",
    disabled: false,
  });

  await add.click();
  await page.getByLabel("Server name", { exact: false }).fill("remote-tools");
  await page.getByLabel("Transport", { exact: true }).selectOption("http");
  await page.getByLabel("Upstream URL", { exact: false }).fill("https://synthetic.example/mcp");
  await page
    .getByLabel("Headers (JSON object)", { exact: false })
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Exercise literal native environment references.
    .fill('{"Authorization":"Bearer ${UPSTREAM_TOKEN}"}');
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Configuration saved.", { exact: true })).toBeVisible();
  const local = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "local-tools", exact: true }) });
  const remote = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "remote-tools", exact: true }) });
  await local.getByRole("button", { name: "Edit server" }).click();
  await page.getByLabel("Arguments (JSON array)").fill('["updated"]');
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await remote.getByRole("button", { name: "Edit server" }).click();
  await page.getByLabel("Upstream URL", { exact: false }).fill("https://synthetic.example/updated");
  await page.getByLabel("Headers (JSON object)", { exact: false }).fill('{"X-Mode":"edited"}');
  await page.getByLabel("Disabled (do not mount this endpoint)").check();
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  expect(
    await page.evaluate(() => window.uiFixture.state().config.mcpServers["remote-tools"]),
  ).toEqual({
    url: "https://synthetic.example/updated",
    headers: { "X-Mode": "edited" },
    disabled: true,
  });
  expect(
    await page.evaluate(() => {
      const server = window.uiFixture.state().config.mcpServers["local-tools"];
      return server && "command" in server ? server.args : [];
    }),
  ).toEqual(["updated"]);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Interface / address", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Port", { exact: true }).fill("");
  await expect(page.getByLabel("Port", { exact: true })).toHaveValue("");
  await page.getByLabel("Port", { exact: true }).fill("9876");
  await page.getByRole("button", { name: "Show bearer token" }).click();
  await expect(page.getByLabel("Bearer token", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "Hide bearer token" }).click();
  await page.getByRole("button", { name: "Generate secure token" }).click();
  await expect(page.getByLabel("Bearer token", { exact: true })).toHaveValue(/^[0-9a-f]{64}$/);
  await page.getByRole("switch", { name: "Launch app at login", exact: false }).check();
  await page
    .getByRole("switch", { name: "Start gateway when the app opens", exact: false })
    .check();
  await expect(
    page.getByText("Actual login registration: Disabled", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Actual login registration: Enabled", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => {
      const gateway = window.uiFixture.state().config.gateway;
      return { ...gateway, token: gateway.token.length };
    }),
  ).toEqual({ host: "127.0.0.1", port: 9876, token: 64, launchAtLogin: true, autoStart: true });
  await page.screenshot({ path: `${artifacts}/02-settings.png`, fullPage: true });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Start gateway", exact: true }).click();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  await local.getByRole("button", { name: "Restart local-tools", exact: true }).click();
  await local.getByRole("button", { name: "Copy endpoint for local-tools", exact: true }).click();
  await local.getByRole("button", { name: "Copy client configuration", exact: false }).click();
  await local.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(local.getByText("Disabled", { exact: true })).toBeVisible();
  await local.getByRole("button", { name: "Start", exact: true }).click();
  await remote.getByRole("button", { name: "Start", exact: true }).click();
  await page.screenshot({ path: `${artifacts}/03-dashboard.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${artifacts}/04-narrow.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await add.click();
  await page.getByLabel("Server name", { exact: false }).fill("keyboard-test");
  await page.screenshot({ path: `${artifacts}/05-narrow-dialog.png`, fullPage: true });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 960 });

  // Polling must retain both an in-progress modal and its original revision.
  const originalRevision = await page.evaluate(() => String(window.uiFixture.state().revision));
  await local.getByRole("button", { name: "Edit server" }).click();
  await page.getByLabel("Command", { exact: false }).fill("/synthetic/draft");
  await page.evaluate(() => window.uiFixture.externalChange());
  await page.waitForTimeout(2300);
  await expect(page.getByLabel("Command", { exact: false })).toHaveValue("/synthetic/draft");
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await page.waitForTimeout(2300);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "StaleRevision" })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        window.uiFixture
          .state()
          .calls.filter((call) => call.action === "save")
          .at(-1)?.expectedRevision,
    ),
  ).toBe(originalRevision);
  await page.getByRole("button", { name: "Authoritative configuration", exact: false }).click();
  await expect(page.getByLabel("mcp.json", { exact: true })).toHaveValue(/\/synthetic\/draft/);
  await page.screenshot({ path: `${artifacts}/06-stale-draft.png`, fullPage: true });
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  const valid = await page.getByLabel("mcp.json", { exact: true }).inputValue();
  await page.getByLabel("mcp.json", { exact: true }).fill('{"unknown":true}');
  await page.getByRole("button", { name: "Save mcp.json", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "InvalidConfig" })).toBeVisible();
  await expect(page.getByLabel("mcp.json", { exact: true })).toHaveValue('{"unknown":true}');
  await page.getByLabel("mcp.json", { exact: true }).fill(valid);
  await page.getByRole("button", { name: "Save mcp.json", exact: true }).click();

  await page.evaluate(() => window.uiFixture.breakConfig());
  await expect(page.getByText("Repair configuration to continue", { exact: true })).toBeVisible({
    timeout: 6000,
  });
  await expect(add).toBeDisabled();
  await expect(page.getByLabel("mcp.json", { exact: true })).toHaveValue('{"unknown":true}');
  await page.getByLabel("mcp.json", { exact: true }).fill(valid);
  await page.getByRole("button", { name: "Save mcp.json", exact: true }).click();

  await local.getByRole("button", { name: "Delete local-tools", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(local).toBeVisible();
  for (const name of ["local-tools", "remote-tools"]) {
    await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
    await page.getByRole("button", { name: "Delete server", exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
  }
  expect(
    await page.evaluate(() => Object.keys(window.uiFixture.state().config.mcpServers)),
  ).toEqual([]);
  await page.getByRole("button", { name: "Start gateway", exact: true }).click();
  await page.getByRole("button", { name: "Stop gateway", exact: true }).click();
  await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
  const actions = await page.evaluate(() =>
    window.uiFixture.state().calls.map((call) => call.action),
  );
  for (const action of ["start", "stop", "restart", "copyEndpoint", "copyClientConfig"])
    expect(actions).toContain(action);
  expect(errors).toEqual([]);
  console.log(
    "PASS: synthetic UI CRUD, preferences, native RPC calls, revision preservation, recovery, keyboard focus, narrow layout; 6 screenshots in tests/ui/artifacts.",
  );
} finally {
  await browser?.close();
  await new Promise<void>((resolveClose, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolveClose())),
  );
  await rm(bundle, { recursive: true, force: true });
}
