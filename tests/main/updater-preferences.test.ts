import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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

for (const initial of [undefined, false, true]) {
  for (const failurePoint of ["file sync", "directory sync"] as const) {
    test(`preference save reconciles publication after ${failurePoint}, initial=${initial}`, async () => {
      const root = await directory();
      try {
        const previous =
          initial === undefined
            ? await loadUpdatePreferences(root)
            : await saveUpdatePreferences(root, initial, DEFAULT_UPDATE_PREFERENCES);
        const requested = !previous.automaticUpdates;
        const sync = fs.fsyncSync;
        let failures = 0;
        const syncMock = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
          if (fs.fstatSync(fd).isDirectory() === (failurePoint === "directory sync")) {
            failures++;
            throw new Error("Synthetic private storage diagnostic");
          }
          sync(fd);
        });
        let result: Awaited<ReturnType<typeof saveUpdatePreferences>>;
        try {
          result = await saveUpdatePreferences(root, requested, previous);
        } finally {
          syncMock.mockRestore();
        }
        expect(failures).toBe(1);
        const published = failurePoint === "directory sync";
        const effective = published ? requested : previous.automaticUpdates;
        expect(result.automaticUpdates).toBe(effective);
        expect(result.status).toBe(published ? "durability-uncertain" : "write-failed");
        expect(result.error).toContain(
          published ? "durability could not be confirmed" : "previous setting remains active",
        );
        expect(result.error).not.toContain("Synthetic private");
        expect((await loadUpdatePreferences(root)).automaticUpdates).toBe(effective);
        if (initial !== undefined || published) {
          expect(await readFile(join(root, "updates.json"), "utf8")).toBe(
            `${JSON.stringify({ schema_version: 1, automaticUpdates: effective })}\n`,
          );
          expect(await readdir(root)).toEqual(["updates.json"]);
        } else expect(await readdir(root)).toEqual([]);
        const retried = await saveUpdatePreferences(root, requested, result);
        expect(retried).toEqual({ automaticUpdates: requested, status: "loaded", error: null });
        expect(await loadUpdatePreferences(root)).toEqual(retried);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const mutation of [
  "valid replacement",
  "truncated",
  "schema",
  "permissions",
  "missing",
  "symlink",
  "parent symlink",
] as const) {
  test(`post-publication readback adopts only verified preferences: ${mutation}`, async () => {
    const root = await directory();
    try {
      const data = join(root, "data");
      const path = join(data, "updates.json");
      const previous = await saveUpdatePreferences(data, true, DEFAULT_UPDATE_PREFERENCES);
      const target = join(root, "untouched.json");
      const targetText = '{"schema_version":1,"automaticUpdates":true}\n';
      await writeFile(target, targetText, { mode: 0o600 });
      const sync = fs.fsyncSync;
      let failures = 0;
      const syncMock = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (!fs.fstatSync(fd).isDirectory()) return sync(fd);
        failures++;
        switch (mutation) {
          case "valid replacement":
            fs.writeFileSync(path, targetText);
            break;
          case "truncated":
            fs.truncateSync(path, 0);
            break;
          case "schema":
            fs.writeFileSync(path, '{"schema_version":2,"automaticUpdates":true}');
            break;
          case "permissions":
            fs.chmodSync(path, 0o644);
            break;
          case "missing":
            fs.unlinkSync(path);
            break;
          case "symlink":
            fs.unlinkSync(path);
            fs.symlinkSync(target, path);
            break;
          case "parent symlink":
            fs.renameSync(data, join(root, "moved"));
            fs.symlinkSync(join(root, "moved"), data);
            break;
        }
        throw new Error("Synthetic private post-publication diagnostic");
      });
      let result: Awaited<ReturnType<typeof saveUpdatePreferences>>;
      try {
        result = await saveUpdatePreferences(data, false, previous);
      } finally {
        syncMock.mockRestore();
      }
      expect(failures).toBe(1);
      if (mutation === "valid replacement") {
        expect(result).toMatchObject({
          automaticUpdates: true,
          status: "durability-uncertain",
          error: expect.stringContaining("durability could not be confirmed"),
        });
        expect((await loadUpdatePreferences(data)).automaticUpdates).toBe(true);
      } else {
        expect(result).toEqual({
          automaticUpdates: false,
          status: "invalid",
          error:
            "The update preference was replaced, but its current value could not be verified. Background updates are disabled.",
        });
      }
      expect(await readFile(target, "utf8")).toBe(targetText);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
