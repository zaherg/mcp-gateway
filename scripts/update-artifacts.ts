import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

import { appNameFor } from '@mcp-gateway/shared/identity';
import { STABLE_VERSION_PATTERN } from './build-config';

export const releaseFiles = (identifier: string) => {
  const name = appNameFor(identifier);
  const stem = name.replaceAll(' ', '');
  return {
    bundle: `${name}.app`,
    dmg: `macos-arm64-${stem}.dmg`,
    updates: {
      manifest: 'stable-macos-arm64-update.json',
      integrity: 'stable-macos-arm64-update-v2.json',
      archive: `stable-macos-arm64-${stem}.app.tar.zst`,
    },
  };
};
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const APPLE_SECRET_ENV_NAMES = ['APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_PASSWORD'] as const;

export const watchCancelSignals = (
  reason: string,
  onCancel?: (signal: 'SIGINT' | 'SIGTERM') => void,
): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController();
  const handle = (signal: 'SIGINT' | 'SIGTERM') => {
    if (controller.signal.aborted) return;
    onCancel?.(signal);
    process.exitCode = signal === 'SIGTERM' ? 143 : 130;
    controller.abort(new Error(reason));
  };
  const onSigint = () => handle('SIGINT');
  const onSigterm = () => handle('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return {
    signal: controller.signal,
    dispose: () => {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
    },
  };
};

export const redactSecrets = (
  text: string,
  extraSecrets: ReadonlyArray<string | undefined> = [],
): string => {
  let output = text;
  for (const secret of [
    ...APPLE_SECRET_ENV_NAMES.map((name) => process.env[name]),
    ...extraSecrets,
  ]) {
    if (secret) output = output.split(secret).join('[redacted]');
  }
  return output
    .replace(
      /^(Authority|origin)=Developer ID Application:.*$/gm,
      '$1=Developer ID Application [redacted]',
    )
    .replace(/^TeamIdentifier=.*$/gm, 'TeamIdentifier=[redacted]');
};

export const redactedUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redactSecrets(raw);
  }
};

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

export const verifyEmbeddedMetadata = (
  text: string,
  expected: {
    identifier: string;
    channel?: string;
    version?: string;
    hash?: string;
    baseUrl?: string;
  },
): void => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Embedded metadata contains invalid JSON.');
  }
  const metadata = record(value);
  const channel = expected.channel ?? 'stable';
  if (
    metadata.identifier !== expected.identifier ||
    metadata.channel !== channel ||
    typeof metadata.hash !== 'string' ||
    !/^[a-z0-9]{1,13}$/.test(metadata.hash) ||
    (expected.hash !== undefined && metadata.hash !== expected.hash) ||
    (expected.version !== undefined && metadata.version !== expected.version) ||
    (expected.baseUrl !== undefined && metadata.baseUrl !== expected.baseUrl)
  )
    throw new Error('Embedded metadata does not match the expected release identity or manifest.');
};

const parseManifest = (text: string, identifier: string, version?: string): UpdateManifest => {
  const { updates } = releaseFiles(identifier);
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
    artifact.file !== updates.archive
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
      file: updates.archive,
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
  const { updates } = releaseFiles(expected.identifier);
  for (const file of Object.values(updates)) {
    const info = await lstat(join(directory, file));
    const limit = file === updates.archive ? MAX_ARCHIVE_BYTES : MAX_MANIFEST_BYTES;
    if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > limit)
      throw new Error('Update artifact is missing, unsafe, or exceeds its size limit.');
  }
  const manifest = parseManifest(
    await readFile(join(directory, updates.manifest), 'utf8'),
    expected.identifier,
    expected.version,
  );
  const integrity = parseManifest(
    await readFile(join(directory, updates.integrity), 'utf8'),
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
    createReadStream(join(directory, updates.archive)),
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
