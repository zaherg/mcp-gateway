import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { test as base, expect } from "@playwright/test";
import { parseConfigDocument } from "../../src/shared/config-document";
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
    await bridge.control<
      Array<{ name: string; tools: string[]; result: { content: Array<{ text: string }> } }>
    >("probe");
  expect(
    probes.map((probe) => [probe.name, JSON.parse(probe.result.content[0].text).value]),
  ).toEqual([
    ["local", "e2e-local"],
    ["remote", "e2e-remote"],
  ]);
  for (const probe of probes) expect(probe.tools).toContain("echo");
  await page.getByRole("button", { name: "Stop gateway", exact: true }).click();
  await expect(page.getByText("Stopped", { exact: true }).first()).toBeVisible();
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
    upstreamSessions: 0,
  });
  expect(errors).toEqual([]);
  console.log(
    "Browser E2E uses real AppService/controller/store and synthetic MCP; Electrobun RPC/window lifecycle remains covered only by scripts/check-native.ts.",
  );
});

test("native approval clears warnings and clean saves retry refused pending unregister", async ({
  page,
  bridge,
}) => {
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await bridge.control("login-pending");
  await page.getByRole("switch", { name: /Launch app at login/ }).check();
  await save(page);
  const warning = page.getByRole("alert").filter({ hasText: "Login startup:" });
  await expect(warning).toContainText("macOS refused");
  expect((await bridge.control("inspect")).loginCalls).toEqual([true]);
  await bridge.control("login-approved");
  await expect(warning).not.toBeVisible({ timeout: 8000 });
  await expect(page.getByText("Actual login registration: Enabled", { exact: true })).toBeVisible();
  expect((await bridge.control("inspect")).loginCalls).toEqual([true]);
  await bridge.control("login-pending");
  await page.getByRole("switch", { name: /Launch app at login/ }).uncheck();
  await save(page);
  await expect(warning).toContainText("macOS refused");
  await expect(page.getByText("Unsaved changes", { exact: true })).not.toBeVisible();
  const before = await bridge.control("inspect");
  expect(before.loginCalls).toEqual([true, false]);
  await page.screenshot({ path: "tests/e2e/artifacts/login-retry-desktop.png", fullPage: true });
  await warning.getByRole("button", { name: "Dismiss error" }).click();
  await page.waitForTimeout(2300);
  await expect(warning).not.toBeVisible();
  expect((await bridge.control("inspect")).loginCalls).toEqual([true, false]);
  await page.setViewportSize({ width: 390, height: 650 });
  await page.screenshot({ path: "tests/e2e/artifacts/login-retry-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await bridge.control("login-allow");
  const retry = page.getByRole("button", { name: "Retry login registration" });
  await retry.focus();
  await page.keyboard.press("Enter");
  await expect(retry).not.toBeVisible();
  const after = await bridge.control("inspect");
  expect(after.loginCalls).toEqual([true, false, false]);
  expect(after.snapshot.revision).toBe(before.snapshot.revision);
  expect(after.snapshot.configText).toBe(before.snapshot.configText);
  expect(after.snapshot.running).toBe(false);
  await expect(
    page.getByText("Actual login registration: Disabled", { exact: true }),
  ).toBeVisible();
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

for (const action of ["add", "edit", "delete"] as const) {
  test(`open ${action} action survives invalid external configuration without overwriting it`, async ({
    page,
    bridge,
  }) => {
    await page.goto(`${bridge.url}/#${bridge.secret}`);
    if (action !== "add") {
      await page.getByRole("button", { name: "Add server", exact: true }).click();
      await page.getByLabel("Server name", { exact: false }).fill("local");
      await page.getByLabel("Command", { exact: true }).fill(bridge.stdio.command);
      await page.getByLabel("Arguments (JSON array)").fill(JSON.stringify(bridge.stdio.args));
      await page.getByRole("button", { name: "Apply to draft" }).click();
      await save(page);
    }
    await page.getByRole("button", { name: "Start gateway", exact: true }).click();
    await expect(page.getByText("Running", { exact: true })).toBeVisible();
    const before = await bridge.control("inspect");
    await page
      .getByRole("button", {
        name: action === "add" ? "Add server" : action === "edit" ? "Edit server" : "Delete local",
        exact: true,
      })
      .click();
    if (action === "add") {
      await page.getByLabel("Server name", { exact: false }).fill("added");
      await page.getByLabel("Command", { exact: true }).fill(bridge.stdio.command);
      await page.getByLabel("Arguments (JSON array)").fill(JSON.stringify(bridge.stdio.args));
    } else if (action === "edit") {
      await page.getByLabel("Server name", { exact: false }).fill("renamed");
    }
    await bridge.control("invalid");
    await expect.poll(async () => (await bridge.control("inspect")).snapshot.running).toBe(false);
    await expect(page.getByText(/The configuration changed outside this window/)).toBeAttached({
      timeout: 8000,
    });
    await expect(page.getByRole("dialog")).toBeVisible();
    if (action !== "delete")
      await expect(page.getByLabel("Server name", { exact: false })).toHaveValue(
        action === "add" ? "added" : "renamed",
      );
    if (action === "add") {
      await page.setViewportSize({ width: 390, height: 650 });
      await page.screenshot({
        path: "tests/e2e/artifacts/editor-invalid-mobile.png",
        fullPage: true,
      });
    }
    await page
      .getByRole("button", {
        name: action === "delete" ? "Delete server" : "Apply to draft",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const recovery = page.getByRole("button", { name: /Authoritative configuration/ });
    await expect(
      action === "add" ? page.getByRole("button", { name: "Add server", exact: true }) : recovery,
    ).toBeFocused();
    await recovery.click();
    const raw = page.getByLabel("mcp.json", { exact: true });
    const draft = await raw.inputValue();
    const expected = JSON.parse(before.snapshot.configText);
    if (action === "add")
      expected.mcpServers.added = {
        command: bridge.stdio.command,
        args: bridge.stdio.args,
        env: {},
        disabled: false,
      };
    else if (action === "edit") {
      expected.mcpServers.renamed = expected.mcpServers.local;
      delete expected.mcpServers.local;
    } else delete expected.mcpServers.local;
    expect(JSON.parse(draft)).toEqual(expected);
    await page.getByRole("button", { name: "Save mcp.json", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "StaleRevision" })).toBeVisible();
    await expect(raw).toHaveValue(draft);
    expect((await bridge.control<{ diskText: string }>("inspect")).diskText).toBe(
      '{"unknown":true}',
    );
    await expect(page.getByRole("button", { name: "Start gateway", exact: true })).toBeDisabled();
    if (action === "add")
      await page.screenshot({
        path: "tests/e2e/artifacts/editor-stale-mobile.png",
        fullPage: true,
      });
  });
}

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

test.describe("strict JSON syntax", () => {
  test.use({ scenario: "strict-comments" });
  test("comments in mcp.json remain recoverable raw bytes but cannot expose or save", async ({
    page,
    bridge,
  }) => {
    await page.goto(`${bridge.url}/#${bridge.secret}`);
    await expect(page.getByText("Repair configuration to continue", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start gateway", exact: true })).toBeDisabled();
    const original = (await bridge.control<{ diskText: string }>("inspect")).diskText;
    await page.getByRole("button", { name: /Authoritative configuration/ }).click();
    const raw = page.getByLabel("mcp.json", { exact: true });
    await expect(raw).toHaveValue(original);
    await raw.fill(`${original}\n`);
    await page.getByRole("button", { name: "Save mcp.json", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "InvalidConfig" })).toBeVisible();
    expect((await bridge.control<{ diskText: string }>("inspect")).diskText).toBe(original);
    await expect(raw).toHaveValue(`${original}\n`);
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
  await expect(entries).toContainText("<script>synthetic-note</script>");
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

test("dismissed local bind failure does not return as a polled banner; a new identical failure does", async ({
  page,
  bridge,
}) => {
  await page.goto(`${bridge.url}/#${bridge.secret}`);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const occupied = await bridge.control<{ port: number }>("occupied-port");
  await page.getByLabel("Port", { exact: true }).fill(String(occupied.port));
  await save(page);
  await page.getByRole("button", { name: "Dismiss notification" }).click();
  await page.waitForTimeout(2200);
  await expect(page.getByText("Configuration saved.", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Start gateway", exact: true }).click();
  const banner = page.getByRole("alert").filter({ hasText: "EADDRINUSE" });
  await expect(banner).toHaveCount(1);
  const first = (await bridge.control("inspect")).snapshot.operationalError;
  expect(first?.occurrenceId).toBeTruthy();
  await banner.getByRole("button", { name: "Dismiss error" }).click();
  await page.waitForTimeout(2300);
  await expect(banner).not.toBeVisible();
  expect((await bridge.control("inspect")).snapshot.operationalError?.occurrenceId).toBe(
    first?.occurrenceId,
  );
  await page.getByRole("button", { name: "Start gateway", exact: true }).click();
  await expect(banner).toHaveCount(1);
  expect((await bridge.control("inspect")).snapshot.operationalError?.occurrenceId).not.toBe(
    first?.occurrenceId,
  );
  await page.waitForTimeout(2300);
  await expect(banner).toHaveCount(1);
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

for (const action of ["add", "edit", "delete"] as const) {
  test(`native Quit locks an open ${action} dialog and restores focus to draft recovery`, async ({
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
    const opener = page.getByRole("button", {
      name: action === "add" ? "Add server" : action === "edit" ? "Edit server" : "Delete existing",
      exact: true,
    });
    await opener.click();
    if (action !== "delete")
      await page.getByLabel("Server name", { exact: false }).fill("retained");
    await bridge.control("quit-hold");
    await bridge.control("quit-fail-once");
    await bridge.control("native-quit");
    const apply = page.getByRole("button", {
      name: action === "delete" ? "Delete server" : "Apply to draft",
      exact: true,
    });
    await expect(apply).toBeDisabled();
    if (action !== "delete") {
      const name = page.getByLabel("Server name", { exact: false });
      await expect(name).toHaveAttribute("readonly", "");
      await name.focus();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type("unsavable edit");
      await expect(name).toHaveValue("retained");
      await expect(page.getByLabel("Transport", { exact: true })).toBeDisabled();
      await expect(page.getByLabel("Disabled (do not mount this endpoint)")).toBeDisabled();
    }
    await bridge.control("quit-release");
    await expect(page.locator("[data-action=quit]")).toHaveText("Retry Quit");
    await expect(page.locator("[data-action=quit]")).toBeDisabled();
    await expect(apply).toBeDisabled();
    await page.screenshot({ path: `.cache/review-f1-f3/${action}-dialog-desktop.png` });
    await page.setViewportSize({ width: 390, height: 650 });
    await page.screenshot({ path: `.cache/review-f1-f3/${action}-dialog-mobile.png` });
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    await cancel.focus();
    await expect(cancel).toBeFocused();
    // Native Chrome dialogs can Tab into browser chrome at the end; test in-dialog order instead.
    await page.keyboard.press("Shift+Tab");
    await expect(
      action === "add"
        ? page.getByLabel("Working directory", { exact: true })
        : action === "edit"
          ? page.getByLabel("Headers (JSON object)", { exact: true })
          : page.getByRole("button", { name: "Close dialog" }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    await cancel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.cache/review-f1-f3/${action}-dialog-actions-mobile.png` });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Authoritative configuration/ })).toBeFocused();
    await expect(raw).toHaveValue(saved);
    await expect(raw).toHaveAttribute("readonly", "");
    await expect(opener).toBeDisabled();
    await expect(page.getByRole("button", { name: "Retry Quit" })).toBeEnabled();
    expect((await bridge.control("inspect")).snapshot.configText).toBe(saved);
  });
}

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
  test("delayed Quit cleanup failure exposes sanitized retry through the local lifecycle boundary", async ({
    page,
    bridge,
  }) => {
    await page.goto(`${bridge.url}/#${bridge.secret}`);
    await expect(page.getByText("Linux · local")).toBeVisible();
    await bridge.control("quit-fail-once");
    await page.getByRole("button", { name: "Quit MCP Gateway", exact: true }).click();
    await expect(page.getByText("Quit requested. Waiting for gateway cleanup.")).toBeVisible();
    const failure = page.getByRole("alert").filter({ hasText: "Quit cleanup failed." });
    await expect(failure).toHaveText("Quit cleanup failed. The app has not exited. Retry Quit.", {
      timeout: 8000,
    });
    await expect(page.getByRole("button", { name: "Retry Quit", exact: true })).toBeEnabled();
    await expect(page.getByText("Quit requested. Waiting for gateway cleanup.")).not.toBeVisible();
    await expect(
      page.getByText("synthetic-private-quit-cleanup", { exact: false }),
    ).not.toBeVisible();
    await page.screenshot({
      path: ".cache/linux-runtime/review-fixes/quit-retry-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 650 });
    await page.screenshot({
      path: ".cache/linux-runtime/review-fixes/quit-retry-mobile.png",
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Retry Quit", exact: true }).click();
    await expect(page.getByRole("button", { name: "Quitting…", exact: true })).toBeDisabled();
    await expect(failure).not.toBeVisible();
    await expect(page.getByText("Quit requested. Waiting for gateway cleanup.")).toBeVisible();
  });
  test("a new renderer retries failed Quit even when gateway snapshot is unavailable", async ({
    page,
    bridge,
  }) => {
    await bridge.control("quit-fail-once");
    const headers = {
      Authorization: `Bearer ${bridge.secret}`,
      "Content-Type": "application/json",
    };
    const requested = await fetch(`${bridge.url}/rpc/quit`, {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(requested.status).toBe(200);
    await expect
      .poll(async () => {
        const response = await fetch(`${bridge.url}/rpc/quitStatus`, {
          method: "POST",
          headers,
          body: "{}",
        });
        const result = await response.json();
        return result.ok ? result.value.phase : "unavailable";
      })
      .toBe("failed");
    await page.route("**/rpc/snapshot", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "OperationFailed", message: "Synthetic unavailable gateway snapshot." },
        }),
      }),
    );
    await page.goto(`${bridge.url}/#${bridge.secret}`);
    const retry = page.getByRole("button", { name: "Retry Quit", exact: true });
    await expect(retry).toBeEnabled();
    await expect(
      page.getByText("Synthetic unavailable gateway snapshot.", { exact: false }),
    ).toBeVisible();
    await page.screenshot({
      path: ".cache/linux-runtime/shutdown-fixes/snapshot-unavailable-desktop.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 650 });
    await page.screenshot({
      path: ".cache/linux-runtime/shutdown-fixes/snapshot-unavailable-mobile.png",
      fullPage: true,
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await retry.click();
    await expect(page.getByRole("button", { name: "Quitting…", exact: true })).toBeDisabled();
    await expect(page.getByText("Quit cleanup failed.", { exact: false })).not.toBeVisible();
  });
});
