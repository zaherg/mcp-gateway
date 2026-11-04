import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  atomicWritePrivateJson,
  atomicWritePrivateJsonSync,
  readNativeJsonSync,
  readPrivateJson,
  readPrivateJsonSync,
  removePrivateFile,
  UpdaterStateError,
} from "../../src/main/updater/storage";

async function fixture(): Promise<{ root: string; path: string }> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-storage-"));
  await mkdir(join(root, "state"), { recursive: true, mode: 0o700 });
  return { root, path: join(root, "state/preferences.json") };
}

test("retirement cleanup distinguishes missing paths from lookup failures", async () => {
  const file = await fixture();
  try {
    await writeFile(join(file.root, "not-directory"), "retained", { mode: 0o600 });
    await expect(
      removePrivateFile(join(file.root, "not-directory/record.json")),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    await removePrivateFile(join(file.root, "missing.json"));
    await mkdir(join(file.root, "data/updates"), { recursive: true, mode: 0o700 });
    await writeFile(join(file.root, "data/updates/tmp"), "retained", { mode: 0o600 });
    const { cleanupInterruptedStaging } = await import("../../src/main/updater/process");
    await expect(
      cleanupInterruptedStaging({
        channelRoot: join(file.root, "channel"),
        dataDirectory: join(file.root, "data"),
      }),
    ).rejects.toMatchObject({ code: "stateDirectory" });
    expect(await readFile(join(file.root, "data/updates/tmp"), "utf8")).toBe("retained");
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("reads only owner-mode regular private JSON under the bounded limit", async () => {
  const file = await fixture();
  try {
    await atomicWritePrivateJson(file.path, { schema_version: 1, automaticUpdates: true });
    expect(await readPrivateJson(file.path)).toEqual({
      schema_version: 1,
      automaticUpdates: true,
    });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("synchronous commits are bounded, owner-only, and leave no partial files", async () => {
  const file = await fixture();
  try {
    atomicWritePrivateJsonSync(file.path, { phase: "armed", attempt: 7 });
    expect(await readFile(file.path, "utf8")).toBe('{"phase":"armed","attempt":7}\n');
    expect(await readdir(join(file.root, "state"))).toEqual(["preferences.json"]);
    expect(() => atomicWritePrivateJsonSync(file.path, { pad: "x".repeat(70 * 1024) })).toThrow(
      UpdaterStateError,
    );
    expect(readPrivateJsonSync(file.path)).toEqual({ phase: "armed", attempt: 7 });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

for (const failurePoint of [
  "success",
  "file sync",
  "rename",
  "published validation",
  "directory sync",
] as const) {
  test(`synchronous publication notification tracks rename: ${failurePoint}`, async () => {
    const file = await fixture();
    try {
      const previous = '{"phase":"previous"}\n';
      const next = { phase: "next" };
      await writeFile(file.path, previous, { mode: 0o600 });
      const failure = new Error(`Synthetic ${failurePoint} refusal`);
      let notifications = 0;
      let observed: unknown;
      const rename = fs.renameSync;
      const sync = fs.fsyncSync;
      const renameMock = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (to === file.path && failurePoint === "rename") throw failure;
        rename(from, to);
        if (to === file.path && failurePoint === "published validation")
          fs.truncateSync(file.path, 0);
      });
      const syncMock = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        const directory = fs.fstatSync(fd).isDirectory();
        expect(notifications).toBe(directory ? 1 : 0);
        if (
          (directory && failurePoint === "directory sync") ||
          (!directory && failurePoint === "file sync")
        )
          throw failure;
        sync(fd);
      });
      try {
        atomicWritePrivateJsonSync(file.path, next, () => {
          notifications++;
        });
      } catch (error) {
        observed = error;
      } finally {
        renameMock.mockRestore();
        syncMock.mockRestore();
      }
      if (failurePoint === "success") expect(observed).toBeUndefined();
      else if (failurePoint === "published validation")
        expect(observed).toMatchObject({ code: "stateWrite" });
      else expect(observed).toBe(failure);
      const published = failurePoint !== "file sync" && failurePoint !== "rename";
      expect(notifications).toBe(published ? 1 : 0);
      expect(await readdir(join(file.root, "state"))).toEqual(["preferences.json"]);
      expect(await readFile(file.path, "utf8")).toBe(
        failurePoint === "published validation"
          ? ""
          : published
            ? `${JSON.stringify(next)}\n`
            : previous,
      );
    } finally {
      await rm(file.root, { recursive: true, force: true });
    }
  });
}

test("synchronous writer refuses a symlink destination", async () => {
  const file = await fixture();
  try {
    const target = join(file.root, "state/target.json");
    await writeFile(target, '{"safe":true}\n', { mode: 0o600 });
    await symlink(target, file.path);
    expect(() => atomicWritePrivateJsonSync(file.path, { safe: false })).toThrow(UpdaterStateError);
    expect(await readFile(target, "utf8")).toBe('{"safe":true}\n');
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("synchronous readers require owner-only state and tolerate native creator modes", async () => {
  const file = await fixture();
  try {
    await writeFile(file.path, '{"schema_version":1}\n', { mode: 0o644 });
    expect(() => readPrivateJsonSync(file.path)).toThrow(UpdaterStateError);
    expect(readNativeJsonSync(file.path)).toEqual({ schema_version: 1 });
    await chmod(file.path, 0o666);
    expect(() => readNativeJsonSync(file.path)).toThrow(UpdaterStateError);
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("detects replacement and growth during a descriptor-based private read", async () => {
  const file = await fixture();
  try {
    await atomicWritePrivateJson(file.path, { automaticUpdates: true });
    await expect(
      readPrivateJson(file.path, async () => {
        await rename(file.path, `${file.path}.replaced`);
        await writeFile(file.path, '{"automaticUpdates":false}\n', { mode: 0o600 });
      }),
    ).rejects.toBeInstanceOf(UpdaterStateError);
    const growth = await fixture();
    try {
      await atomicWritePrivateJson(growth.path, { automaticUpdates: true });
      await expect(
        readPrivateJson(growth.path, async () => {
          await writeFile(growth.path, `${JSON.stringify({ automaticUpdates: false })}\n`, {
            mode: 0o600,
            flag: "a",
          });
        }),
      ).rejects.toBeInstanceOf(UpdaterStateError);
    } finally {
      await rm(growth.root, { recursive: true, force: true });
    }
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});
