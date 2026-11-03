import { expect, test } from "bun:test";
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
