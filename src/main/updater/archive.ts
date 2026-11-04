import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MAX_UPDATE_TREE_ENTRIES, MAX_UPDATE_TREE_FILES } from "./budget";
import {
  MAX_EXPANDED_ARCHIVE_BYTES,
  requiredBundleExecutables,
  UPDATER_HASH_PATTERN,
} from "./constants";

const BLOCK_BYTES = 512;
const DEFAULT_MAX_ARCHIVE_BYTES = MAX_EXPANDED_ARCHIVE_BYTES;
const DEFAULT_MAX_ENTRIES = MAX_UPDATE_TREE_FILES;
const DEFAULT_MAX_ENTRY_BYTES = MAX_EXPANDED_ARCHIVE_BYTES;
const DEFAULT_MAX_TOTAL_BYTES = MAX_EXPANDED_ARCHIVE_BYTES;
const DEFAULT_MAX_PATH_BYTES = 255;

export type UpdateArchiveErrorCode =
  | "archiveUnavailable"
  | "archiveCancelled"
  | "archiveChanged"
  | "archiveTooLarge"
  | "archiveTruncated"
  | "archiveTrailingData"
  | "invalidHeader"
  | "unsupportedEntry"
  | "unsafePath"
  | "unsafeMode"
  | "duplicateEntry"
  | "conflictingEntry"
  | "invalidBundleLayout"
  | "tooManyEntries"
  | "entryTooLarge"
  | "totalSizeExceeded";

export class UpdateArchiveError extends Error {
  readonly code: UpdateArchiveErrorCode;

  constructor(code: UpdateArchiveErrorCode) {
    const messages: Record<UpdateArchiveErrorCode, string> = {
      archiveUnavailable: "The downloaded update archive is unavailable.",
      archiveCancelled: "Update archive work was cancelled.",
      archiveChanged: "The downloaded update archive changed during verification.",
      archiveTooLarge: "The downloaded update archive is too large.",
      archiveTruncated: "The downloaded update archive is truncated.",
      archiveTrailingData: "The downloaded update archive has unexpected trailing data.",
      invalidHeader: "The downloaded update archive has an invalid header.",
      unsupportedEntry: "The downloaded update archive contains an unsupported entry.",
      unsafePath: "The downloaded update archive contains an unsafe path.",
      unsafeMode: "The downloaded update archive contains an unsafe file mode.",
      duplicateEntry: "The downloaded update archive contains duplicate entries.",
      conflictingEntry: "The downloaded update archive contains conflicting entries.",
      invalidBundleLayout: "The downloaded update archive does not contain one application bundle.",
      tooManyEntries: "The downloaded update archive contains too many entries.",
      entryTooLarge: "The downloaded update archive contains an entry that is too large.",
      totalSizeExceeded: "The downloaded update archive expands beyond the allowed size.",
    };
    super(messages[code]);
    this.name = "UpdateArchiveError";
    this.code = code;
  }
}

export interface UpdateArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxMaterializedEntries?: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxPathBytes: number;
}

export interface UpdateArchiveEntry {
  path: string;
  type: "file" | "directory";
  mode: number;
  size: number;
  bodyOffset: number;
}

export interface UpdateArchiveInspection {
  path: string;
  bytes: number;
  sha256: string;
  bundleName: string;
  entries: UpdateArchiveEntry[];
}

const defaultLimits: UpdateArchiveLimits = {
  maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES,
  maxEntries: DEFAULT_MAX_ENTRIES,
  maxMaterializedEntries: MAX_UPDATE_TREE_ENTRIES,
  maxEntryBytes: DEFAULT_MAX_ENTRY_BYTES,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
  maxPathBytes: DEFAULT_MAX_PATH_BYTES,
};

function fail(code: UpdateArchiveErrorCode): never {
  throw new UpdateArchiveError(code);
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail("archiveCancelled");
}

function field(header: Buffer, offset: number, length: number): Buffer {
  return header.subarray(offset, offset + length);
}

function cString(value: Buffer): string {
  const end = value.indexOf(0);
  const content = end === -1 ? value : value.subarray(0, end);
  const tail = end === -1 ? Buffer.alloc(0) : value.subarray(end + 1);
  if (tail.some((byte) => byte !== 0)) fail("invalidHeader");
  if (content.includes(0)) fail("invalidHeader");
  return content.toString("utf8");
}

function octal(value: Buffer): number {
  let parsed = 0;
  let padding = false;
  // The pinned native extractor permits trailing spaces/NULs, not leading whitespace.
  for (const byte of value) {
    if (byte === 0 || byte === 0x20) {
      padding = true;
      continue;
    }
    if (padding || byte < 0x30 || byte > 0x37) fail("invalidHeader");
    parsed = parsed * 8 + byte - 0x30;
    if (!Number.isSafeInteger(parsed)) fail("invalidHeader");
  }
  return parsed;
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < header.length; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  return sum;
}

function validChecksum(header: Buffer): boolean {
  return octal(field(header, 148, 8)) === headerChecksum(header);
}

function pathComponents(value: string): string[] {
  if (value.length === 0 || value.includes("\\") || value.startsWith("/")) fail("unsafePath");
  const components = value.split("/");
  if (
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  )
    fail("unsafePath");
  return components;
}

function readPath(header: Buffer, limits: UpdateArchiveLimits, type: "file" | "directory"): string {
  const name = cString(field(header, 0, 100));
  const prefix = cString(field(header, 345, 155));
  if (name.length === 0) fail("invalidHeader");
  let value = prefix.length > 0 ? `${prefix}/${name}` : name;
  // Native extraction combines the original ustar fields in a 255-byte buffer.
  if (Buffer.byteLength(value, "utf8") > Math.min(255, limits.maxPathBytes)) fail("unsafePath");
  if (type === "directory" && value.endsWith("/")) value = value.slice(0, -1);
  if (value.length === 0 || (type === "file" && value.endsWith("/"))) fail("unsafePath");
  if (Buffer.byteLength(value, "utf8") > limits.maxPathBytes) fail("unsafePath");
  pathComponents(value);
  return value;
}

function readHeaderType(header: Buffer): "file" | "directory" {
  const type = field(header, 156, 1).toString("latin1");
  if (type === "0") return "file";
  if (type === "5") return "directory";
  if (type === "1") fail("unsupportedEntry");
  if (type === "2") fail("unsupportedEntry");
  if (type === "3" || type === "4" || type === "6" || type === "7") fail("unsupportedEntry");
  if (type === "g" || type === "x") fail("unsupportedEntry");
  fail("unsupportedEntry");
}

function validateHeader(header: Buffer, limits: UpdateArchiveLimits): UpdateArchiveEntry {
  if (!header.subarray(0, 512).equals(Buffer.alloc(512))) {
    if (!validChecksum(header)) fail("invalidHeader");
    if (field(header, 257, 6).toString("latin1") !== "ustar\0") fail("invalidHeader");
    if (field(header, 263, 2).toString("latin1") !== "00") fail("invalidHeader");
  }
  const type = readHeaderType(header);
  const path = readPath(header, limits, type);
  const size = octal(field(header, 124, 12));
  if (type === "directory" && size !== 0) fail("invalidHeader");
  if (size > limits.maxEntryBytes) fail("entryTooLarge");
  const mode = octal(field(header, 100, 8));
  if (mode > 0o777 || (mode & 0o022) !== 0) fail("unsafeMode");
  return { path, type, mode, size, bodyOffset: 0 };
}

function addEntry(
  entries: Map<string, UpdateArchiveEntry>,
  foldedPaths: Set<string>,
  entry: UpdateArchiveEntry,
  limits: UpdateArchiveLimits,
): void {
  if (entries.size >= limits.maxEntries) fail("tooManyEntries");
  if (entries.has(entry.path) || foldedPaths.has(entry.path.toLowerCase())) fail("duplicateEntry");
  entries.set(entry.path, entry);
  foldedPaths.add(entry.path.toLowerCase());
}

function validatePathConflicts(entries: Map<string, UpdateArchiveEntry>): void {
  for (const path of entries.keys()) {
    const components = path.split("/");
    for (let index = 1; index < components.length; index++) {
      const parent = entries.get(components.slice(0, index).join("/"));
      if (parent && parent.type !== "directory") fail("conflictingEntry");
    }
  }
}

function validateBundleLayout(entries: Map<string, UpdateArchiveEntry>): string {
  const topLevel = new Set<string>();
  for (const path of entries.keys()) topLevel.add(path.split("/")[0] ?? "");
  if (topLevel.size !== 1) fail("invalidBundleLayout");
  const bundleName = [...topLevel][0];
  if (!bundleName?.endsWith(".app") || bundleName === ".app") fail("invalidBundleLayout");
  const root = entries.get(bundleName);
  if (root?.type !== "directory") fail("invalidBundleLayout");
  for (const required of [
    `${bundleName}/Contents`,
    `${bundleName}/Contents/Resources`,
    `${bundleName}/Contents/MacOS`,
  ]) {
    const entry = entries.get(required);
    if (entry?.type !== "directory") fail("invalidBundleLayout");
  }
  for (const requiredFile of [
    `${bundleName}/Contents/Info.plist`,
    `${bundleName}/Contents/Resources/version.json`,
    `${bundleName}/Contents/Resources/uninstall`,
  ]) {
    const entry = entries.get(requiredFile);
    if (entry?.type !== "file") fail("invalidBundleLayout");
  }
  for (const relative of requiredBundleExecutables()) {
    const entry = entries.get(`${bundleName}/${relative}`);
    if (entry?.type !== "file") fail("invalidBundleLayout");
    // Extracted files belong to the current user. Group/other execute bits alone
    // do not make the owner able to launch a required runtime or update helper.
    if ((entry.mode & 0o500) !== 0o500) fail("unsafeMode");
  }
  return bundleName;
}

async function inspectStableFile(path: string, limits: UpdateArchiveLimits) {
  const resolved = resolve(path);
  if (resolved !== path) fail("unsafePath");
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) fail("archiveUnavailable");
  if (typeof process.getuid === "function" && before.uid !== process.getuid())
    fail("archiveUnavailable");
  if ((before.mode & 0o022) !== 0) fail("unsafeMode");
  if (before.size <= 0 || before.size > limits.maxArchiveBytes) fail("archiveTooLarge");
  return before;
}

async function archiveDigest(path: string, bytes: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of createReadStream(path)) {
    checkAbort(signal);
    total += chunk.byteLength;
    if (total > bytes) fail("archiveChanged");
    hash.update(chunk);
  }
  if (total !== bytes) fail("archiveChanged");
  return hash.digest("hex");
}

async function assertArchiveDigest(
  inspection: UpdateArchiveInspection,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  const info = await lstat(inspection.path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size !== inspection.bytes ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    fail("archiveChanged");
  if ((await archiveDigest(inspection.path, inspection.bytes, signal)) !== inspection.sha256)
    fail("archiveChanged");
  checkAbort(signal);
}

async function readAt(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
  signal?: AbortSignal,
) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    checkAbort(signal);
    const result = await handle.read(buffer, read, length - read, offset + read);
    if (result.bytesRead === 0) fail("archiveTruncated");
    read += result.bytesRead;
  }
  return buffer;
}

async function isAllZero(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
  signal?: AbortSignal,
) {
  let position = offset;
  let remaining = length;
  while (remaining > 0) {
    checkAbort(signal);
    const chunk = Buffer.alloc(Math.min(64 * 1024, remaining));
    const result = await handle.read(chunk, 0, chunk.length, position);
    if (result.bytesRead === 0) fail("archiveTruncated");
    if (chunk.subarray(0, result.bytesRead).some((byte) => byte !== 0)) return false;
    position += result.bytesRead;
    remaining -= result.bytesRead;
  }
  return true;
}

export async function inspectUpdateArchive(
  path: string,
  limits: UpdateArchiveLimits = defaultLimits,
  signal?: AbortSignal,
): Promise<UpdateArchiveInspection> {
  checkAbort(signal);
  const stat = await inspectStableFile(path, limits);
  checkAbort(signal);
  const handle = await open(path, "r");
  const entries = new Map<string, UpdateArchiveEntry>();
  const foldedPaths = new Set<string>();
  let offset = 0;
  let totalBytes = 0;
  let terminated = false;
  const materialized = new Set<string>([""]);
  try {
    while (offset < stat.size) {
      checkAbort(signal);
      if (stat.size - offset < BLOCK_BYTES * 2) fail("archiveTruncated");
      const header = await readAt(handle, offset, BLOCK_BYTES, signal);
      if (header.every((byte) => byte === 0)) {
        if (!(await isAllZero(handle, offset + BLOCK_BYTES, BLOCK_BYTES, signal)))
          fail("archiveTrailingData");
        if (
          !(await isAllZero(
            handle,
            offset + BLOCK_BYTES * 2,
            stat.size - offset - BLOCK_BYTES * 2,
            signal,
          ))
        )
          fail("archiveTrailingData");
        terminated = true;
        break;
      }
      const entry = validateHeader(header, limits);
      entry.bodyOffset = offset + BLOCK_BYTES;
      const rounded = Math.ceil(entry.size / BLOCK_BYTES) * BLOCK_BYTES;
      if (entry.bodyOffset + rounded > stat.size) fail("archiveTruncated");
      totalBytes += entry.size;
      if (totalBytes > limits.maxTotalBytes) fail("totalSizeExceeded");
      addEntry(entries, foldedPaths, entry, limits);
      const parts = entry.path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        materialized.add(parts.slice(0, i).join("/"));
        if (
          materialized.size >
          (limits.maxMaterializedEntries ?? Math.min(limits.maxEntries, MAX_UPDATE_TREE_ENTRIES))
        )
          fail("tooManyEntries");
      }
      offset = entry.bodyOffset + rounded;
    }
    if (!terminated) fail("archiveTruncated");
  } finally {
    await handle.close();
  }
  const after = await lstat(path);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.size !== stat.size ||
    after.mtimeMs !== stat.mtimeMs ||
    after.mode !== stat.mode
  )
    fail("archiveChanged");
  const sha256 = await archiveDigest(path, stat.size, signal);
  checkAbort(signal);
  validatePathConflicts(entries);
  const bundleName = validateBundleLayout(entries);
  return {
    path,
    bytes: stat.size,
    sha256,
    bundleName,
    entries: [...entries.values()],
  };
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Buffer,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, position + written);
    if (result.bytesWritten <= 0) throw new Error("Failed to write extracted update file");
    written += result.bytesWritten;
  }
}

function safeDestination(root: string, relative: string): string {
  const destination = resolve(root, relative);
  if (!destination.startsWith(`${root}/`)) fail("unsafePath");
  return destination;
}

export async function extractAdmittedArchive(
  inspection: UpdateArchiveInspection,
  destination: string,
  signal?: AbortSignal,
): Promise<string> {
  checkAbort(signal);
  const root = resolve(destination);
  if (root === "/" || root.length === 0) fail("unsafePath");
  await assertArchiveDigest(inspection, signal);
  await mkdir(root, { recursive: false, mode: 0o700 });
  const source = await open(inspection.path, "r");
  try {
    for (const entry of inspection.entries) {
      checkAbort(signal);
      const target = safeDestination(root, entry.path);
      if (entry.type === "directory") {
        await mkdir(target, { recursive: true, mode: 0o700 });
        continue;
      }
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "wx", entry.mode === 0 ? 0o600 : entry.mode);
      try {
        let remaining = entry.size;
        let position = entry.bodyOffset;
        while (remaining > 0) {
          checkAbort(signal);
          const chunkSize = Math.min(64 * 1024, remaining);
          const buffer = await readAt(source, position, chunkSize, signal);
          await writeAll(handle, buffer, entry.size - remaining);
          position += chunkSize;
          remaining -= chunkSize;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  } finally {
    await source.close();
  }
  await assertArchiveDigest(inspection, signal);
  checkAbort(signal);
  return join(root, inspection.bundleName);
}

export async function removePrivateDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export async function listArchiveTopLevel(path: string, signal?: AbortSignal): Promise<string[]> {
  const inspection = await inspectUpdateArchive(path, defaultLimits, signal);
  return [...new Set(inspection.entries.map((entry) => entry.path.split("/")[0] ?? ""))];
}

export function isSafePreparedHash(value: string): boolean {
  return UPDATER_HASH_PATTERN.test(value);
}

export async function readDirectoryNames(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
