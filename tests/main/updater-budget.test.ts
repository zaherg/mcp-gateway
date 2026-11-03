import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertLayoutConstants,
  assertStorageBudget,
  DEFAULT_UPDATE_STORAGE_LIMITS,
  treeUsage,
  UPDATE_STORAGE_PEAK_BYTES,
} from "../../src/main/updater/budget";
import { MAX_STAGING_BYTES } from "../../src/main/updater/constants";
import { UpdaterStateError } from "../../src/main/updater/storage";

const ID = "0123456789abcdef0123456789abcdef";

async function fixture(): Promise<{ root: string; channel: string; data: string }> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-budget-"));
  const channel = join(root, "channel");
  const data = join(root, "data");
  await mkdir(join(channel, "self-extraction"), { recursive: true, mode: 0o700 });
  await mkdir(join(data, "updates/candidates"), { recursive: true, mode: 0o700 });
  await mkdir(join(data, "updates/recovery"), { recursive: true, mode: 0o700 });
  await mkdir(join(data, "updates/tmp"), { recursive: true, mode: 0o700 });
  return { root, channel, data };
}

function limits(overrides: Partial<typeof DEFAULT_UPDATE_STORAGE_LIMITS> = {}) {
  return { ...DEFAULT_UPDATE_STORAGE_LIMITS, ...overrides };
}

test("the numeric layout peak is explicitly bounded below the free-space reserve", () => {
  expect(UPDATE_STORAGE_PEAK_BYTES).toBeLessThanOrEqual(MAX_STAGING_BYTES);
  expect(() => assertLayoutConstants()).not.toThrow();
});

test("counts materialized directories and rejects an over-budget tree", async () => {
  const file = await fixture();
  try {
    await mkdir(join(file.data, "updates/tmp/a/b/c"), { recursive: true, mode: 0o700 });
    await writeFile(join(file.data, "updates/tmp/a/b/c/file"), "12345", { mode: 0o600 });
    const usage = await treeUsage(join(file.data, "updates/tmp"), {
      maxBytes: 10 * 1024 * 1024,
      maxFiles: 10,
      maxEntries: 10,
      label: "fixture",
    });
    expect(usage.directories).toBeGreaterThanOrEqual(4);
    await expect(
      treeUsage(join(file.data, "updates/tmp"), {
        maxBytes: 1,
        maxFiles: 10,
        maxEntries: 10,
        label: "fixture",
      }),
    ).rejects.toBeInstanceOf(UpdaterStateError);
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("actual SDK-shaped oversized compressed output is rejected before extraction", async () => {
  const file = await fixture();
  try {
    await writeFile(
      join(file.channel, "self-extraction", `.target123456.${ID}.tar.zst`),
      Buffer.alloc(2048),
      { mode: 0o600 },
    );
    await expect(
      assertStorageBudget({
        channelRoot: file.channel,
        dataDirectory: file.data,
        limits: limits({ compressedBytes: 1024 }),
      }),
    ).rejects.toMatchObject({ code: "storageBudget" });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("real zstd expansion is bounded by the expanded archive budget", async () => {
  const zstd = Bun.which("zstd");
  if (!zstd) return;
  const file = await fixture();
  try {
    const compressed = join(file.root, "payload.tar.zst");
    const expanded = join(file.channel, "self-extraction", "target123456.tar");
    const payload = Buffer.alloc(4096, 7);
    await writeFile(join(file.root, "payload"), payload, { mode: 0o600 });
    const pack = Bun.spawn([zstd, "-q", "-f", join(file.root, "payload"), "-o", compressed], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await pack.exited).toBe(0);
    const unpack = Bun.spawn([zstd, "-q", "-d", "-f", compressed, "-o", expanded], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await unpack.exited).toBe(0);
    await expect(
      assertStorageBudget({
        channelRoot: file.channel,
        dataDirectory: file.data,
        limits: limits({ expandedTarBytes: 1024 }),
      }),
    ).rejects.toMatchObject({ code: "storageBudget" });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("aggregate overlap rejects individually acceptable phase files", async () => {
  const file = await fixture();
  try {
    await writeFile(join(file.channel, "self-extraction", "a.tar.zst"), Buffer.alloc(600), {
      mode: 0o600,
    });
    await writeFile(join(file.channel, "self-extraction", "b.tar"), Buffer.alloc(600), {
      mode: 0o600,
    });
    await writeFile(join(file.channel, "self-extraction", "c.frozen"), Buffer.alloc(600), {
      mode: 0o600,
    });
    await writeFile(join(file.data, "updates/recovery/r.app"), Buffer.alloc(600), {
      mode: 0o600,
    });
    await expect(
      assertStorageBudget({
        channelRoot: file.channel,
        dataDirectory: file.data,
        limits: limits({
          compressedBytes: 4096,
          expandedTarBytes: 4096,
          frozenCopyBytes: 4096,
          recoveryTreeBytes: 4096,
          aggregateBytes: 1500,
        }),
      }),
    ).rejects.toMatchObject({ code: "storageBudget" });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("refuses symlinked materialized trees and file-shaped state", async () => {
  const file = await fixture();
  try {
    const target = join(file.root, "outside");
    await mkdir(target, { recursive: true, mode: 0o700 });
    await rm(join(file.data, "updates/recovery"), { recursive: true, force: true });
    await import("node:fs/promises").then(({ symlink }) =>
      symlink(target, join(file.data, "updates/recovery")),
    );
    await expect(
      assertStorageBudget({ channelRoot: file.channel, dataDirectory: file.data }),
    ).rejects.toBeInstanceOf(UpdaterStateError);
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("separately bounds the current application tree from recovery and staging", async () => {
  const file = await fixture();
  try {
    const app = join(file.root, "MCP Gateway.app");
    await mkdir(join(app, "Contents/Resources"), { recursive: true, mode: 0o700 });
    await writeFile(join(app, "Contents/Resources/version.json"), "x".repeat(2048), {
      mode: 0o600,
    });
    await expect(
      assertStorageBudget({
        channelRoot: file.channel,
        dataDirectory: file.data,
        appBundlePath: app,
        limits: limits({ currentTreeBytes: 1024 }),
      }),
    ).rejects.toMatchObject({ code: "storageBudget" });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("payload in every simultaneous category is counted once, separately from overhead", async () => {
  const file = await fixture();
  try {
    const app = join(file.root, "current.app");
    const extracted = join(file.data, "updates/tmp/extracted");
    const directories = [
      join(file.channel, "self-extraction"),
      join(file.data, "updates/candidates"),
      join(file.data, "updates/recovery"),
      join(file.data, "updates/tmp"),
      app,
      extracted,
    ];
    for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
    const paths = [
      join(file.channel, "self-extraction/target.tar"),
      join(file.channel, "self-extraction/target.frozen"),
      join(file.channel, "self-extraction/target.tar.zst"),
      join(file.data, "updates/candidates/record"),
      join(file.data, "updates/recovery/previous"),
      join(file.data, "updates/tmp/worker"),
      join(app, "payload"),
      join(extracted, "payload"),
    ];
    const payloadBytes = 64 * 1024;
    for (const path of paths) await writeFile(path, Buffer.alloc(payloadBytes, 7), { mode: 0o600 });
    const stats = await Promise.all([...directories, ...paths].map((path) => lstat(path)));
    const overheadBytes = stats.reduce(
      (total, info) => total + Math.max(0, info.blocks * 512 - (info.isFile() ? info.size : 0)),
      0,
    );
    expect(overheadBytes).toBeLessThan(payloadBytes);
    const options = {
      channelRoot: file.channel,
      dataDirectory: file.data,
      appBundlePath: app,
      extractedRoot: extracted,
    };
    const aggregateBytes = paths.length * payloadBytes + overheadBytes;
    const usage = await assertStorageBudget({
      ...options,
      limits: limits({ materializedDirectoryBytes: overheadBytes, aggregateBytes }),
    });
    expect(usage).toEqual({
      compressedBytes: payloadBytes,
      expandedTarBytes: payloadBytes,
      frozenCopyBytes: payloadBytes,
      extractedBytes: payloadBytes,
      recoveryBytes: payloadBytes,
      currentBytes: payloadBytes,
      metadataBytes: payloadBytes,
      temporaryBytes: payloadBytes,
      materializedDirectoryBytes: overheadBytes,
      aggregateBytes,
    });
    await expect(
      assertStorageBudget({ ...options, limits: limits({ aggregateBytes: aggregateBytes - 1 }) }),
    ).rejects.toMatchObject({ code: "storageBudget" });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("unreadable budget roots fail instead of being counted as empty", async () => {
  const file = await fixture();
  const directory = join(file.data, "updates");
  try {
    await writeFile(join(directory, "candidates/record"), "retained", { mode: 0o600 });
    await chmod(directory, 0o000);
    await expect(
      assertStorageBudget({ channelRoot: file.channel, dataDirectory: file.data }),
    ).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    await chmod(directory, 0o700);
    await rm(file.root, { recursive: true, force: true });
  }
});

test("enforces the distinct materialized ceiling below the aggregate ceiling", async () => {
  const file = await fixture();
  try {
    await writeFile(join(file.data, "updates/tmp/probe"), "12345678", { mode: 0o600 });
    await expect(
      assertStorageBudget({
        channelRoot: file.channel,
        dataDirectory: file.data,
        limits: limits({ materializedDirectoryBytes: 1 }),
      }),
    ).rejects.toMatchObject({ code: "storageBudget" });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});
