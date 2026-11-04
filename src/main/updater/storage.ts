import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ensureParent, safeParent } from "../../core/private-parent";

const MAX_STATE_BYTES = 64 * 1024;

export class UpdaterStateError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "UpdaterStateError";
    this.code = code;
  }
}

function assertOwned(info: Awaited<ReturnType<typeof lstat>>): void {
  if (info.isSymbolicLink()) throw new UpdaterStateError("stateSymlink");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new UpdaterStateError("stateOwner");
}

export async function assertManagedDirectory(path: string): Promise<void> {
  try {
    await safeParent(join(path, ".mcp-directory-check"), true);
  } catch {
    throw new UpdaterStateError("stateDirectory");
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await ensureParent(join(path, ".mcp-directory-check"));
  } catch {
    throw new UpdaterStateError("stateDirectory");
  }
  const info = await lstat(path);
  assertOwned(info);
  if (!info.isDirectory()) throw new UpdaterStateError("stateDirectory");
  if ((info.mode & 0o077) !== 0) throw new UpdaterStateError("statePermissions");
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new UpdaterStateError("stateWrite");
    offset += written;
  }
}

function assertPrivateFile(info: Stats): void {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new UpdaterStateError("stateDestination");
}

function assertPrivateDirectory(info: Stats): void {
  if (info.isSymbolicLink() || !info.isDirectory()) throw new UpdaterStateError("stateDirectory");
  if ((info.mode & 0o077) !== 0) throw new UpdaterStateError("statePermissions");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new UpdaterStateError("stateOwner");
}

export function syncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_DIRECTORY,
  );
  try {
    assertPrivateDirectory(fstatSync(descriptor));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function ensurePrivateDirectorySync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(lstatSync(path));
}

/**
 * Commit a small approval/binding record before returning to the native caller.
 * Large update work must remain asynchronous; this writer is bounded and only
 * converts the final checked metadata transition into a synced atomic rename.
 * onPublished runs after rename, before validation and directory sync can fail.
 * Publication alone does not confirm validity or durability.
 */
export function atomicWritePrivateJsonSync(
  path: string,
  value: unknown,
  onPublished?: () => void,
): void {
  const directory = dirname(path);
  ensurePrivateDirectorySync(directory);
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_STATE_BYTES) throw new UpdaterStateError("stateDocument");
  const partial = `${path}.${randomBytes(8).toString("hex")}.partial`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      partial,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    assertPrivateFile(fstatSync(descriptor));
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      throw new UpdaterStateError("stateDestination");
    renameSync(partial, path);
    onPublished?.();
    const published = lstatSync(path);
    assertOwned(published);
    if (!published.isFile() || published.size !== bytes.length)
      throw new UpdaterStateError("stateWrite");
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    try {
      unlinkSync(partial);
    } catch {}
  }
}

function readBoundedSync(path: string, options: { requirePrivateMode: boolean }): unknown {
  const entry = lstatSync(path);
  assertOwned(entry);
  if (!entry.isFile() || entry.size <= 0 || entry.size > MAX_STATE_BYTES)
    throw new UpdaterStateError("stateDocument");
  if (options.requirePrivateMode) {
    if ((entry.mode & 0o077) !== 0) throw new UpdaterStateError("statePermissions");
  } else if ((entry.mode & 0o022) !== 0) {
    throw new UpdaterStateError("statePermissions");
  }
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor);
    assertOwned(before);
    if (
      !before.isFile() ||
      before.ino !== entry.ino ||
      before.dev !== entry.dev ||
      before.size <= 0 ||
      before.size > MAX_STATE_BYTES ||
      (options.requirePrivateMode ? (before.mode & 0o077) !== 0 : (before.mode & 0o022) !== 0)
    )
      throw new UpdaterStateError("stateDocument");
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (
      length > MAX_STATE_BYTES ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      pathAfter.dev !== entry.dev ||
      pathAfter.ino !== entry.ino ||
      pathAfter.mtimeMs !== entry.mtimeMs ||
      pathAfter.ctimeMs !== entry.ctimeMs
    )
      throw new UpdaterStateError("stateDocument");
    try {
      return JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } catch {
      throw new UpdaterStateError("stateDocument");
    }
  } finally {
    closeSync(descriptor);
  }
}

/** Read a small journal record synchronously under the held kernel guard. */
export function readPrivateJsonSync(path: string): unknown {
  return readBoundedSync(path, { requirePrivateMode: true });
}

/**
 * Native SDK plans/results are creator-umask files in the private channel root,
 * so read bits are allowed while group/other write access stays refused.
 */
export function readNativeJsonSync(path: string): unknown {
  return readBoundedSync(path, { requirePrivateMode: false });
}

export async function atomicWritePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const partial = `${path}.${randomBytes(8).toString("hex")}.partial`;
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  if (bytes.length > MAX_STATE_BYTES) throw new UpdaterStateError("stateDocument");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(partial, "wx", 0o600);
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const existing = await lstat(path).catch(() => undefined);
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      throw new UpdaterStateError("stateDestination");
    await rename(partial, path);
    const published = await lstat(path);
    assertOwned(published);
    if (!published.isFile() || published.size !== bytes.length)
      throw new UpdaterStateError("stateWrite");
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    await rm(partial, { force: true });
  }
}

export async function readPrivateJson(
  path: string,
  afterOpen?: () => Promise<void>,
): Promise<unknown> {
  const entry = await lstat(path);
  assertOwned(entry);
  if (!entry.isFile() || entry.size <= 0 || entry.size > MAX_STATE_BYTES)
    throw new UpdaterStateError("stateDocument");
  if ((entry.mode & 0o077) !== 0) throw new UpdaterStateError("statePermissions");
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    assertOwned(before);
    if (
      !before.isFile() ||
      before.ino !== entry.ino ||
      before.dev !== entry.dev ||
      before.size <= 0 ||
      before.size > MAX_STATE_BYTES ||
      (before.mode & 0o077) !== 0
    )
      throw new UpdaterStateError("stateDocument");
    await afterOpen?.();
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await handle.stat();
    const pathAfter = await lstat(path);
    if (
      length > MAX_STATE_BYTES ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      pathAfter.dev !== entry.dev ||
      pathAfter.ino !== entry.ino ||
      pathAfter.mtimeMs !== entry.mtimeMs ||
      pathAfter.ctimeMs !== entry.ctimeMs
    )
      throw new UpdaterStateError("stateDocument");
    try {
      return JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } catch {
      throw new UpdaterStateError("stateDocument");
    }
  } finally {
    await handle.close();
  }
}

export async function removePrivateFile(path: string): Promise<void> {
  const info = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  assertOwned(info);
  if (!info.isFile()) throw new UpdaterStateError("stateDestination");
  await rm(path, { force: true });
}
