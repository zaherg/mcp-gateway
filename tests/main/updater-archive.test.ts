import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  extractAdmittedArchive,
  inspectUpdateArchive,
  UpdateArchiveError,
} from "../../src/main/updater/archive";
import { appEntries, tarBytes, writeTarFixture } from "../fixtures/updater";

async function directory(): Promise<string> {
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(resolve(".cache"), { recursive: true }),
  );
  return mkdtemp(resolve(".cache/updater-archive-"));
}

function code(error: unknown): string | undefined {
  return error instanceof UpdateArchiveError ? error.code : undefined;
}

async function expectArchiveCode(promise: Promise<unknown>, expected: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected archive rejection ${expected}`);
  } catch (error) {
    expect(code(error)).toBe(expected);
  }
}

test("admits a faithful single-app ustar archive and extracts the same files", async () => {
  const root = await directory();
  try {
    const archive = join(root, "target.tar");
    writeTarFixture(archive, appEntries());
    const inspection = await inspectUpdateArchive(archive);
    expect(inspection.bundleName).toBe("MCP Gateway.app");
    expect(inspection.entries.length).toBe(11);
    expect(inspection.bytes).toBe((await readFile(archive)).byteLength);
    const destination = join(root, "extracted");
    const bundle = await extractAdmittedArchive(inspection, destination);
    expect(bundle).toBe(join(destination, "MCP Gateway.app"));
    expect(await readFile(join(bundle, "Contents/Resources/version.json"), "utf8")).toContain(
      "0.3.1",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-executable pinned runtime/helper modes before extraction", async () => {
  const root = await directory();
  try {
    for (const relative of [
      "Contents/MacOS/launcher",
      "Contents/MacOS/bun",
      "Contents/MacOS/bspatch",
      "Contents/MacOS/zig-zstd",
      "Contents/Resources/uninstall",
    ]) {
      const entries = appEntries();
      const name = `MCP Gateway.app/${relative}`;
      const entry = entries.find((entry) => entry.name === name);
      if (entry) entry.mode = 0o600;
      else entries.push({ name, contents: "synthetic helper", mode: 0o600 });
      const archive = join(root, "mode.tar");
      writeTarFixture(archive, entries);
      await expectArchiveCode(inspectUpdateArchive(archive), "unsafeMode");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects path traversal, absolute paths, and backslash aliases", async () => {
  const root = await directory();
  try {
    for (const [index, name] of [
      "../escape",
      "/absolute",
      "MCP Gateway.app\\..\\escape",
    ].entries()) {
      const archive = join(root, `bad-${index}.tar`);
      writeTarFixture(archive, appEntries({ extra: [{ name, contents: "x" }] }));
      await expectArchiveCode(inspectUpdateArchive(archive), "unsafePath");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symbolic links, hard links, devices, and ambiguous headers", async () => {
  const root = await directory();
  try {
    const cases = [
      { name: "MCP Gateway.app/link", type: "2" as const, contents: "/etc/passwd" },
      { name: "MCP Gateway.app/hard", type: "1" as const, linkname: "Info.plist" },
      { name: "MCP Gateway.app/device", type: "6" as const },
      { name: "MCP Gateway.app/pax", type: "x" as const, contents: "path=other" },
    ];
    for (const [index, entry] of cases.entries()) {
      const archive = join(root, `link-${index}.tar`);
      writeTarFixture(archive, appEntries({ extra: [entry] }));
      await expectArchiveCode(inspectUpdateArchive(archive), "unsupportedEntry");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate and case-folded path collisions", async () => {
  const root = await directory();
  try {
    const duplicate = join(root, "duplicate.tar");
    writeTarFixture(
      duplicate,
      appEntries({ extra: [{ name: "MCP Gateway.app/Contents/Info.plist", contents: "other" }] }),
    );
    await expectArchiveCode(inspectUpdateArchive(duplicate), "duplicateEntry");
    const folded = join(root, "folded.tar");
    writeTarFixture(
      folded,
      appEntries({ extra: [{ name: "MCP Gateway.app/Contents/info.plist", contents: "other" }] }),
    );
    await expectArchiveCode(inspectUpdateArchive(folded), "duplicateEntry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a regular file used as a parent and an extra top-level bundle", async () => {
  const root = await directory();
  try {
    const fileParent = join(root, "file-parent.tar");
    writeTarFixture(
      fileParent,
      appEntries({ extra: [{ name: "MCP Gateway.app/Contents/Info.plist/child", contents: "x" }] }),
    );
    await expectArchiveCode(inspectUpdateArchive(fileParent), "conflictingEntry");
    const twoBundles = join(root, "two.tar");
    writeTarFixture(twoBundles, appEntries({ extra: [{ name: "Other.app/", type: "5" }] }));
    await expectArchiveCode(inspectUpdateArchive(twoBundles), "invalidBundleLayout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects truncation, trailing data, unsafe modes, and a missing application layout", async () => {
  const root = await directory();
  try {
    const valid = tarBytes(appEntries());
    const truncated = join(root, "truncated.tar");
    await writeFile(truncated, valid.subarray(0, valid.byteLength - 1024));
    await expectArchiveCode(inspectUpdateArchive(truncated), "archiveTruncated");
    const trailing = join(root, "trailing.tar");
    await writeFile(trailing, Buffer.concat([Buffer.from(valid), Buffer.from("extra")]));
    await expectArchiveCode(inspectUpdateArchive(trailing), "archiveTrailingData");
    const unsafeMode = join(root, "mode.tar");
    writeTarFixture(
      unsafeMode,
      appEntries({
        extra: [{ name: "MCP Gateway.app/Contents/script", contents: "x", mode: 0o777 }],
      }),
    );
    await expectArchiveCode(inspectUpdateArchive(unsafeMode), "unsafeMode");
    const missing = join(root, "missing.tar");
    writeTarFixture(missing, [
      { name: "MCP Gateway.app/", type: "5" },
      { name: "MCP Gateway.app/Contents/Info.plist", contents: "x" },
    ]);
    await expectArchiveCode(inspectUpdateArchive(missing), "invalidBundleLayout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a malformed checksum, non-ustar header, and a symlinked archive", async () => {
  const root = await directory();
  try {
    const malformed = join(root, "checksum.tar");
    const bytes = tarBytes(appEntries());
    bytes[148] = 0x37;
    await writeFile(malformed, bytes);
    await expectArchiveCode(inspectUpdateArchive(malformed), "invalidHeader");
    const archive = join(root, "valid.tar");
    writeTarFixture(archive, appEntries());
    const notUstar = await readFile(archive);
    notUstar.fill(0x20, 257, 263);
    await writeFile(archive, notUstar);
    await expectArchiveCode(inspectUpdateArchive(archive), "invalidHeader");
    const link = join(root, "link.tar");
    await import("node:fs/promises").then(({ symlink }) => symlink(archive, link));
    await expectArchiveCode(inspectUpdateArchive(link), "archiveUnavailable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects an archive that changes after admission", async () => {
  const root = await directory();
  try {
    const archive = join(root, "target.tar");
    writeTarFixture(archive, appEntries());
    const inspection = await inspectUpdateArchive(archive);
    const bytes = await readFile(archive);
    bytes[bytes.byteLength - 2000] ^= 0xff;
    await writeFile(archive, bytes);
    await expect(extractAdmittedArchive(inspection, join(root, "extracted"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cancels inspection and extraction after work starts without publishing a tree", async () => {
  const root = await directory();
  try {
    const archive = join(root, "cancel.tar");
    writeTarFixture(archive, appEntries());
    const inspectController = new AbortController();
    const inspection = inspectUpdateArchive(archive, undefined, inspectController.signal);
    inspectController.abort();
    await expectArchiveCode(inspection, "archiveCancelled");

    const inspection2 = await inspectUpdateArchive(archive);
    const destination = join(root, "extracted-cancel");
    const extractController = new AbortController();
    const extraction = extractAdmittedArchive(inspection2, destination, extractController.signal);
    extractController.abort();
    await expect(extraction).rejects.toMatchObject({ code: "archiveCancelled" });
    await expect(
      import("node:fs/promises").then(({ lstat }) => lstat(destination)),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checks the original combined ustar prefix/name at 255 and 256 bytes", async () => {
  const root = await directory();
  try {
    const { tarHeader } = await import("../fixtures/updater");
    for (const bytes of [255, 256]) {
      const prefix = `MCP Gateway.app/${"p".repeat(155 - "MCP Gateway.app/".length)}`;
      const name = `${"n".repeat(bytes - 157)}/`;
      const header = tarHeader({ name, type: "5", mode: 0o755 });
      header.set(Buffer.from(prefix), 345);
      header.fill(32, 148, 156);
      header.set(
        Buffer.from(
          `${header
            .reduce((sum, byte) => sum + byte, 0)
            .toString(8)
            .padStart(6, "0")}\0 `,
        ),
        148,
      );
      const base = tarBytes(appEntries());
      const path = join(root, `raw-${bytes}.tar`);
      await writeFile(
        path,
        Buffer.concat([base.subarray(0, base.length - 1024), header, new Uint8Array(1024)]),
        { mode: 0o600 },
      );
      expect(Buffer.byteLength(`${prefix}/${name}`)).toBe(bytes);
      if (bytes === 255)
        expect((await inspectUpdateArchive(path)).entries.at(-1)?.path.length).toBe(254);
      else await expectArchiveCode(inspectUpdateArchive(path), "unsafePath");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps explicit header and materialized entry limits distinct", async () => {
  const root = await directory();
  try {
    const path = join(root, "separate-limits.tar");
    writeTarFixture(
      path,
      appEntries({
        extra: [{ name: "MCP Gateway.app/Contents/Resources/a/b/c/d/e/f/g/value", contents: "x" }],
      }),
    );
    const limits = {
      maxArchiveBytes: 65536,
      maxEntries: 12,
      maxMaterializedEntries: 20,
      maxEntryBytes: 65536,
      maxTotalBytes: 65536,
      maxPathBytes: 255,
    };
    expect((await inspectUpdateArchive(path, limits)).entries.length).toBe(12);
    await expectArchiveCode(
      inspectUpdateArchive(path, { ...limits, maxEntries: 11 }),
      "tooManyEntries",
    );
    await expectArchiveCode(
      inspectUpdateArchive(path, { ...limits, maxMaterializedEntries: 19 }),
      "tooManyEntries",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("counts sparse implicit parents before any extraction materializes them", async () => {
  const root = await directory();
  try {
    const entries = appEntries({
      extra: [{ name: "MCP Gateway.app/Contents/Resources/a/b/c/d/e/f/g/value", contents: "x" }],
    });
    const path = join(root, "sparse.tar");
    writeTarFixture(path, entries);
    await expectArchiveCode(
      inspectUpdateArchive(path, {
        maxArchiveBytes: 65536,
        maxEntries: entries.length,
        maxEntryBytes: 65536,
        maxTotalBytes: 65536,
        maxPathBytes: 255,
      }),
      "tooManyEntries",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
