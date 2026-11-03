import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UPDATER_FEED_URL } from "../../src/main/updater/constants";
import { runUpdaterWorker, type UpdaterSdk } from "../../src/main/updater/worker";

const CHANNEL_ROOT = "/isolated/Library/Application Support/dev.srvr.mcpgateway/stable";

function sdk(overrides: {
  info?: Partial<Awaited<ReturnType<UpdaterSdk["getLocalInfo"]>>>;
  check?: Partial<Awaited<ReturnType<UpdaterSdk["checkForUpdate"]>>>;
  download?: Partial<Awaited<ReturnType<UpdaterSdk["updateInfo"]>>>;
  checkThrows?: boolean;
  root?: string;
}): UpdaterSdk & { downloads: number } {
  const info = {
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    baseUrl: UPDATER_FEED_URL,
    version: "0.3.0",
    ...overrides.info,
  };
  const check = {
    version: "0.3.1",
    hash: "target123456",
    updateAvailable: true,
    updateReady: false,
    error: "",
    ...overrides.check,
  };
  const downloaded = {
    version: check.version,
    hash: check.hash,
    updateAvailable: true,
    updateReady: true,
    error: "",
    ...overrides.download,
  };
  const result = {
    downloads: 0,
    getLocalInfo: async () => info,
    checkForUpdate: async () => {
      if (overrides.checkThrows) throw new Error("private network detail");
      return check;
    },
    downloadUpdate: async () => {
      result.downloads++;
    },
    updateInfo: () => downloaded,
    appDataFolder: async () => overrides.root ?? CHANNEL_ROOT,
  };
  return result;
}

async function fixture(): Promise<{ root: string; result: string }> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-worker-"));
  await mkdir(join(root, "run"), { recursive: true, mode: 0o700 });
  return { root, result: join(root, "run/result.json") };
}

test("publishes a ready selection only after the unchanged SDK reports a prepared update", async () => {
  const file = await fixture();
  try {
    const code = await runUpdaterWorker(
      "prepare",
      { MCP_GATEWAY_UPDATE_CHANNEL_ROOT: CHANNEL_ROOT, MCP_GATEWAY_UPDATE_RESULT: file.result },
      sdk({}),
    );
    expect(code).toBe(0);
    expect(JSON.parse(await readFile(file.result, "utf8"))).toEqual({
      status: "ready",
      selected: { version: "0.3.1", hash: "target123456" },
      channelRoot: CHANNEL_ROOT,
    });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("reports equal and older versions as no update and rejects prereleases before download", async () => {
  const file = await fixture();
  try {
    for (const version of ["0.3.0", "0.2.9"]) {
      const updater = sdk({ check: { version } });
      const code = await runUpdaterWorker(
        "prepare",
        { MCP_GATEWAY_UPDATE_CHANNEL_ROOT: CHANNEL_ROOT, MCP_GATEWAY_UPDATE_RESULT: file.result },
        updater,
      );
      expect(code).toBe(0);
      expect(updater.downloads).toBe(0);
      expect(JSON.parse(await readFile(file.result, "utf8"))).toEqual({
        status: "no-update",
        reason: "version",
      });
    }
    const pr = sdk({ check: { version: "0.3.1-beta.1" } });
    expect(
      await runUpdaterWorker(
        "prepare",
        { MCP_GATEWAY_UPDATE_CHANNEL_ROOT: CHANNEL_ROOT, MCP_GATEWAY_UPDATE_RESULT: file.result },
        pr,
      ),
    ).toBe(1);
    expect(pr.downloads).toBe(0);
    expect(JSON.parse(await readFile(file.result, "utf8"))).toEqual({
      status: "failed",
      reason: "version",
    });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("check mode reports availability without downloading the selected release", async () => {
  const file = await fixture();
  try {
    const updater = sdk({});
    expect(
      await runUpdaterWorker(
        "check",
        { MCP_GATEWAY_UPDATE_CHANNEL_ROOT: CHANNEL_ROOT, MCP_GATEWAY_UPDATE_RESULT: file.result },
        updater,
      ),
    ).toBe(0);
    expect(updater.downloads).toBe(0);
    expect(JSON.parse(await readFile(file.result, "utf8"))).toEqual({
      status: "available",
      selected: { version: "0.3.1", hash: "target123456" },
      channelRoot: CHANNEL_ROOT,
    });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("does not prepare when the installed identity or fixed feed is ineligible", async () => {
  const file = await fixture();
  try {
    for (const [info, reason] of [
      [{ identifier: "dev.srvr.other" }, "identity"],
      [{ channel: "dev" }, "channel"],
      [{ baseUrl: "https://example.invalid/releases" }, "feed"],
      [{ version: "0.3.1-beta.1" }, "version"],
    ] as const) {
      const code = await runUpdaterWorker(
        "prepare",
        { MCP_GATEWAY_UPDATE_CHANNEL_ROOT: CHANNEL_ROOT, MCP_GATEWAY_UPDATE_RESULT: file.result },
        sdk({ info }),
      );
      expect(code).toBe(1);
      expect(JSON.parse(await readFile(file.result, "utf8"))).toEqual({
        status: "unavailable",
        reason,
      });
    }
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("reports a sanitized failure when check or download does not complete", async () => {
  const file = await fixture();
  try {
    expect(
      await runUpdaterWorker(
        "prepare",
        { MCP_GATEWAY_UPDATE_CHANNEL_ROOT: CHANNEL_ROOT, MCP_GATEWAY_UPDATE_RESULT: file.result },
        sdk({ checkThrows: true }),
      ),
    ).toBe(1);
    expect(JSON.parse(await readFile(file.result, "utf8"))).toEqual({
      status: "failed",
      reason: "result",
    });
    expect(
      await runUpdaterWorker(
        "prepare",
        { MCP_GATEWAY_UPDATE_CHANNEL_ROOT: CHANNEL_ROOT, MCP_GATEWAY_UPDATE_RESULT: file.result },
        sdk({ check: { updateAvailable: false } }),
      ),
    ).toBe(0);
    expect(JSON.parse(await readFile(file.result, "utf8"))).toEqual({
      status: "no-update",
      reason: "check",
    });
    expect(
      await runUpdaterWorker(
        "prepare",
        { MCP_GATEWAY_UPDATE_CHANNEL_ROOT: CHANNEL_ROOT, MCP_GATEWAY_UPDATE_RESULT: file.result },
        sdk({ download: { updateReady: false } }),
      ),
    ).toBe(1);
    expect(JSON.parse(await readFile(file.result, "utf8"))).toEqual({
      status: "failed",
      reason: "download",
    });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("refuses an invalid or non-absolute worker result path", async () => {
  expect(await runUpdaterWorker("prepare", {}, sdk({}))).toBe(2);
  expect(
    await runUpdaterWorker("prepare", { MCP_GATEWAY_UPDATE_RESULT: "relative.json" }, sdk({})),
  ).toBe(2);
  expect(await runUpdaterWorker("other", { MCP_GATEWAY_UPDATE_RESULT: "/tmp/x" }, sdk({}))).toBe(2);
});

test("rejects an actually materialized oversized SDK download using a small injected limit", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-worker-budget-"));
  const channel = join(root, "channel");
  const result = join(root, "result.json");
  try {
    await mkdir(join(channel, "self-extraction"), { recursive: true, mode: 0o700 });
    await writeFile(join(channel, "self-extraction", "target123456.tar"), Buffer.alloc(2048), {
      mode: 0o600,
    });
    const code = await runUpdaterWorker(
      "prepare",
      {
        MCP_GATEWAY_UPDATE_CHANNEL_ROOT: channel,
        MCP_GATEWAY_UPDATE_RESULT: result,
        MCP_GATEWAY_UPDATE_MAX_EXPANDED_BYTES: "1024",
      },
      sdk({ root: channel }),
    );
    expect(code).toBe(1);
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({
      status: "failed",
      reason: "result",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
