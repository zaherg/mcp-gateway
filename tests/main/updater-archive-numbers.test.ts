import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractAdmittedArchive, inspectUpdateArchive } from "../../src/main/updater/archive";
import { appEntries, tarBytes } from "../fixtures/updater";

function checksum(bytes: Uint8Array): void {
  bytes.fill(32, 148, 156);
  const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  bytes.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
}

for (const [field, start, length] of [
  ["size", 124, 12],
  ["mode", 100, 8],
  ["checksum", 148, 8],
] as const) {
  for (const corruption of [
    "high-bit",
    "digit-eight",
    "leading-space",
    "embedded-nul",
    "trailing-junk",
  ] as const) {
    test(`archive rejects original ${field} bytes with ${corruption}`, async () => {
      const root = await mkdtemp(resolve(".cache/archive-numbers-"));
      try {
        const bytes = tarBytes(appEntries());
        if (corruption === "high-bit") bytes[start] |= 0x80;
        if (corruption === "digit-eight") bytes[start] = 0x38;
        if (corruption === "leading-space") bytes[start] = 0x20;
        if (corruption === "embedded-nul") bytes[start] = 0;
        if (corruption === "trailing-junk") bytes[start + length - 1] = 0x78;
        if (field !== "checksum") checksum(bytes);
        const path = join(root, "invalid.tar");
        await writeFile(path, bytes, { mode: 0o600 });
        await expect(inspectUpdateArchive(path)).rejects.toMatchObject({ code: "invalidHeader" });
      } finally {
        await rm(root, { recursive: true });
      }
    });
  }
}

for (const mode of ["0000755\0", "0000755 ", "755\0    ", "00000755"]) {
  test(`archive supported numeric padding ${JSON.stringify(mode)} extracts identical bytes`, async () => {
    const root = await mkdtemp(resolve(".cache/archive-padding-"));
    try {
      const entries = appEntries();
      const bytes = tarBytes(entries);
      bytes.set(Buffer.from(mode), 100);
      bytes.set(Buffer.from("0\0          "), 124);
      checksum(bytes);
      const path = join(root, "valid.tar");
      await writeFile(path, bytes, { mode: 0o600 });
      const inspected = await inspectUpdateArchive(path);
      expect(inspected.entries[0]).toMatchObject({ mode: 0o755, size: 0 });
      const destination = join(root, "extracted");
      await extractAdmittedArchive(inspected, destination);
      for (const entry of entries) {
        if (entry.contents !== undefined) {
          expect(await readFile(join(destination, entry.name))).toEqual(
            Buffer.from(entry.contents),
          );
        }
      }
    } finally {
      await rm(root, { recursive: true });
    }
  });
}

test("maximum octal size is refused by the existing per-entry bound without rounding or overflow", async () => {
  const root = await mkdtemp(resolve(".cache/archive-large-number-"));
  try {
    // A real file path must reach numeric admission, not the directory trailing-slash refusal.
    const bytes = tarBytes([{ name: "MCP Gateway.app/oversized", contents: "" }, ...appEntries()]);
    bytes.set(Buffer.from("777777777777"), 124);
    checksum(bytes);
    const path = join(root, "large.tar");
    await writeFile(path, bytes, { mode: 0o600 });
    await expect(inspectUpdateArchive(path)).rejects.toMatchObject({ code: "entryTooLarge" });
  } finally {
    await rm(root, { recursive: true });
  }
});
