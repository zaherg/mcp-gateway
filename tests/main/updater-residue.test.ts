import { test as bunTest, expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCommand } from "../../src/core/command";
import { acquireKernelGuard, KERNEL_GUARD_FILE } from "../../src/main/updater/kernel-guard";
import {
  readLease,
  reconcileTransaction,
  TransactionLease,
} from "../../src/main/updater/transaction";

const test = bunTest.skipIf(process.platform !== "darwin");
async function fixture() {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-residue-"));
  const channelRoot = join(root, "channel");
  const dataDirectory = join(root, "data");
  for (const path of [channelRoot, dataDirectory]) await mkdir(path, { mode: 0o700 });
  await writeFile(join(channelRoot, "unrelated"), "preserve", { mode: 0o600 });
  const directory = join(channelRoot, ".mcp-gateway-update-transaction");
  return {
    root,
    channelRoot,
    dataDirectory,
    directory,
    appBundlePath: join(root, "App.app"),
    journal: join(directory, "lease.json"),
  };
}
async function inventory(directory: string) {
  return (
    await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })
  ).sort();
}

const points = [
  ["initial-directory", [], "none"],
  ["initial-partial-created", ["partial"], "recovery-required"],
  ["initial-partial-written", ["partial"], "recovery-required"],
  ["initial-partial-synced", ["partial"], "recovery-required"],
  ["initial-renamed", ["lease.json"], "none"],
  ["update-partial-created", ["lease.json", "partial"], "recovery-required"],
  ["update-partial-written", ["lease.json", "partial"], "none"],
  ["update-partial-synced", ["lease.json", "partial"], "none"],
  ["update-renamed", ["lease.json"], "none"],
  ["retirement-unlinked", [], "none"],
  ["retirement-synced", [], "none"],
  ["retirement-removed", [], "none"],
] as const;
for (const [point, expectedInventory, status] of points) {
  test(`process crash at ${point} preserves exact authority and recovery inventory`, async () => {
    const f = await fixture();
    try {
      const result = await runCommand(
        process.execPath,
        [resolve("tests/fixtures/updater-residue-crash.ts"), f.root, point],
        10_000,
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(42);
      const before = await inventory(f.directory);
      expect(before.map((name) => (name.endsWith(".partial") ? "partial" : name))).toEqual([
        ...expectedInventory,
      ]);
      const guardInode = fs.lstatSync(join(f.channelRoot, KERNEL_GUARD_FILE)).ino;
      expect((await reconcileTransaction(f)).status).toBe(status);
      expect((await reconcileTransaction(f)).status).toBe(status);
      expect(await inventory(f.directory)).toEqual(status === "none" ? [] : before);
      expect(fs.lstatSync(join(f.channelRoot, KERNEL_GUARD_FILE)).ino).toBe(guardInode);
      expect(await readFile(join(f.channelRoot, "unrelated"), "utf8")).toBe("preserve");
      if (status === "none") {
        const lease = await TransactionLease.acquire(f);
        await lease.releaseUncommitted();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const kind of [
  "unknown-file",
  "unsafe-mode",
  "symlink",
  "native-evidence",
  "held-guard",
] as const) {
  test(`empty-directory recovery refuses ${kind} without deleting evidence`, async () => {
    const f = await fixture();
    let release = () => {};
    try {
      await mkdir(f.directory, { mode: 0o700 });
      if (kind === "unknown-file") await writeFile(join(f.directory, "unknown"), "preserve");
      if (kind === "unsafe-mode") await chmod(f.directory, 0o755);
      if (kind === "symlink") {
        await rm(f.directory, { recursive: true });
        await symlink(f.dataDirectory, f.directory);
      }
      if (kind === "native-evidence")
        await writeFile(join(f.channelRoot, ".electrobun-update-unknown.json"), "preserve");
      if (kind === "held-guard") release = (await acquireKernelGuard(f.channelRoot)).releaseSync;
      const before = await inventory(f.directory);
      expect((await reconcileTransaction(f)).status).toBe("recovery-required");
      expect(fs.existsSync(f.directory)).toBe(true);
      expect(await inventory(f.directory)).toEqual(before);
      expect(await readFile(join(f.channelRoot, "unrelated"), "utf8")).toBe("preserve");
    } finally {
      release();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["live-owner", "conflicting", "truncated", "symlink", "unsafe-mode"] as const) {
  test(`canonical journal plus ${kind} partial remains blocked and byte-preserved`, async () => {
    const f = await fixture();
    let lease: TransactionLease | undefined;
    try {
      lease = await TransactionLease.acquire(f);
      const bytes = await readFile(f.journal);
      const partial = `${f.journal}.${"a".repeat(16)}.partial`;
      if (kind === "symlink") await symlink(f.journal, partial);
      else
        await writeFile(
          partial,
          kind === "truncated"
            ? "{"
            : kind === "conflicting"
              ? JSON.stringify({ ...lease.snapshot(), lease_id: "b".repeat(32) })
              : bytes,
          { mode: 0o600 },
        );
      if (kind === "unsafe-mode") await chmod(partial, 0o644);
      lease.releaseGuard();
      const names = await inventory(f.directory);
      expect(
        (
          await reconcileTransaction({
            ...f,
            ...(kind === "live-owner" ? {} : { inspectOwner: () => "absent" as const }),
          })
        ).status,
      ).toBe("recovery-required");
      expect(await readFile(f.journal)).toEqual(bytes);
      expect(await inventory(f.directory)).toEqual(names);
    } finally {
      lease?.releaseGuard();
      await rm(f.root, { recursive: true, force: true });
    }
  });
}

test("a directory-sync refusal after publication preserves the canonical journal", async () => {
  const f = await fixture();
  const original = fs.fsyncSync;
  let calls = 0;
  const mock = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    calls++;
    if (fs.existsSync(f.journal) && fs.fstatSync(fd).isDirectory())
      throw new Error("Synthetic directory sync refusal");
    original(fd);
  });
  try {
    await expect(TransactionLease.acquire(f)).rejects.toMatchObject({ code: "state" });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(await inventory(f.directory)).toEqual(["lease.json"]);
    expect((await readLease(f.channelRoot))?.phase).toBe("operation");
  } finally {
    mock.mockRestore();
    await rm(f.root, { recursive: true, force: true });
  }
});
