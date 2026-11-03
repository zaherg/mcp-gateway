import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { failure } from "./errors";

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export async function safeParent(path: string, allowMissing = false): Promise<void> {
  const parent = dirname(path);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!allowMissing || !missing(error)) throw error;
      await safeParent(current);
      return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw failure("UnsafeFile", "Configuration paths must not contain symlinks.");
  }
  const stat = await fs.lstat(parent);
  if ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw failure(
      "UnsafeFile",
      "The configuration directory must be owned by this user and not writable by others.",
    );
}

export async function ensureParent(path: string): Promise<void> {
  const parent = dirname(path);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!missing(error)) throw error;
      await safeParent(current);
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw failure("UnsafeFile", "Configuration paths must not contain symlinks.");
  }
  await safeParent(path);
}
