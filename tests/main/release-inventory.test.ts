import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  compareBundleInventories,
  inventoryBundle,
  inventoryDigest,
  ReleaseInventoryError,
} from "../../scripts/release-inventory";

async function bundle(root: string, executable: string, payload: string): Promise<string> {
  const app = join(root, "MCP Gateway.app");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(join(app, "Contents/Resources"), { recursive: true });
  await writeFile(join(app, "Contents/MacOS/launcher"), executable, { mode: 0o755 });
  await writeFile(join(app, "Contents/Resources/payload.tar.zst"), payload, { mode: 0o600 });
  await writeFile(
    join(app, "Contents/Resources/metadata.json"),
    '{"version":"0.3.1","hash":"same"}',
  );
  await mkdir(join(app, "Contents/_CodeSignature"));
  await writeFile(join(app, "Contents/_CodeSignature/CodeResources"), "same signature envelope");
  return app;
}

test("compares complete wrapper inventories including executables and payload bytes", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/release-inventory-"));
  try {
    const expected = await bundle(join(root, "expected"), "launcher-a", "same payload");
    const identical = await bundle(join(root, "identical"), "launcher-a", "same payload");
    const differentWrapper = await bundle(join(root, "different"), "launcher-b", "same payload");
    const expectedInventory = await inventoryBundle(expected);
    const identicalInventory = await inventoryBundle(identical);
    const differentInventory = await inventoryBundle(differentWrapper);
    expect(() => compareBundleInventories(expectedInventory, identicalInventory)).not.toThrow();
    expect(inventoryDigest(expectedInventory)).toHaveLength(64);
    expect(() => compareBundleInventories(expectedInventory, differentInventory)).toThrow(
      ReleaseInventoryError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const change of ["signature", "mode", "symlink", "type", "missing"] as const) {
  test(`rejects changed wrapper ${change} with unchanged metadata and payload`, async () => {
    const root = await mkdtemp(resolve(".cache/release-inventory-entry-"));
    try {
      const expected = await bundle(join(root, "expected"), "launcher", "same payload");
      const actual = await bundle(join(root, "actual"), "launcher", "same payload");
      await symlink("payload.tar.zst", join(expected, "Contents/Resources/link"));
      await symlink(
        change === "symlink" ? "metadata.json" : "payload.tar.zst",
        join(actual, "Contents/Resources/link"),
      );
      if (change === "signature")
        await writeFile(
          join(actual, "Contents/_CodeSignature/CodeResources"),
          "different signature envelope",
        );
      if (change === "mode") await chmod(join(actual, "Contents/MacOS/launcher"), 0o644);
      if (change === "type" || change === "missing") {
        await rm(join(actual, "Contents/_CodeSignature/CodeResources"));
        if (change === "type") await mkdir(join(actual, "Contents/_CodeSignature/CodeResources"));
      }
      const left = await inventoryBundle(expected);
      const right = await inventoryBundle(actual);
      expect(() => compareBundleInventories(left, right)).toThrow(ReleaseInventoryError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("does not follow a root symlink and observes cancellation", async () => {
  const root = await mkdtemp(resolve(".cache/release-inventory-root-"));
  try {
    const app = await bundle(root, "launcher", "payload");
    const link = join(root, "link.app");
    await symlink(app, link);
    await expect(inventoryBundle(link)).rejects.toThrow("plain directory");
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));
    await expect(inventoryBundle(app, abort.signal)).rejects.toThrow("cancelled");
    expect(inventoryDigest(await inventoryBundle(app))).toBe(
      inventoryDigest(await inventoryBundle(app)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a same-payload bundle with an extra wrapper file", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/release-inventory-extra-"));
  try {
    const expected = await bundle(join(root, "expected"), "launcher-a", "same payload");
    const actual = await bundle(join(root, "actual"), "launcher-a", "same payload");
    await writeFile(join(actual, "Contents/Resources/extra"), "different wrapper", {
      mode: 0o600,
    });
    const expectedInventory = await inventoryBundle(expected);
    const actualInventory = await inventoryBundle(actual);
    expect(() => compareBundleInventories(expectedInventory, actualInventory)).toThrow(
      ReleaseInventoryError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
