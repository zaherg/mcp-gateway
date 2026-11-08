import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

interface BundleInventoryEntry {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  size: number;
  sha256?: string;
  link?: string;
}

class ReleaseInventoryError extends Error {
  readonly differences: string[];
  constructor(differences: string[]) {
    super(`Bundle inventories differ: ${differences.slice(0, 8).join(", ")}`);
    this.name = "ReleaseInventoryError";
    this.differences = differences;
  }
}

export const inventoryBundle = async (
  rootPath: string,
  signal?: AbortSignal,
): Promise<BundleInventoryEntry[]> => {
  const root = resolve(rootPath);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("Bundle inventory root is not a plain directory.");
  const entries: BundleInventoryEntry[] = [];
  const visit = async (path: string): Promise<void> => {
    signal?.throwIfAborted();
    const info = await lstat(path);
    const entryPath = relative(root, path) || ".";
    const mode = info.mode & 0o7777;
    if (info.isSymbolicLink()) {
      entries.push({ path: entryPath, type: "symlink", mode, size: 0, link: await readlink(path) });
      return;
    }
    if (info.isDirectory()) {
      entries.push({ path: entryPath, type: "directory", mode, size: 0 });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
      return;
    }
    if (!info.isFile()) throw new Error(`Bundle contains an unsupported entry: ${entryPath}`);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.dev !== info.dev || before.ino !== info.ino)
        throw new Error("Bundle changed while inventorying.");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        signal?.throwIfAborted();
        hash.update(chunk);
      }
      const after = await file.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("Bundle changed while inventorying.");
      entries.push({
        path: entryPath,
        type: "file",
        mode,
        size: before.size,
        sha256: hash.digest("hex"),
      });
    } finally {
      await file.close();
    }
  };
  await visit(root);
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return entries;
};

export const compareBundleInventories = (
  expected: BundleInventoryEntry[],
  actual: BundleInventoryEntry[],
  labels = { expected: "expected", actual: "actual" },
): void => {
  const differences: string[] = [];
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  for (const path of new Set([...expectedByPath.keys(), ...actualByPath.keys()])) {
    const left = expectedByPath.get(path);
    const right = actualByPath.get(path);
    if (!left || !right) {
      differences.push(`${path} missing from ${left ? labels.actual : labels.expected}`);
      continue;
    }
    if (
      left.type !== right.type ||
      left.mode !== right.mode ||
      left.size !== right.size ||
      left.sha256 !== right.sha256 ||
      left.link !== right.link
    )
      differences.push(`${path} differs`);
  }
  if (differences.length > 0) throw new ReleaseInventoryError(differences);
};

export const inventoryDigest = (entries: BundleInventoryEntry[]): string => {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
};
