import { test as bunTest, expect } from "bun:test";

// Transaction integration acquires the macOS kernel guard; policy tests remain portable.
const test = bunTest.skipIf(process.platform !== "darwin");

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireKernelGuard } from "../../src/main/updater/kernel-guard";
import { UpdaterStateError } from "../../src/main/updater/storage";
import { eventually } from "../core/helpers";

async function fixture(): Promise<string> {
  await mkdir(resolve(".cache"), { recursive: true });
  return mkdtemp(resolve(".cache/updater-kernel-guard-"));
}

test("serializes two processes on the stable guard inode and releases without deleting it", async () => {
  const root = await fixture();
  const child = join(root, "child.locked");
  try {
    await writeFile(join(root, "journal.json"), "durable\n", { mode: 0o600 });
    const guard = await acquireKernelGuard(root);
    const probe = Bun.spawn(
      [process.execPath, resolve("tests/fixtures/kernel-guard-child.ts"), root, child],
      {
        cwd: resolve("."),
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    expect(await probe.exited).toBe(3);
    expect(await readFile(child).catch(() => null)).toBeNull();
    await guard.release();
    expect(await readFile(guard.path).catch(() => null)).not.toBeNull();
    expect(await readFile(join(root, "journal.json"), "utf8")).toBe("durable\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const suffix of ["", "/missing/stable"]) {
  test(`guard rejects symlinked channel ancestors before creation (${suffix || "leaf"})`, async () => {
    const root = await fixture();
    try {
      const target = join(root, "unrelated");
      await mkdir(target, { mode: 0o700 });
      await writeFile(join(target, "notes"), "keep\n");
      await symlink(target, join(root, "alias"));
      let unexpected: Awaited<ReturnType<typeof acquireKernelGuard>> | undefined;
      try {
        await expect(
          acquireKernelGuard(join(root, `alias${suffix}`)).then((guard) => {
            unexpected = guard;
          }),
        ).rejects.toThrow();
      } finally {
        await unexpected?.release();
      }
      expect(await readdir(target)).toEqual(["notes"]);
      expect(await readFile(join(target, "notes"), "utf8")).toBe("keep\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("does not follow symlinks or accept unsafe guard files", async () => {
  const root = await fixture();
  try {
    await symlink("/tmp", join(root, ".mcp-gateway-update-guard"));
    await expect(acquireKernelGuard(root)).rejects.toBeInstanceOf(Error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("releases the kernel lock after an owner dies", async () => {
  const root = await fixture();
  const child = join(root, "child.locked");
  try {
    const holder = Bun.spawn(
      [process.execPath, resolve("tests/fixtures/kernel-guard-child.ts"), root, child],
      { cwd: resolve("."), stdout: "ignore", stderr: "pipe" },
    );
    await eventually(async () => {
      try {
        return (await readFile(child, "utf8")).trim() === "locked";
      } catch {
        return false;
      }
    });
    holder.kill("SIGKILL");
    await holder.exited;
    await eventually(async () => {
      try {
        const guard = await acquireKernelGuard(root);
        await guard.release();
        return true;
      } catch (error) {
        return !(error instanceof UpdaterStateError) || error.code !== "guardBusy";
      }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
