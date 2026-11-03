import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEFAULT_UPDATE_PREFERENCES,
  loadUpdatePreferences,
  saveUpdatePreferences,
} from "../../src/main/updater/preferences";

async function directory(): Promise<string> {
  await mkdir(resolve(".cache"), { recursive: true });
  return mkdtemp(resolve(".cache/updater-preferences-"));
}

test("missing updates.json defaults to automatic updates enabled", async () => {
  const root = await directory();
  try {
    expect(await loadUpdatePreferences(root)).toEqual(DEFAULT_UPDATE_PREFERENCES);
    expect(DEFAULT_UPDATE_PREFERENCES.automaticUpdates).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saves and loads the strict versioned preference atomically with owner-only permissions", async () => {
  const root = await directory();
  try {
    const initial = await loadUpdatePreferences(root);
    const saved = await saveUpdatePreferences(root, false, initial);
    expect(saved).toEqual({ automaticUpdates: false, status: "loaded", error: null });
    expect(JSON.parse(await readFile(join(root, "updates.json"), "utf8"))).toEqual({
      schema_version: 1,
      automaticUpdates: false,
    });
    expect((await stat(join(root, "updates.json"))).mode & 0o777).toBe(0o600);
    expect(await loadUpdatePreferences(root)).toEqual(saved);
    expect(await saveUpdatePreferences(root, true, saved)).toMatchObject({
      automaticUpdates: true,
      status: "loaded",
      error: null,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid, unsafe, or non-owner-only preferences disable background work without overwriting", async () => {
  const root = await directory();
  try {
    const path = join(root, "updates.json");
    const cases = [
      "{not json",
      JSON.stringify({ schema_version: 2, automaticUpdates: true }),
      JSON.stringify({ schema_version: 1, automaticUpdates: true, extra: true }),
      JSON.stringify({ schema_version: 1, automaticUpdates: "yes" }),
    ];
    for (const contents of cases) {
      await writeFile(path, contents, { mode: 0o600 });
      const state = await loadUpdatePreferences(root);
      expect(state.automaticUpdates).toBe(false);
      expect(state.status).toBe("invalid");
      expect(await readFile(path, "utf8")).toBe(contents);
    }
    await writeFile(path, JSON.stringify({ schema_version: 1, automaticUpdates: true }));
    await chmod(path, 0o644);
    expect(await loadUpdatePreferences(root)).toMatchObject({
      status: "invalid",
      automaticUpdates: false,
    });
    await rm(path, { force: true });
    await symlink("/tmp", path);
    expect(await loadUpdatePreferences(root)).toMatchObject({
      status: "invalid",
      automaticUpdates: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed preference write preserves the previous effective setting", async () => {
  const root = await directory();
  try {
    const previous = await loadUpdatePreferences(root);
    await mkdir(join(root, "updates.json"), { recursive: true, mode: 0o700 });
    const result = await saveUpdatePreferences(root, false, previous);
    expect(result.automaticUpdates).toBe(true);
    expect(result.status).toBe("write-failed");
    expect(result.error).toContain("previous setting remains active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses symlinked preference directories and ancestors even when the file is missing", async () => {
  const root = await directory();
  try {
    await mkdir(join(root, "target/data"), { recursive: true, mode: 0o700 });
    await symlink(join(root, "target"), join(root, "link"));
    await symlink(join(root, "target/data"), join(root, "leaf"));
    const previous = { ...DEFAULT_UPDATE_PREFERENCES };
    for (const data of [
      join(root, "link/data"),
      join(root, "link/missing/data"),
      join(root, "leaf"),
    ]) {
      expect(await loadUpdatePreferences(data)).toMatchObject({
        status: "invalid",
        automaticUpdates: false,
      });
      expect(await saveUpdatePreferences(data, false, previous)).toMatchObject({
        status: "write-failed",
        automaticUpdates: true,
      });
    }
    await writeFile(
      join(root, "target/data/updates.json"),
      JSON.stringify({ schema_version: 1, automaticUpdates: true }),
      { mode: 0o600 },
    );
    expect(await loadUpdatePreferences(join(root, "link/data"))).toMatchObject({
      status: "invalid",
      automaticUpdates: false,
    });
    expect(await saveUpdatePreferences(join(root, "leaf"), false, previous)).toMatchObject({
      status: "write-failed",
    });
    expect(
      JSON.parse(await readFile(join(root, "target/data/updates.json"), "utf8")).automaticUpdates,
    ).toBe(true);
    await expect(stat(join(root, "target/missing"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
