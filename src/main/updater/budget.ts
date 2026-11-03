import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_COMPRESSED_ARTIFACT_BYTES,
  MAX_EXPANDED_ARCHIVE_BYTES,
  MAX_STAGING_BYTES,
} from "./constants";
import { UpdaterStateError } from "./storage";

export const MAX_RECOVERY_TREE_BYTES = 1024 * 1024 * 1024;
export const MAX_CANDIDATE_METADATA_BYTES = 64 * 1024 * 1024;
export const MAX_MATERIALIZED_DIRECTORY_OVERHEAD_BYTES = 128 * 1024 * 1024;
export const MAX_UPDATE_TREE_FILES = 100_000;
export const MAX_UPDATE_TREE_ENTRIES = 120_000;

/**
 * Peak layout for one full-archive-only update attempt. The phases are
 * deliberately summed rather than treating overlap as free space: the SDK
 * compressed download, retained TAR, frozen copy, extracted verification tree,
 * previous recovery tree and recovery staging can coexist at a phase boundary.
 */
export const UPDATE_STORAGE_LAYOUT = Object.freeze({
  compressedDownload: MAX_COMPRESSED_ARTIFACT_BYTES,
  expandedTar: MAX_EXPANDED_ARCHIVE_BYTES,
  frozenCopy: MAX_EXPANDED_ARCHIVE_BYTES,
  extractedVerification: MAX_EXPANDED_ARCHIVE_BYTES,
  existingRecovery: MAX_RECOVERY_TREE_BYTES,
  recoveryStaging: MAX_RECOVERY_TREE_BYTES,
  candidateMetadata: MAX_CANDIDATE_METADATA_BYTES,
  materializedDirectories: MAX_MATERIALIZED_DIRECTORY_OVERHEAD_BYTES,
});

export const UPDATE_STORAGE_PEAK_BYTES =
  UPDATE_STORAGE_LAYOUT.compressedDownload +
  UPDATE_STORAGE_LAYOUT.expandedTar +
  UPDATE_STORAGE_LAYOUT.frozenCopy +
  UPDATE_STORAGE_LAYOUT.extractedVerification +
  UPDATE_STORAGE_LAYOUT.existingRecovery +
  UPDATE_STORAGE_LAYOUT.recoveryStaging +
  UPDATE_STORAGE_LAYOUT.candidateMetadata +
  UPDATE_STORAGE_LAYOUT.materializedDirectories;

export interface UpdateStorageLimits {
  compressedBytes: number;
  expandedTarBytes: number;
  frozenCopyBytes: number;
  extractedTreeBytes: number;
  recoveryTreeBytes: number;
  currentTreeBytes: number;
  candidateMetadataBytes: number;
  materializedDirectoryBytes: number;
  aggregateBytes: number;
  maxFiles: number;
  maxEntries: number;
}

export const DEFAULT_UPDATE_STORAGE_LIMITS: UpdateStorageLimits = Object.freeze({
  compressedBytes: UPDATE_STORAGE_LAYOUT.compressedDownload,
  expandedTarBytes: UPDATE_STORAGE_LAYOUT.expandedTar,
  frozenCopyBytes: UPDATE_STORAGE_LAYOUT.frozenCopy,
  extractedTreeBytes: UPDATE_STORAGE_LAYOUT.extractedVerification,
  recoveryTreeBytes: UPDATE_STORAGE_LAYOUT.existingRecovery,
  currentTreeBytes: UPDATE_STORAGE_LAYOUT.existingRecovery,
  candidateMetadataBytes: UPDATE_STORAGE_LAYOUT.candidateMetadata,
  materializedDirectoryBytes: MAX_MATERIALIZED_DIRECTORY_OVERHEAD_BYTES,
  aggregateBytes: MAX_STAGING_BYTES,
  maxFiles: MAX_UPDATE_TREE_FILES,
  maxEntries: MAX_UPDATE_TREE_ENTRIES,
});

export interface TreeUsage {
  bytes: number;
  payloadBytes: number;
  overheadBytes: number;
  files: number;
  entries: number;
  directories: number;
}

export interface TreeLimit {
  maxBytes: number;
  maxFiles: number;
  maxEntries: number;
  signal?: AbortSignal;
  label: string;
  excludePath?: string;
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new UpdaterStateError("cancelled");
}

function allowMissing(error: unknown): undefined {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
  throw error;
}

function checkLimit(usage: TreeUsage, limit: TreeLimit): void {
  if (
    usage.payloadBytes > limit.maxBytes ||
    usage.files > limit.maxFiles ||
    usage.entries > limit.maxEntries
  )
    throw new UpdaterStateError("storageBudget");
}

export async function treeUsage(path: string, limit: TreeLimit): Promise<TreeUsage> {
  const usage: TreeUsage = {
    bytes: 0,
    payloadBytes: 0,
    overheadBytes: 0,
    files: 0,
    entries: 0,
    directories: 0,
  };
  async function visit(current: string): Promise<void> {
    cancelled(limit.signal);
    if (limit.excludePath && current === limit.excludePath) return;
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new UpdaterStateError("stateSymlink");
    usage.entries++;
    if (info.isDirectory()) {
      usage.directories++;
      // Count the materialized directory itself, not only leaf files.
      const overhead = Math.max(0, Number(info.blocks) * 512);
      usage.overheadBytes += overhead;
      usage.bytes += overhead;
      checkLimit(usage, limit);
      for (const name of await readdir(current)) await visit(join(current, name));
      return;
    }
    if (!info.isFile()) throw new UpdaterStateError("stateType");
    usage.files++;
    const overhead = Math.max(0, Number(info.blocks) * 512 - info.size);
    usage.payloadBytes += info.size;
    usage.overheadBytes += overhead;
    usage.bytes += info.size + overhead;
    checkLimit(usage, limit);
  }
  await visit(path);
  cancelled(limit.signal);
  checkLimit(usage, limit);
  return usage;
}

export interface StorageBudgetOptions {
  channelRoot: string;
  dataDirectory: string;
  extractedRoot?: string;
  appBundlePath?: string;
  limits?: UpdateStorageLimits;
  signal?: AbortSignal;
}

export interface StorageBudgetUsage {
  compressedBytes: number;
  expandedTarBytes: number;
  frozenCopyBytes: number;
  extractedBytes: number;
  recoveryBytes: number;
  currentBytes: number;
  metadataBytes: number;
  materializedDirectoryBytes: number;
  temporaryBytes: number;
  aggregateBytes: number;
}

function fileBudget(
  name: string,
  bytes: number,
  usage: StorageBudgetUsage,
  limits: UpdateStorageLimits,
): void {
  if (name.endsWith(".tar.zst") || name.endsWith(".tar.zst.partial"))
    usage.compressedBytes += bytes;
  else if (name.endsWith(".frozen")) usage.frozenCopyBytes += bytes;
  else if (name.endsWith(".tar") || name.endsWith(".tar.partial")) usage.expandedTarBytes += bytes;
  else usage.metadataBytes += bytes;
  if (
    usage.compressedBytes > limits.compressedBytes ||
    usage.expandedTarBytes > limits.expandedTarBytes ||
    usage.frozenCopyBytes > limits.frozenCopyBytes ||
    usage.metadataBytes > limits.candidateMetadataBytes
  )
    throw new UpdaterStateError("storageBudget");
}

export async function assertStorageBudget(
  options: StorageBudgetOptions,
): Promise<StorageBudgetUsage> {
  const limits = options.limits ?? DEFAULT_UPDATE_STORAGE_LIMITS;
  const usage: StorageBudgetUsage = {
    compressedBytes: 0,
    expandedTarBytes: 0,
    frozenCopyBytes: 0,
    extractedBytes: 0,
    recoveryBytes: 0,
    currentBytes: 0,
    metadataBytes: 0,
    materializedDirectoryBytes: 0,
    temporaryBytes: 0,
    aggregateBytes: 0,
  };
  const signal = options.signal;
  cancelled(signal);
  const staging = join(options.channelRoot, "self-extraction");
  const stagingInfo = await lstat(staging).catch(allowMissing);
  if (stagingInfo) {
    if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory())
      throw new UpdaterStateError("storageBudget");
    usage.materializedDirectoryBytes += Math.max(0, Number(stagingInfo.blocks) * 512);
  }
  for (const name of stagingInfo ? await readdir(staging) : []) {
    cancelled(signal);
    const path = join(staging, name);
    const info = await lstat(path).catch(allowMissing);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile()) throw new UpdaterStateError("storageBudget");
    fileBudget(name, info.size, usage, limits);
    usage.materializedDirectoryBytes += Math.max(0, Number(info.blocks) * 512 - info.size);
  }
  for (const [root, category] of [
    [join(options.dataDirectory, "updates/candidates"), "metadata"],
    [join(options.dataDirectory, "updates/recovery"), "recovery"],
    [join(options.dataDirectory, "updates/tmp"), "materialized"],
  ] as const) {
    const info = await lstat(root).catch(allowMissing);
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isDirectory()) throw new UpdaterStateError("storageBudget");
    const tree = await treeUsage(root, {
      maxBytes:
        category === "metadata"
          ? limits.candidateMetadataBytes
          : category === "recovery"
            ? limits.recoveryTreeBytes
            : limits.aggregateBytes,
      maxFiles: limits.maxFiles,
      maxEntries: limits.maxEntries,
      ...(signal ? { signal } : {}),
      ...(options.extractedRoot ? { excludePath: options.extractedRoot } : {}),
      label: category,
    });
    usage.materializedDirectoryBytes += tree.overheadBytes;
    if (category === "metadata") usage.metadataBytes += tree.payloadBytes;
    else if (category === "recovery") usage.recoveryBytes += tree.payloadBytes;
    else usage.temporaryBytes += tree.payloadBytes;
  }
  if (options.appBundlePath) {
    const tree = await treeUsage(options.appBundlePath, {
      maxBytes: limits.currentTreeBytes,
      maxFiles: limits.maxFiles,
      maxEntries: limits.maxEntries,
      ...(signal ? { signal } : {}),
      label: "current",
    });
    usage.currentBytes = tree.payloadBytes;
    usage.materializedDirectoryBytes += tree.overheadBytes;
  }
  if (options.extractedRoot) {
    const tree = await treeUsage(options.extractedRoot, {
      maxBytes: limits.extractedTreeBytes,
      maxFiles: limits.maxFiles,
      maxEntries: limits.maxEntries,
      ...(signal ? { signal } : {}),
      label: "extracted",
    });
    usage.extractedBytes = tree.payloadBytes;
    usage.materializedDirectoryBytes += tree.overheadBytes;
  }
  usage.aggregateBytes =
    usage.compressedBytes +
    usage.expandedTarBytes +
    usage.frozenCopyBytes +
    usage.extractedBytes +
    usage.recoveryBytes +
    usage.currentBytes +
    usage.metadataBytes +
    usage.temporaryBytes +
    usage.materializedDirectoryBytes;
  if (
    usage.metadataBytes > limits.candidateMetadataBytes ||
    usage.materializedDirectoryBytes > limits.materializedDirectoryBytes ||
    usage.aggregateBytes > limits.aggregateBytes
  )
    throw new UpdaterStateError("storageBudget");
  return usage;
}

export function assertLayoutConstants(): void {
  if (UPDATE_STORAGE_PEAK_BYTES > MAX_STAGING_BYTES) throw new UpdaterStateError("storageBudget");
}
