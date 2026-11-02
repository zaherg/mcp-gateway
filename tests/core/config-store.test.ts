import { describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { MAX_CONFIG_BYTES, newConfigText } from "../../src/core/config";
import { ConfigStore, revisionOf } from "../../src/core/config-store";
import { testDirectory } from "./helpers";

describe("ConfigStore", () => {
  test("owner-only creation, SHA revisions, synced replacement and byte-preserved no-op", async () => {
    const directory = await testDirectory();
    try {
      const path = join(directory, "mcp.json");
      const store = new ConfigStore(path);
      const initial = await store.initialize();
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect(initial.revision).toBe(revisionOf(await readFile(path)));
      const before = await lstat(path);
      expect(await store.save(initial.text, initial.revision)).toEqual(initial);
      expect((await lstat(path)).ino).toBe(before.ino);
      expect((await lstat(path)).mtimeMs).toBe(before.mtimeMs);
      const changed = `${initial.text.trim()}\n\n`;
      const saved = await store.save(changed, initial.revision);
      expect(await readFile(path, "utf8")).toBe(changed);
      expect(saved.revision).toBe(revisionOf(changed));
      expect((await lstat(path)).ino).not.toBe(before.ino);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      await expect(store.save(initial.text, initial.revision)).rejects.toMatchObject({
        code: "StaleRevision",
      });
      await expect(store.save('{"gateway":', saved.revision)).rejects.toMatchObject({
        code: "InvalidConfig",
      });
      expect(await readFile(path, "utf8")).toBe(changed);
      expect(await readdir(directory)).toEqual(["mcp.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("cooperative lock refuses competing writers and preserves original bytes", async () => {
    const directory = await testDirectory();
    try {
      const path = join(directory, "mcp.json");
      const store = new ConfigStore(path);
      const initial = await store.initialize();
      await writeFile(`${path}.lock`, "", { mode: 0o600 });
      await expect(store.save(newConfigText(), initial.revision)).rejects.toMatchObject({
        code: "ConfigLocked",
      });
      expect(await readFile(path, "utf8")).toBe(initial.text);
      await rm(`${path}.lock`);
      const writes = await Promise.allSettled([
        store.save(`${initial.text}\n`, initial.revision),
        new ConfigStore(path).save(`${initial.text}\n\n`, initial.revision),
      ]);
      expect(writes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
      expect(await readdir(directory)).toEqual(["mcp.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects symlinked files, symlink ancestors, hard links and permissive files", async () => {
    const directory = await testDirectory();
    try {
      const target = join(directory, "target.json");
      await writeFile(target, newConfigText(), { mode: 0o600 });
      const path = join(directory, "mcp.json");
      await symlink(target, path);
      await expect(new ConfigStore(path).initialize()).rejects.toMatchObject({
        code: "UnsafeFile",
      });
      await rm(path);
      await link(target, path);
      await expect(new ConfigStore(path).read()).rejects.toMatchObject({ code: "UnsafeFile" });
      await rm(path);
      await chmod(target, 0o644);
      await expect(new ConfigStore(target).read()).rejects.toMatchObject({ code: "UnsafeFile" });
      await chmod(target, 0o600);
      await mkdir(join(directory, "real"));
      await symlink(join(directory, "real"), join(directory, "alias"));
      await expect(
        new ConfigStore(join(directory, "alias", "mcp.json")).initialize(),
      ).rejects.toMatchObject({ code: "UnsafeFile" });
      expect(await readdir(join(directory, "real"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("bounded read refuses oversized and invalid UTF-8 bytes", async () => {
    const directory = await testDirectory();
    try {
      const path = join(directory, "mcp.json");
      await writeFile(path, "x".repeat(MAX_CONFIG_BYTES + 1), { mode: 0o600 });
      await expect(new ConfigStore(path).read()).rejects.toMatchObject({ code: "InvalidConfig" });
      await writeFile(path, Buffer.from([0xff, 0xfe]));
      await expect(new ConfigStore(path).read()).rejects.toMatchObject({ code: "InvalidConfig" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("ConfigStore format selection", () => {
  test("selects sole JSONC, keeps raw malformed recovery, validates permissions/CAS and shares legacy lock", async () => {
    const directory = await testDirectory();
    const json = join(directory, "mcp.json");
    const jsonc = `${json}c`;
    try {
      const text = `// retained\n${newConfigText()}`;
      await writeFile(jsonc, text, { mode: 0o600 });
      const store = new ConfigStore(json);
      const initial = await store.initialize();
      expect(store.path).toBe(jsonc);
      expect(store.format).toBe("jsonc");
      const before = await lstat(jsonc);
      expect(await store.save(text, initial.revision)).toEqual(initial);
      expect((await lstat(jsonc)).ino).toBe(before.ino);
      await writeFile(`${json}.lock`, "", { mode: 0o600 });
      await expect(store.save(`${text}\n`, initial.revision)).rejects.toMatchObject({
        code: "ConfigLocked",
      });
      await rm(`${json}.lock`);
      const saved = await store.save(`${text}\n`, initial.revision);
      await expect(store.save(text, initial.revision)).rejects.toMatchObject({
        code: "StaleRevision",
      });
      await expect(store.save(`${text} /* unfinished`, saved.revision)).rejects.toMatchObject({
        code: "InvalidConfig",
      });
      await writeFile(jsonc, '// raw SECRET\n{"gateway":');
      const malformed = await store.read();
      expect(malformed.text).toBe('// raw SECRET\n{"gateway":');
      await store.save(text, malformed.revision);
      await chmod(jsonc, 0o644);
      await expect(store.read()).rejects.toMatchObject({ code: "UnsafeFile" });
      await chmod(jsonc, 0o600);
      const target = join(directory, "target");
      await link(jsonc, target);
      await expect(store.read()).rejects.toMatchObject({ code: "UnsafeFile" });
      await rm(target);
      await rm(jsonc);
      await writeFile(target, text, { mode: 0o600 });
      await symlink(target, jsonc);
      await expect(store.read()).rejects.toMatchObject({ code: "UnsafeFile" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("ambiguous startup refuses both bytes, and running alternate/rename cannot switch or recreate", async () => {
    const directory = await testDirectory();
    const json = join(directory, "mcp.json");
    const jsonc = `${json}c`;
    try {
      const original = newConfigText();
      await writeFile(json, original, { mode: 0o600 });
      const store = new ConfigStore(json);
      const initial = await store.initialize();
      await writeFile(jsonc, "// alternate", { mode: 0o600 });
      const refused = new ConfigStore(jsonc);
      await expect(refused.initialize()).rejects.toMatchObject({ code: "AmbiguousConfig" });
      await expect(store.read()).rejects.toMatchObject({ code: "AmbiguousConfig" });
      await expect(store.save(original, initial.revision)).rejects.toMatchObject({
        code: "AmbiguousConfig",
      });
      expect(await readFile(json, "utf8")).toBe(original);
      expect(await readFile(jsonc, "utf8")).toBe("// alternate");
      await rm(jsonc);
      await expect(refused.read()).rejects.toMatchObject({ code: "AmbiguousConfig" });
      await rm(json);
      await writeFile(jsonc, `// renamed\n${original}`, { mode: 0o600 });
      await expect(store.read()).rejects.toMatchObject({ code: "ConfigIO" });
      await expect(store.initialize()).rejects.toMatchObject({ code: "ConfigIO" });
      await expect(store.save(original, initial.revision)).rejects.toMatchObject({
        code: "ConfigIO",
      });
      expect(await readdir(directory)).toEqual(["mcp.jsonc"]);
      const reopened = new ConfigStore(json);
      expect((await reopened.initialize()).text).toBe(`// renamed\n${original}`);
      expect(reopened.path).toBe(jsonc);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("cross-suffix cooperative initialization cannot create two files", async () => {
    const directory = await testDirectory();
    try {
      const json = join(directory, "mcp.json");
      const stores = [new ConfigStore(json), new ConfigStore(`${json}c`)];
      const results = await Promise.allSettled(stores.map((store) => store.initialize()));
      expect(
        results.filter((result) => result.status === "fulfilled").length,
      ).toBeGreaterThanOrEqual(1);
      for (const result of results)
        if (result.status === "rejected") expect(result.reason.code).toBe("ConfigLocked");
      expect(await readdir(directory)).toEqual(["mcp.json"]);
      const existing = await readFile(json, "utf8");
      for (const store of stores) expect((await store.initialize()).text).toBe(existing);
      expect(stores.map((store) => store.path)).toEqual([json, json]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
