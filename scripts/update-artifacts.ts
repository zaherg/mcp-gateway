import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

import { STABLE_VERSION_PATTERN } from './build-config';

export const UPDATE_FILES = {
  manifest: 'stable-macos-arm64-update.json',
  integrity: 'stable-macos-arm64-update-v2.json',
  archive: 'stable-macos-arm64-MCPGateway.app.tar.zst',
} as const;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

interface UpdateManifest {
  schemaVersion: 1;
  identifier: string;
  channel: 'stable';
  version: string;
  hash: string;
  platform: 'macos';
  arch: 'arm64';
  artifact: { file: string; tarSha256?: string; tarSize?: number };
}

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Update metadata must be an object.');
  return value as Record<string, unknown>;
};

const parseManifest = (text: string, identifier: string, version?: string): UpdateManifest => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Update manifest contains invalid JSON.');
  }
  const manifest = record(value);
  const artifact = record(manifest.artifact);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.identifier !== identifier ||
    manifest.channel !== 'stable' ||
    typeof manifest.version !== 'string' ||
    !STABLE_VERSION_PATTERN.test(manifest.version) ||
    (version !== undefined && manifest.version !== version) ||
    typeof manifest.hash !== 'string' ||
    !/^[a-z0-9]{1,13}$/.test(manifest.hash) ||
    manifest.platform !== 'macos' ||
    manifest.arch !== 'arm64' ||
    artifact.file !== UPDATE_FILES.archive
  )
    throw new Error('Update manifest does not match the app identity, version, or artifact name.');
  return {
    schemaVersion: 1,
    identifier,
    channel: 'stable',
    version: manifest.version,
    hash: manifest.hash,
    platform: 'macos',
    arch: 'arm64',
    artifact: {
      file: UPDATE_FILES.archive,
      ...(typeof artifact.tarSha256 === 'string' ? { tarSha256: artifact.tarSha256 } : {}),
      ...(typeof artifact.tarSize === 'number' ? { tarSize: artifact.tarSize } : {}),
    },
  };
};

export const hashFile = async (path: string, signal?: AbortSignal): Promise<string> => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted();
    digest.update(chunk);
  }
  return digest.digest('hex');
};

export const readUpdateArtifacts = async (
  directory: string,
  expected: { identifier: string; version?: string },
  signal?: AbortSignal,
) => {
  for (const file of Object.values(UPDATE_FILES)) {
    const info = await lstat(join(directory, file));
    const limit = file === UPDATE_FILES.archive ? MAX_ARCHIVE_BYTES : MAX_MANIFEST_BYTES;
    if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > limit)
      throw new Error('Update artifact is missing, unsafe, or exceeds its size limit.');
  }
  const manifest = parseManifest(
    await readFile(join(directory, UPDATE_FILES.manifest), 'utf8'),
    expected.identifier,
    expected.version,
  );
  const integrity = parseManifest(
    await readFile(join(directory, UPDATE_FILES.integrity), 'utf8'),
    expected.identifier,
    expected.version,
  );
  for (const key of [
    'schemaVersion',
    'identifier',
    'channel',
    'version',
    'hash',
    'platform',
    'arch',
  ] as const)
    if (integrity[key] !== manifest[key]) throw new Error(`Update manifests disagree on ${key}.`);
  const { tarSha256, tarSize } = integrity.artifact;
  if (
    typeof tarSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(tarSha256) ||
    typeof tarSize !== 'number' ||
    !Number.isSafeInteger(tarSize) ||
    tarSize <= 0 ||
    tarSize > MAX_ARCHIVE_BYTES
  )
    throw new Error('Update integrity manifest has invalid expanded archive metadata.');
  const digest = createHash('sha256');
  let size = 0;
  await pipeline(
    createReadStream(join(directory, UPDATE_FILES.archive)),
    createZstdDecompress(),
    async (chunks) => {
      for await (const chunk of chunks) {
        signal?.throwIfAborted();
        size += chunk.length;
        if (size > MAX_ARCHIVE_BYTES)
          throw new Error('Update archive exceeds the expanded size limit.');
        digest.update(chunk);
      }
    },
  );
  const sha256 = digest.digest('hex');
  if (sha256 !== tarSha256 || size !== tarSize)
    throw new Error('Update archive integrity metadata mismatch.');
  return { manifest, integrity, expanded: { sha256, size } };
};
