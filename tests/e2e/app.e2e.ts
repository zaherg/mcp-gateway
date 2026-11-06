import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test as base, expect } from "@playwright/test";
import { parseConfigDocument } from "../../src/shared/config-document";
import type { UpdateStatus } from "../../src/shared/rpc";
import type { GatewaySnapshot, StdioServerConfig } from "../../src/shared/types";

type Bridge = {
  url: string;
  secret: string;
  stdio: StdioServerConfig;
  upstream: { url: string; token: string };
  port: number;
  control<T = { snapshot: GatewaySnapshot; loginCalls: boolean[] }>(params: string): Promise<T>;
};
const test = base.extend<{ bridge: Bridge; scenario: string }>({
  scenario: ["json", { option: true }],
  bridge: async ({ scenario }, use) => {
    const child = spawn("bun", ["tests/e2e/server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, MCP_E2E_CONFIG: scenario },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<number | null>((done) => child.once("exit", done));
    const lines = createInterface({ input: child.stdout });
    try {
      const data = await new Promise<Omit<Bridge, "control">>((done, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`Bridge startup timeout: ${stderr}`)),
          20_000,
        );
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error(`Bridge exited: ${stderr}`));
        });
        lines.on("line", (line) => {
          if (!line.startsWith('{"url":')) return;
          clearTimeout(timeout);
          done(JSON.parse(line));
        });
      });
      await use({
        ...data,
        async control<T>(params: string): Promise<T> {
          const response = await fetch(`${data.url}/control`, {
            method: "POST",
            signal: AbortSignal.timeout(15_000),
            headers: { Authorization: `Bearer ${data.secret}`, "Content-Type": "application/json" },
            body: JSON.stringify({ params }),
          });
          expect(response.status).toBe(200);
          return response.json();
        },
      });
    } finally {
      lines.close();
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 12_000);
      const code = await exited;
      clearTimeout(timeout);
      expect(code, stderr).toBe(0);
    }
  },
});
async function save(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Configuration saved.", { exact: true })).toBeVisible();
}

for (const width of [1280, 390]) {
  test(`locked configuration guidance preserves the draft at ${width}px`, async ({
    page,
    bridge,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${bridge.url}/#${bridge.secret}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const toggle = page.getByRole("switch", { name: "Start gateway when the app opens" });
    await expect(toggle).toBeEnabled();
    const before = (await bridge.control<{ diskText: string }>("inspect")).diskText;
    await bridge.control("config-lock");
    await toggle.check();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "ConfigLocked" });
    await expect(alert).toContainText(
      "quit every app instance and confirm no writer is active before removing it and retrying",
    );
    await expect(toggle).toBeChecked();
    expect((await bridge.control<{ diskText: string }>("inspect")).diskText).toBe(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await alert.scrollIntoViewIfNeeded();
    await bridge.control("config-unlock");
    await save(page);
    expect((await bridge.control<{ diskText: string }>("inspect")).diskText).not.toBe(before);
  });

  test(`interactive native Quit intent protects an open dialog at ${width}px`, async ({
    page,
    bridge,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${bridge.url}/#${bridge.secret}`);
    await expect(page.getByRole("button", { name: "Add server", exact: true })).toBeEnabled();
    const before = (await bridge.control("inspect")).snapshot.configText;
    await page.getByRole("button", { name: "Add server", exact: true }).click();
    const name = page.getByLabel("Server name", { exact: false });
    await name.fill("retained-dialog");
    const command = page.getByLabel("Command", { exact: true });
    await command.fill("/synthetic/retained");
    await command.focus();
    expect(
      await page.evaluate(
        () => !window.dispatchEvent(new Event("mcp-gateway:request-quit", { cancelable: true })),
      ),
    ).toBe(true);
    const confirm = page.getByRole("dialog", { name: "Quit MCP Gateway?" });
    await expect(confirm).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new Event("mcp-gateway:request-quit", { cancelable: true })),
    );
    await expect(confirm).toHaveCount(1);
    await expect(confirm.getByRole("button", { name: "Discard changes and quit" })).toBeEnabled();
    await page.keyboard.press("Tab");
    expect(await confirm.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `.cache/src-audit-a7-a11/quit-confirm-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(confirm).not.toBeVisible();
    await expect(command).toBeFocused();
    await expect(name).toHaveValue("retained-dialog");
    await expect(command).toHaveValue("/synthetic/retained");
    expect((await bridge.control("inspect")).snapshot.configText).toBe(before);
    await bridge.control("quit-hold");
    await page.evaluate(() =>
      window.dispatchEvent(new Event("mcp-gateway:request-quit", { cancelable: true })),
    );
    await confirm.getByRole("button", { name: "Discard changes and quit" }).click();
    await expect(command).toHaveAttribute("readonly");
    await expect(name).toHaveValue("retained-dialog");
    expect((await bridge.control("inspect")).snapshot.configText).toBe(before);
    await bridge.control("quit-release");
  });
}

test("real App CRUD, gateway, MCP transports, login preferences and close cleanup", async ({
  page,
  bridge,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await expect(page.getByRole("heading", { name: "No servers configured" })).toBeVisible();
  const add = page.getByRole("button", { name: "Add server", exact: true });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(add).toBeFocused();
  expect((await fetch(`${bridge.url}/rpc/start`, { method: "POST", body: "{}" })).status).toBe(403);
  for (const name of ["local", "remote"]) {
    await page.getByRole("button", { name: "Add server", exact: true }).click();
    await page.getByLabel("Server name", { exact: false }).fill(name);
    if (name === "local") {
      await page.getByLabel("Command", { exact: true }).fill(bridge.stdio.command);
      await page.getByLabel("Arguments (JSON array)").fill(JSON.stringify(bridge.stdio.args));
      await page.getByLabel("Environment (JSON object)").fill(JSON.stringify(bridge.stdio.env));
    } else {
      await page.getByLabel("Transport", { exact: true }).selectOption("http");
      await page.getByLabel("Upstream URL", { exact: false }).fill(bridge.upstream.url);
      await page
        .getByLabel("Headers (JSON object)")
        .fill(JSON.stringify({ Authorization: `Bearer ${bridge.upstream.token}` }));
    }
    await page.getByRole("button", { name: "Apply to draft" }).click();
    await save(page);
  }
  for (const name of ["local", "remote"]) {
    const card = page
      .getByRole("article")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await card.getByRole("button", { name: "Edit server" }).click();
    await page.getByLabel("Disabled (do not mount this endpoint)").check();
    await page.getByRole("button", { name: "Apply to draft" }).click();
    await save(page);
    await card.getByRole("button", { name: "Start", exact: true }).click();
    await expect(card.getByText("Stopped", { exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Port", { exact: true }).fill(String(bridge.port));
  await page.getByRole("switch", { name: "Launch app at login", exact: false }).check();
  await page
    .getByRole("switch", { name: "Start gateway when the app opens", exact: false })
    .check();
  await expect(
    page.getByText("Actual login registration: Disabled", { exact: true }),
  ).toBeVisible();
  await save(page);
  await expect(page.getByText("Actual login registration: Enabled", { exact: true })).toBeVisible();
  const stored = await bridge.control("inspect");
  expect(stored.loginCalls).toEqual([true]);
  expect(stored.snapshot.running).toBe(false);
  expect(JSON.parse(stored.snapshot.configText).gateway).toMatchObject({
    autoStart: true,
    launchAtLogin: true,
    port: bridge.port,
  });
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.getByRole("button", { name: "Start gateway", exact: true }).click();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  const probes =
    await bridge.control<Array<{ name: string; tools: string[]; value: string }>>("probe");
  expect(probes.map((probe) => [probe.name, probe.value])).toEqual([
    ["local", "e2e-local"],
    ["remote", "e2e-remote"],
  ]);
  for (const probe of probes) expect(probe.tools).toContain("echo");
  const local = page.getByRole("article").filter({
    has: page.getByRole("heading", { name: "local", exact: true }),
  });
  await local.getByRole("button", { name: "Restart local", exact: true }).click();
  await expect(page.getByText("local restarted.", { exact: true })).toBeVisible();
  await local.getByRole("button", { name: "Copy endpoint for local" }).click();
  await local.getByRole("button", { name: "Copy client configuration", exact: false }).click();
  await expect
    .poll(async () => (await bridge.control<{ copied: string[] }>("inspect")).copied.length)
    .toBe(2);
  const { copied } = await bridge.control<{ copied: string[] }>("inspect");
  expect(copied[0]).toBe(
    stored.snapshot.servers.find((server) => server.name === "local")?.endpoint,
  );
  expect(JSON.parse(copied[1] ?? "").mcpServers.local.url).toBe(copied[0]);
  await page.getByRole("button", { name: "Stop gateway", exact: true }).click();
  await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Delete local", exact: true }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(local).toBeVisible();
  for (const name of ["local", "remote"]) {
    await page.getByRole("button", { name: `Delete ${name}`, exact: true }).click();
    await page.getByRole("button", { name: "Delete server", exact: true }).click();
    await save(page);
  }
  expect(JSON.parse((await bridge.control("inspect")).snapshot.configText).mcpServers).toEqual({});
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  await page.getByLabel("Server name", { exact: false }).fill("local");
  await page.getByLabel("Command", { exact: true }).fill(bridge.stdio.command);
  await page.getByLabel("Arguments (JSON array)").fill(JSON.stringify(bridge.stdio.args));
  await page.getByLabel("Environment (JSON object)").fill(JSON.stringify(bridge.stdio.env));
  await page.getByRole("button", { name: "Apply to draft" }).click();
  await save(page);
  await page.getByRole("button", { name: "Start gateway", exact: true }).click();
  expect(await bridge.control("hold")).toEqual({ livePids: 1 });
  expect(await bridge.control("close")).toEqual({
    closed: true,
    livePids: [],
  });
  expect(errors).toEqual([]);
  console.log(
    "Browser E2E uses real AppService/controller/store and synthetic MCP; Electrobun RPC/window lifecycle remains covered only by scripts/check-native.ts.",
  );
});

test("external CAS conflict preserves draft; invalid disk config recovers through authoritative editor", async ({
  page,
  bridge,
}) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const valid = (await bridge.control("inspect")).snapshot.configText;
  await page.getByLabel("Port", { exact: true }).fill(String(bridge.port));
  await bridge.control("external");
  await expect
    .poll(async () => (await bridge.control("inspect")).snapshot.configText)
    .not.toBe(valid);
  await page.waitForTimeout(2200); // Cross one real App polling interval while a draft is dirty.
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "StaleRevision" })).toBeVisible();
  await expect(page.getByLabel("Port", { exact: true })).toHaveValue(String(bridge.port));
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await bridge.control("invalid");
  await expect(
    page.getByRole("alert").filter({ hasText: "Configuration unavailable" }),
  ).toBeVisible({ timeout: 8000 });
  await page.getByRole("button", { name: "Authoritative configuration", exact: false }).click();
  const raw = page.getByLabel("mcp.json", { exact: true });
  await expect(raw).toHaveValue('{"unknown":true}');
  await raw.fill('{"stillInvalid":true}');
  await page.getByRole("button", { name: "Save mcp.json", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "InvalidConfig" })).toBeVisible();
  await expect(raw).toHaveValue('{"stillInvalid":true}');
  await raw.fill(valid);
  await page.getByRole("button", { name: "Save mcp.json", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Configuration unavailable" }),
  ).not.toBeVisible();
});

test("cancelling an invalidated editor returns keyboard focus to configuration recovery", async ({
  page,
  bridge,
}) => {
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  const add = page.getByRole("button", { name: "Add server", exact: true });
  await add.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeVisible();
  await bridge.control("invalid");
  await expect(page.getByText(/The configuration changed outside this window/)).toBeAttached({
    timeout: 8000,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(add).toBeDisabled();
  const recovery = page.getByRole("button", { name: /Authoritative configuration/ });
  await expect(recovery).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("mcp.json", { exact: true })).toHaveValue('{"unknown":true}', {
    timeout: 8000,
  });
  expect((await bridge.control<{ diskText: string }>("inspect")).diskText).toBe('{"unknown":true}');
});

test.describe("JSONC document editing", () => {
  test.use({ scenario: "jsonc" });
  test("loads JSONC, preserves comments on gateway/server edits and rename, refuses ambiguity", async ({
    page,
    bridge,
  }) => {
    await page.goto(`${bridge.url}/#${bridge.secret}`);
    const original = (await bridge.control<{ diskText: string }>("inspect")).diskText;
    await expect(page.getByRole("heading", { name: "remote", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Edit server", exact: true }).click();
    await page.getByLabel("Server name", { exact: false }).fill("renamed");
    await page
      .getByLabel("Upstream URL", { exact: false })
      .fill("https://synthetic.example/edited");
    await page.getByRole("button", { name: "Apply to draft" }).click();
    await save(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Port", { exact: true }).fill(String(bridge.port));
    await save(page);
    const stored = await bridge.control<{ diskText: string; snapshot: GatewaySnapshot }>("inspect");
    expect(stored.snapshot.configFormat).toBe("jsonc");
    expect(stored.snapshot.configPath).toMatch(/mcp\.jsonc$/);
    expect(stored.diskText).toBe(
      original
        .replace('"remote":', '"renamed":')
        .replace("https://synthetic.example/mcp", "https://synthetic.example/edited")
        .replace(
          String(
            (parseConfigDocument(original, "jsonc") as { gateway: { port: number } }).gateway.port,
          ),
          String(bridge.port),
        ),
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Preserve a source environment reference, not an expanded secret.
    expect(stored.diskText).toContain("${MCP_E2E_TOKEN}");
    expect(stored.diskText).not.toContain("synthetic-reference-source");
    await page.getByRole("button", { name: /Authoritative configuration/ }).click();
    // Textarea DOM values normalize CRLF; the disk assertion above remains byte-exact.
    await expect(page.getByLabel("mcp.jsonc", { exact: true })).toHaveValue(
      stored.diskText.replaceAll("\r\n", "\n"),
    );
    await expect(
      page.getByText("JSONC accepts // and /* */ comments and trailing commas.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Start gateway", exact: true }).click();
    await expect(page.getByText("Running", { exact: true })).toBeVisible();
    await bridge.control("ambiguous");
    await expect
      .poll(async () => (await bridge.control("inspect")).snapshot.configError?.code)
      .toBe("AmbiguousConfig");
    expect((await bridge.control("inspect")).snapshot.running).toBe(false);
    await expect(page.getByRole("button", { name: "Start gateway", exact: true })).toBeDisabled();
    const raw = page.getByLabel("mcp.jsonc", { exact: true });
    await raw.fill(`${stored.diskText}\n`);
    await page.getByRole("button", { name: "Save mcp.jsonc", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "AmbiguousConfig" })).toBeVisible();
    expect((await bridge.control<{ diskText: string }>("inspect")).diskText).toBe(stored.diskText);
  });
});

test("page and modal suppress edge overscroll while ordinary scrolling remains available", async ({
  page,
  bridge,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await expect(page.getByRole("heading", { name: "No servers configured" })).toBeVisible();
  const metrics = () =>
    page.evaluate(() => ({
      top: window.scrollY,
      max: document.documentElement.scrollHeight - window.innerHeight,
      htmlPolicy: getComputedStyle(document.documentElement).overscrollBehaviorY,
      bodyPolicy: getComputedStyle(document.body).overscrollBehaviorY,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
    }));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(350, 180);
  await page.mouse.wheel(0, -1500);
  await page.waitForTimeout(150);
  expect(await metrics()).toMatchObject({
    top: 0,
    htmlPolicy: "none",
    bodyPolicy: "none",
    htmlBackground: "rgb(247, 249, 251)",
    bodyBackground: "rgb(247, 249, 251)",
  });
  await page.screenshot({ path: "tests/e2e/artifacts/overscroll-top.png", fullPage: false });
  await page.mouse.wheel(0, 250);
  await expect.poll(async () => (await metrics()).top).toBeGreaterThan(0);
  await page.mouse.wheel(0, 10000);
  await expect
    .poll(async () => {
      const m = await metrics();
      return m.top - m.max;
    })
    .toBe(0);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(150);
  const bottom = await metrics();
  expect(bottom.top).toBe(bottom.max);
  await page.screenshot({ path: "tests/e2e/artifacts/overscroll-bottom.png", fullPage: false });
  await page.getByRole("button", { name: "Add server", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const dialogMetrics = () =>
    dialog.evaluate((element) => ({
      top: element.scrollTop,
      max: element.scrollHeight - element.clientHeight,
      policy: getComputedStyle(element).overscrollBehaviorY,
    }));
  expect((await dialogMetrics()).policy).toBe("none");
  expect((await dialogMetrics()).max).toBeGreaterThan(0);
  await dialog.evaluate((element) => element.scrollTo(0, 0));
  await dialog.hover({ position: { x: 280, y: 100 } });
  await page.mouse.wheel(0, -1000);
  await page.waitForTimeout(150);
  expect((await dialogMetrics()).top).toBe(0);
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => (await dialogMetrics()).top).toBeGreaterThan(0);
  await page.mouse.wheel(0, 10000);
  await expect
    .poll(async () => {
      const m = await dialogMetrics();
      return m.top - m.max;
    })
    .toBe(0);
  await page.mouse.wheel(0, 1500);
  await page.waitForTimeout(150);
  const modalBottom = await dialogMetrics();
  expect(modalBottom.top).toBe(modalBottom.max);
  await page.screenshot({
    path: "tests/e2e/artifacts/overscroll-dialog-bottom.png",
    fullPage: false,
  });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("local Logs retain raw synthetic backend values, filter and clear without clearing failures; banners dismiss by occurrence", async ({
  page,
  bridge,
}) => {
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await expect(page.getByRole("heading", { name: "No servers configured" })).toBeVisible();
  await bridge.control("logs-benign");
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  expect((await bridge.control("inspect")).snapshot.operationalError).toBeNull();
  await page.getByRole("button", { name: "Logs", exact: true }).click();
  const entries = page.getByLabel("Diagnostic entries");
  await expect(entries).toContainText("synthetic-local-password=fixture-only");
  // Modern 2026-07-28 protocol bodies are never logged; only fixture stderr is.
  await expect(entries).not.toContainText("<script>synthetic-note</script>");
  await expect(page.getByText("Sensitive data:", { exact: true })).toBeVisible();
  await page.getByLabel("Level", { exact: true }).selectOption("error");
  await page.getByLabel("Server", { exact: true }).selectOption("echo");
  await page.getByLabel("Search text").fill("synthetic-local-password");
  await expect(entries.locator("article")).toHaveCount(1);
  await expect(entries).toContainText("stderr");
  await page.screenshot({ path: "tests/e2e/artifacts/logs-desktop.png", fullPage: true });
  await page.getByLabel("Search text").fill("no-such-synthetic-value");
  await expect(entries).toContainText("No entries match these filters.");
  await page.getByLabel("Search text").fill("");
  await bridge.control("logs-failure");
  const failure = page.getByRole("alert").filter({ hasText: "ENOENT" });
  await expect(failure).toBeVisible();
  const before = (await bridge.control("inspect")).snapshot.operationalError;
  expect(before?.message).not.toContain("synthetic-missing");
  expect(JSON.stringify((await bridge.control("inspect")).snapshot.events)).not.toContain(
    "fixture-only",
  );
  await failure.getByRole("button", { name: "Dismiss error" }).click();
  await page.waitForTimeout(2300);
  await expect(failure).not.toBeVisible();
  expect((await bridge.control("inspect")).snapshot.operationalError?.occurrenceId).toBe(
    before?.occurrenceId,
  );
  await page.getByRole("button", { name: "Clear logs", exact: true }).click();
  await expect(entries).toContainText("No log entries yet.");
  expect((await bridge.control("inspect")).snapshot.operationalError?.occurrenceId).toBe(
    before?.occurrenceId,
  );
  await bridge.control("logs-failure");
  await expect(failure).toBeVisible({ timeout: 8000 });
  expect((await bridge.control("inspect")).snapshot.operationalError?.occurrenceId).not.toBe(
    before?.occurrenceId,
  );
  await expect(entries).toContainText("synthetic-missing");
  await page.setViewportSize({ width: 390, height: 650 });
  await page.screenshot({ path: "tests/e2e/artifacts/logs-error-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await bridge.control("invalid");
  const configError = page.getByRole("alert").filter({ hasText: "Configuration unavailable" });
  await expect(configError).toBeVisible();
  await configError.getByRole("button", { name: "Dismiss error" }).click();
  await page.waitForTimeout(2300);
  await expect(configError).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Start gateway", exact: true })).toBeDisabled();
  await bridge.control("invalid-again");
  await expect(configError).toBeVisible({ timeout: 8000 });
});

test("Quit freezes settings and raw drafts while keeping keyboard copy, Logs and retry available", async ({
  page,
  bridge,
}) => {
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Port", { exact: true }).fill(String(bridge.port));
  await page.getByRole("button", { name: /Authoritative configuration/ }).click();
  const raw = page.getByLabel("mcp.json", { exact: true });
  const draft = await raw.inputValue();
  const before = await bridge.control("inspect");
  await bridge.control("quit-hold");
  await bridge.control("quit-fail-once");
  await page.getByRole("button", { name: "Quit MCP Gateway" }).click();
  await page.getByRole("button", { name: "Discard changes and quit" }).click();
  await expect(page.getByRole("button", { name: "Quitting…" })).toBeDisabled();
  for (const phase of ["pending", "failed"]) {
    if (phase === "failed") {
      await bridge.control("quit-release");
      await expect(page.getByRole("button", { name: "Retry Quit" })).toBeEnabled();
    }
    for (const label of ["Interface / address", "Port", "Bearer token", "mcp.json"]) {
      await expect(page.getByLabel(label, { exact: true })).toHaveAttribute("readonly", "");
      await expect(page.getByLabel(label, { exact: true })).toBeEnabled();
    }
    await expect(page.getByRole("button", { name: "Generate secure token" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeDisabled();
    await expect(page.getByRole("switch", { name: /Launch app at login/ })).toBeDisabled();
    await expect(page.getByRole("switch", { name: /Start gateway when/ })).toBeDisabled();
    await raw.focus();
    await page.keyboard.press("ControlOrMeta+A");
    // Capture the browser copy event without replacing the user's system clipboard.
    await raw.evaluate((field) => {
      if (!(field instanceof HTMLTextAreaElement)) throw new Error("Expected draft textarea");
      field.addEventListener(
        "copy",
        (event) => {
          event.preventDefault();
          field.dataset.copied = field.value.slice(field.selectionStart, field.selectionEnd);
        },
        { once: true },
      );
    });
    await page.keyboard.press("ControlOrMeta+C");
    await expect(raw).toHaveAttribute("data-copied", draft);
    await page.keyboard.type("unsavable edit");
    await expect(raw).toHaveValue(draft);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `.cache/review-f1-f3/${phase}-settings-desktop.png` });
    await page.setViewportSize({ width: 390, height: 650 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `.cache/review-f1-f3/${phase}-settings-mobile.png` });
    await raw.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.cache/review-f1-f3/${phase}-draft-mobile.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await expect(page.getByRole("button", { name: "Clear logs" })).toBeEnabled();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
  }
  expect((await bridge.control("inspect")).snapshot.configText).toBe(before.snapshot.configText);
  const retry = page.getByRole("button", { name: "Retry Quit" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Quitting…" })).toBeDisabled();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("lost Quit acknowledgement and unavailable status never unlock unsavable settings", async ({
  page,
  bridge,
}) => {
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const port = page.getByLabel("Port", { exact: true });
  await expect(port).not.toHaveAttribute("readonly", "");
  const saved = await port.inputValue();
  await bridge.control("quit-hold");
  let unavailable = true;
  await page.route("**/rpc/quitStatus", (route) =>
    unavailable ? route.abort("failed") : route.continue(),
  );
  await page.route("**/rpc/quit", async (route) => {
    const accepted = await route.fetch();
    expect((await accepted.json()).value.status.phase).toBe("pending");
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Quit MCP Gateway" }).click();
  await expect(
    page.getByText("Could not request Quit. Check application status before retrying."),
  ).toBeVisible();
  await expect(port).toHaveAttribute("readonly", "");
  await expect(
    page.getByText("Could not read Quit status. Cleanup completion is unknown."),
  ).toBeVisible();
  await expect(port).toHaveAttribute("readonly", "");
  await port.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("9999");
  await expect(port).toHaveValue(saved);
  await expect(page.getByRole("button", { name: "Generate secure token" })).toBeDisabled();
  unavailable = false;
  await expect(page.getByRole("button", { name: "Quitting…" })).toBeDisabled();
  await expect(port).toHaveAttribute("readonly", "");
  await bridge.control("quit-release");
});

test("native Quit locks an open editor and restores keyboard focus to draft recovery", async ({
  page,
  bridge,
}) => {
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await page.getByRole("button", { name: /Authoritative configuration/ }).click();
  const raw = page.getByLabel("mcp.json", { exact: true });
  const config = JSON.parse(await raw.inputValue());
  config.mcpServers.existing = { url: bridge.upstream.url };
  await raw.fill(JSON.stringify(config));
  await save(page);
  const saved = await raw.inputValue();
  const opener = page.getByRole("button", { name: "Edit server", exact: true });
  await opener.click();
  const name = page.getByLabel("Server name", { exact: false });
  await name.fill("retained");
  await bridge.control("quit-hold");
  await bridge.control("quit-fail-once");
  await bridge.control("native-quit");
  const apply = page.getByRole("button", { name: "Apply to draft", exact: true });
  await expect(apply).toBeDisabled();
  await expect(name).toHaveAttribute("readonly", "");
  await name.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("unsavable edit");
  await expect(name).toHaveValue("retained");
  await expect(page.getByLabel("Transport", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Disabled (do not mount this endpoint)")).toBeDisabled();
  await bridge.control("quit-release");
  await expect(page.locator("[data-action=quit]")).toHaveText("Retry Quit");
  await expect(page.locator("[data-action=quit]")).toBeDisabled();
  await expect(apply).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 650 });
  const cancel = page.getByRole("button", { name: "Cancel", exact: true });
  await cancel.focus();
  await expect(cancel).toBeFocused();
  // Native Chrome dialogs can Tab into browser chrome at the end; test in-dialog order instead.
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByLabel("Headers (JSON object)", { exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(cancel).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("button", { name: /Authoritative configuration/ })).toBeFocused();
  await expect(raw).toHaveValue(saved);
  await expect(raw).toHaveAttribute("readonly", "");
  await expect(opener).toBeDisabled();
  await expect(page.getByRole("button", { name: "Retry Quit" })).toBeEnabled();
  expect((await bridge.control("inspect")).snapshot.configText).toBe(saved);
});

test("update confirmation preserves keyboard focus and fits desktop and narrow layouts", async ({
  page,
  bridge,
}) => {
  const update: UpdateStatus = {
    supported: true,
    installationEnabled: true,
    automaticUpdates: true,
    installedVersion: "0.3.1",
    availableVersion: "0.3.2",
    availableHash: "next123456",
    readyVersion: "0.3.2",
    phase: "ready",
    error: null,
    preferenceError: null,
    recoveryRequired: false,
    recoveryPath: null,
    checkedAt: null,
  };
  // Only updater status is synthetic; the renderer, dialogs and gateway bridge stay real.
  await page.route("**/rpc/snapshot", async (route) => {
    const response = await route.fetch();
    const result = await response.json();
    expect(result.ok).toBe(true);
    await route.fulfill({ json: { ...result, value: { ...result.value, update } } });
  });
  await page.route("**/rpc/updatesStatus", (route) =>
    route.fulfill({ json: { ok: true, value: update } }),
  );
  let restartCalls = 0;
  await page.route("**/rpc/updatesRestart", (route) => {
    restartCalls++;
    return route.abort();
  });
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const restart = page.getByRole("button", { name: "Restart to Update", exact: true });
  await expect(restart).toBeEnabled();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await restart.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Restart to update?" });
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `.cache/test-pruning/update-confirm-${width}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(restart).toBeFocused();
  }
  expect(restartCalls).toBe(0);
});

test.describe("Linux desktop controls", () => {
  test.use({ scenario: "linux" });
  test("unavailable login, independent autoStart, dirty Quit cancel/focus and validated local Quit", async ({
    page,
    bridge,
  }) => {
    await page.goto(`${bridge.url}/#${bridge.secret}`);
    await expect(page.getByText("Linux · local")).toBeVisible();
    await expect(page.getByText(/Closing minimizes to the taskbar/)).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("switch", { name: /Launch app at login/ })).toBeDisabled();
    await expect(
      page.getByText("Actual login registration: Unsupported", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("switch", { name: /Start gateway when the app opens/ }),
    ).toBeEnabled();
    await page.screenshot({
      path: "tests/e2e/artifacts/linux-controls-desktop.png",
      fullPage: true,
    });
    await page.getByRole("switch", { name: /Start gateway when the app opens/ }).check();
    await save(page);
    expect((await bridge.control("inspect")).loginCalls).toEqual([]);
    await page.getByLabel("Port", { exact: true }).fill(String(bridge.port));
    const quit = page.getByRole("button", { name: "Quit MCP Gateway", exact: true });
    await quit.click();
    await expect(page.getByRole("dialog", { name: "Quit MCP Gateway?" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(quit).toBeFocused();
    await expect(page.getByLabel("Port", { exact: true })).toHaveValue(String(bridge.port));
    await page.setViewportSize({ width: 390, height: 650 });
    await page.screenshot({
      path: "tests/e2e/artifacts/linux-controls-mobile.png",
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await quit.click();
    await page.getByRole("button", { name: "Discard changes and quit" }).click();
    await expect(page.getByText("Quit requested. Waiting for gateway cleanup.")).toBeVisible();
    await expect.poll(async () => (await bridge.control("inspect")).snapshot.running).toBe(false);
  });
});
