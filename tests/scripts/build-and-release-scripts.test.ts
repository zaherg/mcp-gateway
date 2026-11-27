import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import type { CommandRunner } from '@mcp-gateway/core/process';
import {
  assertEmptyReleaseOutputs,
  buildIdentity,
  PRODUCTION_FEED,
  PRODUCTION_IDENTIFIER,
  releaseOutputEnvironment,
  STABLE_VERSION_PATTERN,
  TEST_IDENTIFIER,
  validateFeedUrl,
} from '../../scripts/build-config';
import { withDmgMount } from '../../scripts/release-dmg';
import {
  compareBundleInventories,
  inventoryBundle,
  inventoryDigest,
} from '../../scripts/release-inventory';
import {
  buildPlan,
  captureCommand,
  runCheckedCommand,
  runForeground,
} from '../../scripts/toolchain';
import {
  hashFile,
  readUpdateArtifacts,
  redactedUrl,
  redactSecrets,
  releaseFiles,
  verifyEmbeddedMetadata,
  watchCancelSignals,
} from '../../scripts/update-artifacts';
import { registerTempDirLifecycle } from '../helpers/core';

const { makeTempDir } = registerTempDirLifecycle('mcp-gateway-scripts-');

const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
};

describe('scripts/build-config.ts', () => {
  describe('STABLE_VERSION_PATTERN', () => {
    test('accepts canonical semantic versions without leading zeros or suffixes', () => {
      for (const version of ['0.0.0', '0.9.0', '1.2.3', '10.20.30']) {
        expect(STABLE_VERSION_PATTERN.test(version)).toBe(true);
      }
    });

    test('rejects leading zeros, prefixes, prereleases, and incomplete versions', () => {
      for (const version of ['', '1.0', 'v1.0.0', '01.0.0', '1.02.0', '1.0.03', '1.0.0-beta.1']) {
        expect(STABLE_VERSION_PATTERN.test(version)).toBe(false);
      }
    });
  });

  describe('validateFeedUrl', () => {
    test('accepts valid HTTPS and loopback HTTP feed URLs and rejects malformed or unsafe URLs', () => {
      const accepted = [
        PRODUCTION_FEED,
        'https://updates.example.com/releases/stable',
        'https://example.com:8443/feed',
        'http://localhost:8080/feed',
        'http://127.0.0.1:9000/updates',
        'http://[::1]:9000/updates',
      ];
      for (const url of accepted) {
        expect(validateFeedUrl(url)).toBe(url);
      }

      const formatError = 'An update feed URL without whitespace or a trailing slash is required.';
      const invalidUrlError = 'Invalid update feed URL.';
      const policyError =
        'Update feeds require HTTPS (or loopback HTTP), without credentials, query or fragment.';

      const rejected: Array<[string | undefined, string]> = [
        [undefined, formatError],
        ['', formatError],
        ['   ', formatError],
        [' https://example.com/feed', formatError],
        ['https://example.com/feed ', formatError],
        ['https://example.com/my feed', formatError],
        ['https://example.com/feed\n', formatError],
        ['https://example.com/feed\u0000', formatError],
        ['https://example.com/feed\u007f', formatError],
        ['https://example.com/feed/', formatError],
        ['/releases/latest', invalidUrlError],
        ['releases/latest', invalidUrlError],
        ['not-a-url', invalidUrlError],
        ['http://example.com/feed', policyError],
        ['ftp://example.com/feed', policyError],
        ['file:///tmp/feed', policyError],
        ['https://user:pass@example.com/feed', policyError],
        ['https://user@example.com/feed', policyError],
        ['https://example.com/feed?token=secret', policyError],
        ['https://example.com/feed?', policyError],
        ['https://example.com/feed#section', policyError],
        ['https://example.com/feed#', policyError],
        ['http://localhost:8080/feed?debug=1', policyError],
      ];
      for (const [url, expectedError] of rejected) {
        expect(() => validateFeedUrl(url)).toThrow(expectedError);
      }
    });
  });

  describe('buildIdentity', () => {
    test('defaults to production identity with PRODUCTION_FEED and notarization enabled', () => {
      expect(buildIdentity({})).toEqual({
        kind: 'production',
        identifier: PRODUCTION_IDENTIFIER,
        name: 'MCP Gateway',
        feed: PRODUCTION_FEED,
        notarize: true,
      });
    });

    test('constructs test identity with validated test feed and notarization disabled', () => {
      const testFeed = 'http://127.0.0.1:4321/test-feed';
      expect(
        buildIdentity({
          MCP_GATEWAY_BUILD_KIND: 'test',
          MCP_GATEWAY_TEST_FEED: testFeed,
        }),
      ).toEqual({
        kind: 'test',
        identifier: TEST_IDENTIFIER,
        name: 'MCP Gateway Dev',
        feed: testFeed,
        notarize: false,
      });
    });

    test('rejects invalid build kinds and missing or invalid test feeds', () => {
      expect(() => buildIdentity({ MCP_GATEWAY_BUILD_KIND: 'staging' })).toThrow(
        'Invalid build kind.',
      );
      expect(() => buildIdentity({ MCP_GATEWAY_BUILD_KIND: 'test' })).toThrow(
        'An update feed URL without whitespace or a trailing slash is required.',
      );
      expect(() =>
        buildIdentity({
          MCP_GATEWAY_BUILD_KIND: 'test',
          MCP_GATEWAY_TEST_FEED: 'http://example.com/insecure',
        }),
      ).toThrow(
        'Update feeds require HTTPS (or loopback HTTP), without credentials, query or fragment.',
      );
    });
  });

  describe('releaseOutputEnvironment', () => {
    test('populates default production and test output directories while preserving other vars', () => {
      const baseEnv: NodeJS.ProcessEnv = { CUSTOM_FLAG: '1' };
      expect(releaseOutputEnvironment('0.9.0', baseEnv, 'production')).toEqual({
        CUSTOM_FLAG: '1',
        MCP_GATEWAY_BUILD_ROOT: 'build/v0.9.0',
        MCP_GATEWAY_ARTIFACTS_DIR: 'artifacts/v0.9.0',
      });
      expect(releaseOutputEnvironment('0.9.0', baseEnv, 'test')).toEqual({
        CUSTOM_FLAG: '1',
        MCP_GATEWAY_BUILD_ROOT: 'build/test-v0.9.0',
        MCP_GATEWAY_ARTIFACTS_DIR: 'artifacts/test-v0.9.0',
      });
    });

    test('preserves explicit build root and artifacts directory overrides', () => {
      expect(
        releaseOutputEnvironment(
          '1.2.3',
          {
            MCP_GATEWAY_BUILD_ROOT: 'build/custom',
            MCP_GATEWAY_ARTIFACTS_DIR: 'artifacts/custom',
          },
          'production',
        ),
      ).toEqual({
        MCP_GATEWAY_BUILD_ROOT: 'build/custom',
        MCP_GATEWAY_ARTIFACTS_DIR: 'artifacts/custom',
      });
    });

    test('rejects invalid release versions', () => {
      expect(() => releaseOutputEnvironment('1.0.0-rc1', {})).toThrow('Invalid release version.');
    });
  });

  describe('assertEmptyReleaseOutputs', () => {
    test('succeeds when target build and artifact directories are absent or empty', async () => {
      const root = await makeTempDir('bear-mcp-build-config-');
      const env = releaseOutputEnvironment('0.9.0', {}, 'production');

      await expect(assertEmptyReleaseOutputs(root, env, 'production')).resolves.toBeUndefined();

      await mkdir(join(root, env.MCP_GATEWAY_BUILD_ROOT), { recursive: true });
      await mkdir(join(root, env.MCP_GATEWAY_ARTIFACTS_DIR), { recursive: true });

      await expect(assertEmptyReleaseOutputs(root, env, 'production')).resolves.toBeUndefined();
    });

    test('rejects missing env variables, root escapes, identical paths, and cross-kind outputs', async () => {
      const root = await makeTempDir('bear-mcp-build-config-');

      await expect(assertEmptyReleaseOutputs(root, {}, 'production')).rejects.toThrow(
        'Release output directories are required.',
      );

      await expect(
        assertEmptyReleaseOutputs(
          root,
          {
            MCP_GATEWAY_BUILD_ROOT: '../outside-build',
            MCP_GATEWAY_ARTIFACTS_DIR: 'artifacts/v0.9.0',
          },
          'production',
        ),
      ).rejects.toThrow('Release output directories must stay inside the project.');

      await expect(
        assertEmptyReleaseOutputs(
          root,
          {
            MCP_GATEWAY_BUILD_ROOT: '.',
            MCP_GATEWAY_ARTIFACTS_DIR: 'artifacts/v0.9.0',
          },
          'production',
        ),
      ).rejects.toThrow('Release output directories must stay inside the project.');

      await expect(
        assertEmptyReleaseOutputs(
          root,
          {
            MCP_GATEWAY_BUILD_ROOT: 'build/shared',
            MCP_GATEWAY_ARTIFACTS_DIR: 'build/shared',
          },
          'production',
        ),
      ).rejects.toThrow('Build and artifact directories must differ.');

      await expect(
        assertEmptyReleaseOutputs(
          root,
          releaseOutputEnvironment('0.9.0', {}, 'test'),
          'production',
        ),
      ).rejects.toThrow('Release output belongs to the other build kind.');

      await expect(
        assertEmptyReleaseOutputs(
          root,
          releaseOutputEnvironment('0.9.0', {}, 'production'),
          'test',
        ),
      ).rejects.toThrow('Release output belongs to the other build kind.');
    });

    test('rejects symlink ancestors, non-directory ancestors, and non-empty target directories', async () => {
      const root = await makeTempDir('bear-mcp-build-config-');
      const external = await makeTempDir('bear-mcp-external-');

      await symlink(external, join(root, 'build'));
      await expect(
        assertEmptyReleaseOutputs(
          root,
          releaseOutputEnvironment('0.9.0', {}, 'production'),
          'production',
        ),
      ).rejects.toThrow('Release output ancestors must be plain directories.');

      await rm(join(root, 'build'));
      await writeFile(join(root, 'build'), 'not a directory');
      await expect(
        assertEmptyReleaseOutputs(
          root,
          releaseOutputEnvironment('0.9.0', {}, 'production'),
          'production',
        ),
      ).rejects.toThrow('Release output ancestors must be plain directories.');

      await rm(join(root, 'build'));
      const env = releaseOutputEnvironment('0.9.0', {}, 'production');
      await mkdir(join(root, env.MCP_GATEWAY_ARTIFACTS_DIR), { recursive: true });
      await writeFile(join(root, env.MCP_GATEWAY_ARTIFACTS_DIR, 'stale.dmg'), 'stale');
      await expect(assertEmptyReleaseOutputs(root, env, 'production')).rejects.toThrow(
        'Release output directory is not empty; choose fresh build and artifact paths.',
      );
    });
  });
});

describe('scripts/toolchain.ts', () => {
  test('buildPlan returns deterministic plans for every supported mode and rejects invalid modes', () => {
    expect(buildPlan('stable')).toEqual({
      mode: 'stable',
      kind: 'production',
      signed: true,
      arguments: ['build', '--env=stable'],
    });
    expect(buildPlan('stable-test')).toEqual({
      mode: 'stable-test',
      kind: 'test',
      signed: true,
      arguments: ['build', '--env=stable'],
    });
    expect(buildPlan('dev')).toEqual({
      mode: 'dev',
      kind: 'production',
      signed: false,
      arguments: ['dev', '--watch'],
    });
    expect(buildPlan('dev-build')).toEqual({
      mode: 'dev-build',
      kind: 'production',
      signed: false,
      arguments: ['build', '--env=dev'],
    });

    for (const invalid of [undefined, '', 'release', 'toString']) {
      expect(() => buildPlan(invalid)).toThrow('Choose stable, stable-test, dev, or dev-build.');
    }
  });

  test('runForeground, captureCommand, and runCheckedCommand enforce executable and exit status', async () => {
    await expect(runForeground([])).rejects.toThrow('Command executable is required.');

    const captured = await captureCommand(['/bin/echo', 'toolchain-ok']);
    expect(captured.exitCode).toBe(0);
    expect(captured.stdout.trim()).toBe('toolchain-ok');

    const checked = await runCheckedCommand(['/bin/echo', 'checked-ok']);
    expect(checked.trim()).toBe('checked-ok');

    await expect(runCheckedCommand(['/usr/bin/false'])).rejects.toThrow(
      'Command failed: /usr/bin/false',
    );
  });
});

describe('scripts/update-artifacts.ts', () => {
  describe('watchCancelSignals', () => {
    test('attaches SIGINT/SIGTERM listeners, aborts once with exitCode, and detaches on dispose', () => {
      const beforeSigint = new Set(process.listeners('SIGINT'));
      const beforeSigterm = new Set(process.listeners('SIGTERM'));
      const originalExitCode = process.exitCode;
      const seen: Array<'SIGINT' | 'SIGTERM'> = [];

      const watcher = watchCancelSignals('Release verification cancelled.', (sig) => {
        seen.push(sig);
      });
      try {
        const addedSigint = process
          .listeners('SIGINT')
          .filter((listener) => !beforeSigint.has(listener));
        const addedSigterm = process
          .listeners('SIGTERM')
          .filter((listener) => !beforeSigterm.has(listener));
        expect(addedSigint).toHaveLength(1);
        expect(addedSigterm).toHaveLength(1);
        expect(watcher.signal.aborted).toBe(false);

        (addedSigint[0] as () => void)();
        expect(watcher.signal.aborted).toBe(true);
        expect(watcher.signal.reason).toBeInstanceOf(Error);
        expect((watcher.signal.reason as Error).message).toBe('Release verification cancelled.');
        expect(process.exitCode).toBe(130);
        expect(seen).toEqual(['SIGINT']);

        // Subsequent signals after abort are ignored.
        (addedSigterm[0] as () => void)();
        expect(seen).toEqual(['SIGINT']);
        expect(process.exitCode).toBe(130);
      } finally {
        watcher.dispose();
        process.exitCode = originalExitCode ?? 0;
      }

      expect(process.listenerCount('SIGINT')).toBe(beforeSigint.size);
      expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm.size);
    });

    test('sets exitCode 143 on SIGTERM and cleans up listeners', () => {
      const beforeSigterm = new Set(process.listeners('SIGTERM'));
      const originalExitCode = process.exitCode;
      const seen: Array<'SIGINT' | 'SIGTERM'> = [];
      const watcher = watchCancelSignals('Terminated.', (sig) => seen.push(sig));
      try {
        const addedSigterm = process
          .listeners('SIGTERM')
          .filter((listener) => !beforeSigterm.has(listener));
        expect(addedSigterm).toHaveLength(1);

        (addedSigterm[0] as () => void)();
        expect(watcher.signal.aborted).toBe(true);
        expect(process.exitCode).toBe(143);
        expect(seen).toEqual(['SIGTERM']);
      } finally {
        watcher.dispose();
        process.exitCode = originalExitCode ?? 0;
      }

      expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm.size);
    });
  });

  describe('redactSecrets and redactedUrl', () => {
    test('redacts Apple env credentials, extra secrets, and codesign authority/team lines', () => {
      const saved = {
        APPLE_ID: process.env.APPLE_ID,
        APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
        APPLE_APP_PASSWORD: process.env.APPLE_APP_PASSWORD,
      };
      process.env.APPLE_ID = 'signer@example.test';
      process.env.APPLE_TEAM_ID = 'TEAM123456';
      process.env.APPLE_APP_PASSWORD = 'app-specific-password-fixture';
      try {
        const input = [
          'Uploading as signer@example.test with app-specific-password-fixture (team TEAM123456)',
          'Token: extra-token-value',
          'Authority=Developer ID Application: Example Corp (TEAM123456)',
          'origin=Developer ID Application: Example Corp (TEAM123456)',
          'TeamIdentifier=TEAM123456',
        ].join('\n');

        const redacted = redactSecrets(input, ['extra-token-value', undefined, '']);
        expect(redacted).not.toContain('signer@example.test');
        expect(redacted).not.toContain('app-specific-password-fixture');
        expect(redacted).not.toContain('TEAM123456');
        expect(redacted).not.toContain('extra-token-value');
        expect(redacted).toContain('Authority=Developer ID Application [redacted]');
        expect(redacted).toContain('origin=Developer ID Application [redacted]');
        expect(redacted).toContain('TeamIdentifier=[redacted]');
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });

    test('redactedUrl strips credentials, queries, and fragments and falls back to redactSecrets', () => {
      expect(redactedUrl('https://user:secret@example.com/releases/v1?token=abc#frag')).toBe(
        'https://example.com/releases/v1',
      );
      expect(redactedUrl('http://127.0.0.1:8080/feed?api_key=123')).toBe(
        'http://127.0.0.1:8080/feed',
      );

      const saved = process.env.APPLE_APP_PASSWORD;
      process.env.APPLE_APP_PASSWORD = 'fixture-secret-pwd';
      try {
        expect(redactedUrl('not-a-url/fixture-secret-pwd')).toBe('not-a-url/[redacted]');
      } finally {
        if (saved === undefined) delete process.env.APPLE_APP_PASSWORD;
        else process.env.APPLE_APP_PASSWORD = saved;
      }
    });
  });

  describe('verifyEmbeddedMetadata', () => {
    test('accepts matching embedded version.json metadata read from a mock app bundle', async () => {
      const root = await makeTempDir('bear-mcp-embedded-');
      const versionJsonPath = join(root, 'MCP Gateway.app/Contents/Resources/version.json');
      await mkdir(dirname(versionJsonPath), { recursive: true });
      const payload = JSON.stringify({
        identifier: PRODUCTION_IDENTIFIER,
        channel: 'stable',
        version: '0.9.0',
        hash: 'abc123def0',
        baseUrl: PRODUCTION_FEED,
      });
      await writeFile(versionJsonPath, payload);

      const text = await readFile(versionJsonPath, 'utf8');
      expect(() =>
        verifyEmbeddedMetadata(text, {
          identifier: PRODUCTION_IDENTIFIER,
          version: '0.9.0',
          hash: 'abc123def0',
          baseUrl: PRODUCTION_FEED,
        }),
      ).not.toThrow();
    });

    test('rejects invalid JSON, non-objects, bad hashes, and mismatched release fields', () => {
      expect(() =>
        verifyEmbeddedMetadata('{bad json', { identifier: PRODUCTION_IDENTIFIER }),
      ).toThrow('Embedded metadata contains invalid JSON.');
      expect(() => verifyEmbeddedMetadata('[]', { identifier: PRODUCTION_IDENTIFIER })).toThrow(
        'Update metadata must be an object.',
      );

      const valid = {
        identifier: PRODUCTION_IDENTIFIER,
        channel: 'stable',
        version: '0.9.0',
        hash: 'a1b2c3d4',
        baseUrl: PRODUCTION_FEED,
      };
      const cases = [
        { ...valid, identifier: TEST_IDENTIFIER },
        { ...valid, channel: 'dev' },
        { ...valid, hash: 'UPPERCASE' },
        { ...valid, hash: 'a'.repeat(14) },
        { ...valid, hash: 'deadbeef' },
        { ...valid, version: '0.8.0' },
        { ...valid, baseUrl: 'https://other.example.com/releases' },
      ];
      for (const candidate of cases) {
        expect(() =>
          verifyEmbeddedMetadata(JSON.stringify(candidate), {
            identifier: PRODUCTION_IDENTIFIER,
            version: '0.9.0',
            hash: 'a1b2c3d4',
            baseUrl: PRODUCTION_FEED,
          }),
        ).toThrow('Embedded metadata does not match the expected release identity or manifest.');
      }
    });
  });

  describe('hashFile and readUpdateArtifacts', () => {
    const PAYLOAD = Buffer.from('mock tar archive payload for zstd fixture');
    const COMPRESSED = zstdCompressSync(PAYLOAD);

    const createUpdateFixture = async (identifier = PRODUCTION_IDENTIFIER) => {
      const directory = await makeTempDir('bear-mcp-updates-');
      const { updates } = releaseFiles(identifier);
      const manifest = {
        schemaVersion: 1 as const,
        identifier,
        channel: 'stable' as const,
        version: '0.9.0',
        hash: 'buildhash01',
        platform: 'macos' as const,
        arch: 'arm64' as const,
        artifact: { file: updates.archive },
      };
      const integrity = {
        ...manifest,
        artifact: {
          file: updates.archive,
          tarSha256: sha256Hex(PAYLOAD),
          tarSize: PAYLOAD.byteLength,
        },
      };

      const writeManifest = (data: Record<string, unknown> = manifest) =>
        writeFile(join(directory, updates.manifest), JSON.stringify(data));
      const writeIntegrity = (data: Record<string, unknown> = integrity) =>
        writeFile(join(directory, updates.integrity), JSON.stringify(data));

      await writeManifest();
      await writeIntegrity();
      await writeFile(join(directory, updates.archive), COMPRESSED);

      return { directory, updates, manifest, integrity, writeManifest, writeIntegrity };
    };

    test('hashFile computes exact SHA-256 digest and respects AbortSignal', async () => {
      const directory = await makeTempDir('bear-mcp-hash-');
      const filePath = join(directory, 'sample.bin');
      const content = Buffer.from('deterministic sha256 test payload');
      await writeFile(filePath, content);

      expect(await hashFile(filePath)).toBe(sha256Hex(content));

      const controller = new AbortController();
      controller.abort(new Error('Hash cancelled'));
      await expect(hashFile(filePath, controller.signal)).rejects.toThrow('Hash cancelled');
    });

    test('readUpdateArtifacts maps releaseFiles, decompresses, and verifies a valid zstd archive fixture', async () => {
      expect(releaseFiles(PRODUCTION_IDENTIFIER)).toEqual({
        bundle: 'MCP Gateway.app',
        dmg: 'macos-arm64-MCPGateway.dmg',
        updates: {
          manifest: 'stable-macos-arm64-update.json',
          integrity: 'stable-macos-arm64-update-v2.json',
          archive: 'stable-macos-arm64-MCPGateway.app.tar.zst',
        },
      });
      expect(releaseFiles(TEST_IDENTIFIER)).toEqual({
        bundle: 'MCP Gateway Dev.app',
        dmg: 'macos-arm64-MCPGatewayDev.dmg',
        updates: {
          manifest: 'stable-macos-arm64-update.json',
          integrity: 'stable-macos-arm64-update-v2.json',
          archive: 'stable-macos-arm64-MCPGatewayDev.app.tar.zst',
        },
      });

      const fixture = await createUpdateFixture();
      const result = await readUpdateArtifacts(fixture.directory, {
        identifier: PRODUCTION_IDENTIFIER,
        version: '0.9.0',
      });

      expect(result.manifest).toEqual(fixture.manifest);
      expect(result.expanded).toEqual({
        sha256: sha256Hex(PAYLOAD),
        size: PAYLOAD.byteLength,
      });
      expect(result.integrity.artifact.tarSha256).toBe(result.expanded.sha256);
      expect(result.integrity.artifact.tarSize).toBe(result.expanded.size);
    });

    test('readUpdateArtifacts rejects symlinked manifest or archive, empty archive, and missing artifact files', async () => {
      const fixture = await createUpdateFixture();
      const manifestPath = join(fixture.directory, fixture.updates.manifest);
      const archivePath = join(fixture.directory, fixture.updates.archive);
      const integrityPath = join(fixture.directory, fixture.updates.integrity);

      // Symlinked .json manifest (EDGE-15)
      const realManifest = join(fixture.directory, 'real-manifest.json');
      await writeFile(realManifest, JSON.stringify(fixture.manifest));
      await rm(manifestPath);
      await symlink(realManifest, manifestPath);
      await expect(
        readUpdateArtifacts(fixture.directory, { identifier: PRODUCTION_IDENTIFIER }),
      ).rejects.toThrow('Update artifact is missing, unsafe, or exceeds its size limit.');
      await rm(manifestPath);
      await fixture.writeManifest();

      // Symlinked .tar.zst archive (EDGE-15)
      const realArchive = join(fixture.directory, 'real-archive.tar.zst');
      await writeFile(realArchive, COMPRESSED);
      await rm(archivePath);
      await symlink(realArchive, archivePath);
      await expect(
        readUpdateArtifacts(fixture.directory, { identifier: PRODUCTION_IDENTIFIER }),
      ).rejects.toThrow('Update artifact is missing, unsafe, or exceeds its size limit.');

      // Empty archive
      await rm(archivePath);
      await writeFile(archivePath, '');
      await expect(
        readUpdateArtifacts(fixture.directory, { identifier: PRODUCTION_IDENTIFIER }),
      ).rejects.toThrow('Update artifact is missing, unsafe, or exceeds its size limit.');

      // Missing integrity manifest
      await writeFile(archivePath, COMPRESSED);
      await rm(integrityPath);
      await expect(
        readUpdateArtifacts(fixture.directory, { identifier: PRODUCTION_IDENTIFIER }),
      ).rejects.toThrow();
    });

    test('readUpdateArtifacts rejects manifest mismatches, bad integrity metadata, and tampered archives by mutating JSON in place', async () => {
      const fixture = await createUpdateFixture();
      const check = (signal?: AbortSignal) =>
        readUpdateArtifacts(fixture.directory, { identifier: PRODUCTION_IDENTIFIER }, signal);

      await fixture.writeManifest({ ...fixture.manifest, schemaVersion: 2 });
      await expect(check()).rejects.toThrow(
        'Update manifest does not match the app identity, version, or artifact name.',
      );
      await fixture.writeManifest();

      await fixture.writeIntegrity({ ...fixture.integrity, hash: 'otherhash99' });
      await expect(check()).rejects.toThrow('Update manifests disagree on hash.');

      await fixture.writeIntegrity({
        ...fixture.integrity,
        artifact: { ...fixture.integrity.artifact, tarSha256: 'not-a-sha256' },
      });
      await expect(check()).rejects.toThrow(
        'Update integrity manifest has invalid expanded archive metadata.',
      );

      await fixture.writeIntegrity({
        ...fixture.integrity,
        artifact: { ...fixture.integrity.artifact, tarSize: 0 },
      });
      await expect(check()).rejects.toThrow(
        'Update integrity manifest has invalid expanded archive metadata.',
      );

      await fixture.writeIntegrity({
        ...fixture.integrity,
        artifact: { ...fixture.integrity.artifact, tarSha256: '0'.repeat(64) },
      });
      await expect(check()).rejects.toThrow('Update archive integrity metadata mismatch.');

      await fixture.writeIntegrity({
        ...fixture.integrity,
        artifact: { ...fixture.integrity.artifact, tarSize: 9999 },
      });
      await expect(check()).rejects.toThrow('Update archive integrity metadata mismatch.');

      await fixture.writeIntegrity();
      const controller = new AbortController();
      controller.abort(new Error('Update read cancelled'));
      await expect(check(controller.signal)).rejects.toThrow('Update read cancelled');
    });
  });
});

describe('scripts/release-inventory.ts', () => {
  const createBundleTree = async (parent: string, name: string): Promise<string> => {
    const bundle = join(parent, name);
    await mkdir(join(bundle, 'Contents/MacOS'), { recursive: true });
    await mkdir(join(bundle, 'Contents/Resources'), { recursive: true });
    await writeFile(join(bundle, 'Contents/Info.plist'), '<plist version="1.0"></plist>');
    await chmod(join(bundle, 'Contents/Info.plist'), 0o644);
    await writeFile(join(bundle, 'Contents/MacOS/launcher'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bundle, 'Contents/MacOS/launcher'), 0o755);
    await symlink('MacOS/launcher', join(bundle, 'Contents/current-launcher'));
    return bundle;
  };

  test('inventoryBundle walks files, executables, directories, and symlinks deterministically', async () => {
    const root = await makeTempDir('bear-mcp-inventory-');
    const bundle = await createBundleTree(root, 'MCP Gateway.app');

    const entries = await inventoryBundle(bundle);
    const paths = entries.map((entry) => entry.path);
    expect(paths).toEqual([
      '.',
      'Contents',
      'Contents/Info.plist',
      'Contents/MacOS',
      'Contents/MacOS/launcher',
      'Contents/Resources',
      'Contents/current-launcher',
    ]);

    const plistEntry = entries.find((entry) => entry.path === 'Contents/Info.plist');
    expect(plistEntry).toEqual({
      path: 'Contents/Info.plist',
      type: 'file',
      mode: 0o644,
      size: Buffer.byteLength('<plist version="1.0"></plist>'),
      sha256: sha256Hex('<plist version="1.0"></plist>'),
    });

    const launcherEntry = entries.find((entry) => entry.path === 'Contents/MacOS/launcher');
    expect(launcherEntry).toEqual({
      path: 'Contents/MacOS/launcher',
      type: 'file',
      mode: 0o755,
      size: Buffer.byteLength('#!/bin/sh\nexit 0\n'),
      sha256: sha256Hex('#!/bin/sh\nexit 0\n'),
    });

    const symlinkEntry = entries.find((entry) => entry.path === 'Contents/current-launcher');
    expect(symlinkEntry?.type).toBe('symlink');
    expect(symlinkEntry?.size).toBe(0);
    expect(symlinkEntry?.link).toBe('MacOS/launcher');
    expect(symlinkEntry?.sha256).toBeUndefined();
  });

  test('inventoryBundle rejects symlink or regular-file roots and respects AbortSignal', async () => {
    const root = await makeTempDir('bear-mcp-inventory-');
    const bundle = await createBundleTree(root, 'Real.app');
    const linkRoot = join(root, 'Link.app');
    const fileRoot = join(root, 'NotADir.app');
    await symlink(bundle, linkRoot);
    await writeFile(fileRoot, 'file');

    await expect(inventoryBundle(linkRoot)).rejects.toThrow(
      'Bundle inventory root is not a plain directory.',
    );
    await expect(inventoryBundle(fileRoot)).rejects.toThrow(
      'Bundle inventory root is not a plain directory.',
    );

    const controller = new AbortController();
    controller.abort(new Error('Inventory cancelled'));
    await expect(inventoryBundle(bundle, controller.signal)).rejects.toThrow('Inventory cancelled');
  });

  test('compareBundleInventories and inventoryDigest detect equality and every kind of divergence', async () => {
    const rootA = await makeTempDir('bear-mcp-inv-a-');
    const rootB = await makeTempDir('bear-mcp-inv-b-');
    const bundleA = await createBundleTree(rootA, 'MCP Gateway.app');
    const bundleB = await createBundleTree(rootB, 'MCP Gateway.app');

    const inventoryA = await inventoryBundle(bundleA);
    const inventoryB = await inventoryBundle(bundleB);

    expect(() => compareBundleInventories(inventoryA, inventoryB)).not.toThrow();
    expect(inventoryDigest(inventoryA)).toBe(inventoryDigest(inventoryB));
    expect(inventoryDigest(inventoryA)).toMatch(/^[a-f0-9]{64}$/);

    // Added file in actual
    await writeFile(join(bundleB, 'Contents/Resources/extra.txt'), 'extra');
    const withAdded = await inventoryBundle(bundleB);
    expect(() =>
      compareBundleInventories(inventoryA, withAdded, { expected: 'staged', actual: 'mounted' }),
    ).toThrow('Bundle inventories differ: Contents/Resources/extra.txt missing from staged');
    expect(inventoryDigest(withAdded)).not.toBe(inventoryDigest(inventoryA));

    // Removed file in actual
    await rm(join(bundleB, 'Contents/Resources/extra.txt'));
    await rm(join(bundleB, 'Contents/Info.plist'));
    const withRemoved = await inventoryBundle(bundleB);
    expect(() =>
      compareBundleInventories(inventoryA, withRemoved, { expected: 'staged', actual: 'mounted' }),
    ).toThrow('Bundle inventories differ: Contents/Info.plist missing from mounted');

    // Modified file content
    await writeFile(join(bundleB, 'Contents/Info.plist'), '<plist version="2.0"></plist>');
    await chmod(join(bundleB, 'Contents/Info.plist'), 0o644);
    const withModifiedContent = await inventoryBundle(bundleB);
    expect(() => compareBundleInventories(inventoryA, withModifiedContent)).toThrow(
      'Bundle inventories differ: Contents/Info.plist differs',
    );

    // Restored content, modified permissions (EDGE-15: 0o755 -> 0o644)
    await writeFile(join(bundleB, 'Contents/Info.plist'), '<plist version="1.0"></plist>');
    await chmod(join(bundleB, 'Contents/MacOS/launcher'), 0o644);
    const withModifiedMode = await inventoryBundle(bundleB);
    expect(() => compareBundleInventories(inventoryA, withModifiedMode)).toThrow(
      'Bundle inventories differ: Contents/MacOS/launcher differs',
    );

    // Restored permissions, modified symlink target (EDGE-15)
    await chmod(join(bundleB, 'Contents/MacOS/launcher'), 0o755);
    await rm(join(bundleB, 'Contents/current-launcher'));
    await symlink('Resources', join(bundleB, 'Contents/current-launcher'));
    const withModifiedLink = await inventoryBundle(bundleB);
    expect(() => compareBundleInventories(inventoryA, withModifiedLink)).toThrow(
      'Bundle inventories differ: Contents/current-launcher differs',
    );

    // Caps difference summary at 8 paths when more than 8 entries differ
    const manyEntries = Array.from({ length: 10 }, (_, index) => ({
      path: `file-${index}.txt`,
      type: 'file' as const,
      mode: 0o644,
      size: 1,
      sha256: 'a'.repeat(64),
    }));
    let cappedMessage = '';
    try {
      compareBundleInventories([], manyEntries);
    } catch (error) {
      cappedMessage = (error as Error).message;
    }
    expect(cappedMessage).toContain('file-7.txt missing from expected');
    expect(cappedMessage).not.toContain('file-8.txt');
  });
});

describe('scripts/release-dmg.ts', () => {
  interface MockCall {
    command: string;
    args: readonly string[];
  }

  interface MockDmgBehavior {
    attachExitCode?: number;
    mountAppearsOnAttach?: boolean;
    mountedImagePath?: string;
    duplicateMountEntries?: boolean;
    detachExitCode?: number;
    detachUnmounts?: boolean;
    forceDetachExitCode?: number;
    forceDetachUnmounts?: boolean;
  }

  const createMockDmgRunner = (behavior?: MockDmgBehavior) => {
    const calls: MockCall[] = [];
    let activeMount: string | undefined;
    let activeImage: string | undefined;
    let isMounted = false;

    const run: CommandRunner = async (cmd, args) => {
      calls.push({ command: cmd, args: [...args] });
      if (cmd === '/usr/bin/hdiutil' && args[0] === 'attach') {
        activeMount = args[4];
        activeImage = args[5];
        const exitCode = behavior?.attachExitCode ?? 0;
        isMounted = behavior?.mountAppearsOnAttach ?? exitCode === 0;
        return { stdout: '', stderr: exitCode === 0 ? '' : 'attach failed', exitCode };
      }
      if (cmd === '/usr/bin/hdiutil' && args[0] === 'info' && args[1] === '-plist') {
        return { stdout: '<plist version="1.0"><dict/></plist>', stderr: '', exitCode: 0 };
      }
      if (cmd === '/usr/bin/plutil' && args[0] === '-convert' && args[1] === 'json') {
        const plistPath = args[4];
        if (!plistPath || !(await pathExists(plistPath))) {
          return { stdout: '', stderr: 'plist file missing', exitCode: 1 };
        }
        const images =
          isMounted && activeMount && activeImage
            ? [
                {
                  'image-path': behavior?.mountedImagePath ?? activeImage,
                  'system-entities': behavior?.duplicateMountEntries
                    ? [{ 'mount-point': activeMount }, { 'mount-point': activeMount }]
                    : [{ 'mount-point': activeMount }],
                },
              ]
            : [];
        return { stdout: JSON.stringify({ images }), stderr: '', exitCode: 0 };
      }
      if (cmd === '/usr/bin/hdiutil' && args[0] === 'detach' && args[1] === '-force') {
        const exitCode = behavior?.forceDetachExitCode ?? 0;
        if (behavior?.forceDetachUnmounts ?? exitCode === 0) isMounted = false;
        return { stdout: '', stderr: exitCode === 0 ? '' : 'force detach failed', exitCode };
      }
      if (cmd === '/usr/bin/hdiutil' && args[0] === 'detach') {
        const exitCode = behavior?.detachExitCode ?? 0;
        if (behavior?.detachUnmounts ?? exitCode === 0) isMounted = false;
        return { stdout: '', stderr: exitCode === 0 ? '' : 'resource busy', exitCode };
      }
      throw new Error(`Unexpected command invocation: ${cmd} ${args.join(' ')}`);
    };

    return { calls, run, capturedMount: () => activeMount };
  };

  const createDmgHarness = async (overrides?: MockDmgBehavior) => {
    const scratch = await makeTempDir('bear-mcp-dmg-');
    const imagePath = join(scratch, 'MCPGateway.dmg');
    await writeFile(imagePath, 'dmg-fixture');
    const mock = createMockDmgRunner(overrides);
    const cleanups: Array<{ ok: boolean; mount: string; detail: string }> = [];
    const mountWith = <T>(fn: (mount: string) => Promise<T>, runner = mock, signal?: AbortSignal) =>
      withDmgMount(imagePath, scratch, fn, {
        run: runner.run,
        onCleanup: (cleanup) => cleanups.push(cleanup),
        signal,
      });
    return { scratch, imagePath, mock, cleanups, mountWith };
  };

  test('attaches, verifies, detaches, removes scratch mount directory, and returns callback value', async () => {
    const { mock, cleanups, mountWith } = await createDmgHarness();

    const result = await mountWith(async (mount) => {
      expect(mock.capturedMount()).toBe(mount);
      expect(await pathExists(mount)).toBe(true);
      return 'verified-ok';
    });

    expect(result).toBe('verified-ok');
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]?.ok).toBe(true);
    expect(cleanups[0]?.detail).toBe('Owned mount absent; mount directory removed.');
    const mountPath = mock.capturedMount();
    expect(mountPath).toBeDefined();
    if (mountPath) {
      expect(await pathExists(mountPath)).toBe(false);
      expect(await pathExists(dirname(mountPath))).toBe(false);
    }
    expect(
      mock.calls.some((call) => call.command === '/usr/bin/hdiutil' && call.args[0] === 'detach'),
    ).toBe(true);
  });

  test('always detaches and cleans up before rethrowing callback errors', async () => {
    const { mock, cleanups, mountWith } = await createDmgHarness();

    await expect(
      mountWith(async () => {
        throw new Error('Bundle signature mismatch');
      }),
    ).rejects.toThrow('Bundle signature mismatch');

    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]?.ok).toBe(true);
    const mountPath = mock.capturedMount();
    if (mountPath) expect(await pathExists(dirname(mountPath))).toBe(false);
    expect(
      mock.calls.some((call) => call.command === '/usr/bin/hdiutil' && call.args[0] === 'detach'),
    ).toBe(true);
  });

  test('rejects foreign or ambiguous image identity without detaching and retains directory', async () => {
    const {
      mock: foreignMock,
      cleanups,
      mountWith,
    } = await createDmgHarness({
      mountedImagePath: '/tmp/foreign-attacker.dmg',
    });
    let verifyCalled = false;

    await expect(
      mountWith(async () => {
        verifyCalled = true;
        return 'should-not-run';
      }),
    ).rejects.toThrow('DMG cleanup unconfirmed during mount inspection');

    expect(verifyCalled).toBe(false);
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]?.ok).toBe(false);
    expect(
      foreignMock.calls.some(
        (call) => call.command === '/usr/bin/hdiutil' && call.args[0] === 'detach',
      ),
    ).toBe(false);
    const mountPath = foreignMock.capturedMount();
    if (mountPath) expect(await pathExists(mountPath)).toBe(true);

    const ambiguousMock = createMockDmgRunner({ duplicateMountEntries: true });
    await expect(mountWith(async () => 'done', ambiguousMock)).rejects.toThrow(
      'DMG cleanup unconfirmed during mount inspection',
    );
    expect(
      ambiguousMock.calls.some(
        (call) => call.command === '/usr/bin/hdiutil' && call.args[0] === 'detach',
      ),
    ).toBe(false);
  });

  test('escalates to hdiutil detach -force when regular detach fails and succeeds when cleared', async () => {
    const { mock, cleanups, mountWith } = await createDmgHarness({
      detachExitCode: 1,
      detachUnmounts: false,
      forceDetachExitCode: 0,
      forceDetachUnmounts: true,
    });

    const result = await mountWith(async () => 'done');

    expect(result).toBe('done');
    expect(cleanups[0]?.ok).toBe(true);
    const detachCalls = mock.calls.filter(
      (call) => call.command === '/usr/bin/hdiutil' && call.args[0] === 'detach',
    );
    expect(detachCalls).toHaveLength(2);
    expect(detachCalls[0]?.args[1]).not.toBe('-force');
    expect(detachCalls[1]?.args[1]).toBe('-force');
  });

  test('reports unconfirmed cleanup on post-detach anomaly, force-detach failure, or unconfirmed attach', async () => {
    const { cleanups, mountWith } = await createDmgHarness();

    const liedDetachMock = createMockDmgRunner({
      detachExitCode: 0,
      detachUnmounts: false,
    });
    await expect(mountWith(async () => 'done', liedDetachMock)).rejects.toThrow(
      'DMG cleanup unconfirmed during post-detach inspection',
    );

    const stuckMock = createMockDmgRunner({
      detachExitCode: 1,
      detachUnmounts: false,
      forceDetachExitCode: 1,
      forceDetachUnmounts: false,
    });
    await expect(mountWith(async () => 'done', stuckMock)).rejects.toThrow(
      'DMG cleanup unconfirmed during force-detach and final inspection',
    );

    cleanups.length = 0;
    const unconfirmedAttachMock = createMockDmgRunner({
      attachExitCode: 1,
      mountAppearsOnAttach: false,
    });
    await expect(mountWith(async () => 'done', unconfirmedAttachMock)).rejects.toThrow(
      'DMG cleanup unconfirmed during attach settlement',
    );
    expect(cleanups[0]?.ok).toBe(false);
    const retainedMount = unconfirmedAttachMock.capturedMount();
    if (retainedMount) expect(await pathExists(retainedMount)).toBe(true);
  });

  test('fails cleanly when attach exits zero without mounting or signal is pre-aborted', async () => {
    const {
      mock: missingMountMock,
      cleanups,
      mountWith,
    } = await createDmgHarness({
      attachExitCode: 0,
      mountAppearsOnAttach: false,
    });
    await expect(mountWith(async () => 'done')).rejects.toThrow(
      'DMG attach did not establish the owned mount.',
    );
    expect(cleanups[0]?.ok).toBe(true);
    expect(missingMountMock.calls.length).toBeGreaterThan(0);

    const abortedMock = createMockDmgRunner();
    const controller = new AbortController();
    controller.abort(new Error('Cancelled before mount'));
    await expect(mountWith(async () => 'done', abortedMock, controller.signal)).rejects.toThrow(
      'Cancelled before mount',
    );
    expect(abortedMock.calls).toHaveLength(0);
  });
});
