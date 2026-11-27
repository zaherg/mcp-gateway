import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { changelogSection } from '@mcp-gateway/shared/changelog';
import packageInfo from '../package.json';
import { PRODUCTION_FEED, PRODUCTION_IDENTIFIER, releaseOutputEnvironment } from './build-config';
import { captureCommand, runCheckedCommand, runForeground } from './toolchain';
import {
  hashFile,
  redactedUrl,
  redactSecrets,
  releaseFiles,
  verifyEmbeddedMetadata,
} from './update-artifacts';

// Builds, verifies, checksums and publishes the version in package.json, in that order.
// Every step refuses to continue once an earlier one has failed or left the tree dirty.

const root = resolve(import.meta.dir, '..');
const tag = packageInfo.version;
const environment = releaseOutputEnvironment(tag, process.env);
const artifacts = resolve(root, environment.MCP_GATEWAY_ARTIFACTS_DIR);
const CHECKSUMS = 'SHA256SUMS';
const { dmg: DMG, updates: UPDATE_FILES } = releaseFiles(PRODUCTION_IDENTIFIER);
// The integrity manifest goes first, so a feed still serving an older release is named as such.
const RELEASE_ASSETS = [UPDATE_FILES.integrity, UPDATE_FILES.manifest, UPDATE_FILES.archive, DMG];
const PUBLISHED_ASSETS = [...RELEASE_ASSETS, CHECKSUMS];
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

interface Release {
  assets: Array<{ name: string }>;
  isDraft: boolean;
  isPrerelease: boolean;
  tagName: string;
  url: string;
}

/** The remote that already has the tag, so an existing tag cannot surface inside `gh`. */
const remoteWithTag = async () => {
  const remotes = (await runCheckedCommand(['git', 'remote']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const remote of remotes) {
    const listed = await captureCommand(['git', 'ls-remote', '--tags', remote, `refs/tags/${tag}`]);
    const text = `${listed.stdout}${listed.stderr}`.trim();
    if (listed.exitCode !== 0)
      throw new Error(
        `Cannot list tags on ${remote}, so the release would publish blind:\n${text}`,
      );
    if (text) return remote;
  }
  return null;
};

const stage = (name: string) => console.log(`\n== ${name}`);

/** Everything that must hold before minutes of signing, or the release must not be published. */
const preflight = async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('A signed release builds only on macOS arm64.');
  if (process.env.MCP_GATEWAY_TEST_FEED)
    throw new Error(
      'Unset MCP_GATEWAY_TEST_FEED; a production release always uses the GitHub feed.',
    );
  const status = await runCheckedCommand(['git', 'status', '--porcelain']);
  if (status.trim())
    throw new Error(
      'Commit the working tree first; the release is built from the committed files.',
    );
  const containing = await runCheckedCommand(['git', 'branch', '-r', '--contains', 'HEAD']);
  if (!containing.trim())
    throw new Error('Push HEAD to a remote branch first; the release points at that commit.');
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  const notes = changelogSection(changelog, tag);
  if (notes === null)
    throw new Error(
      `CHANGELOG.md has no dated section for ${tag}. Run: bun run changelog --tag ${tag}`,
    );
  await runCheckedCommand(['gh', 'auth', 'status']);
  const localTag = await captureCommand(['git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  if (localTag.exitCode === 0) throw new Error(`Tag ${tag} already exists.`);
  const remote = await remoteWithTag();
  if (remote) throw new Error(`Tag ${tag} already exists on ${remote}.`);
  // Published assets are never replaced, so a second run needs its own version.
  const release = await captureCommand(['gh', 'release', 'view', tag]);
  if (release.exitCode === 0) throw new Error(`Release ${tag} already exists.`);
  const commit = (await runCheckedCommand(['git', 'rev-parse', 'HEAD'])).trim();
  return { commit, notes };
};

/** The release description `gh` returns, or an error instead of a partial read. */
const parseRelease = (text: string) => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The release description from gh is not JSON.');
  }
  if (typeof value !== 'object' || value === null)
    throw new Error('The release description from gh is not an object.');
  const release = value as Partial<Release> & { assets?: Array<{ name?: unknown }> };
  if (
    !Array.isArray(release.assets) ||
    !release.assets.every((asset) => typeof asset?.name === 'string') ||
    typeof release.isDraft !== 'boolean' ||
    typeof release.isPrerelease !== 'boolean' ||
    typeof release.tagName !== 'string' ||
    typeof release.url !== 'string'
  )
    throw new Error('The release description from gh is missing fields.');
  return release as Release;
};

/** `shasum -a 256` compatible, because the release notes tell readers to check with it. */
const writeChecksums = async () => {
  const localHashes = new Map<string, string>();
  const lines: string[] = [];
  for (const file of RELEASE_ASSETS) {
    const hash = await hashFile(join(artifacts, file));
    localHashes.set(file, hash);
    lines.push(`${hash}  ${file}`);
  }
  const checksumsPath = join(artifacts, CHECKSUMS);
  await writeFile(checksumsPath, `${lines.join('\n')}\n`);
  localHashes.set(CHECKSUMS, await hashFile(checksumsPath));
  return localHashes;
};

const publish = async (commit: string, notesPath: string) => {
  await runForeground(
    [
      'gh',
      'release',
      'create',
      tag,
      ...PUBLISHED_ASSETS.map((file) => join(artifacts, file)),
      '--target',
      commit,
      '--title',
      tag,
      '--notes-file',
      notesPath,
    ],
    process.env,
    'inherit',
  );
};

/** Reads back the published release, its asset names and the bytes the update feed serves. */
const confirmPublished = async (localHashes: ReadonlyMap<string, string>) => {
  const release = parseRelease(
    await runCheckedCommand([
      'gh',
      'release',
      'view',
      tag,
      '--json',
      'assets,isDraft,isPrerelease,tagName,url',
    ]),
  );
  if (release.tagName !== tag || release.isDraft || release.isPrerelease)
    throw new Error('The release is not live, or its tag differs from the version.');
  const names = new Set(release.assets.map((asset) => asset.name));
  for (const file of PUBLISHED_ASSETS)
    if (!names.has(file)) throw new Error(`The release is missing ${file}.`);
  await mkdir(join(root, '.cache'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.cache/release-download-'));
  try {
    for (const file of PUBLISHED_ASSETS) {
      const url = `${PRODUCTION_FEED}/${file}`;
      // GitHub answers the feed URL with a redirect to a CDN host.
      const answer = await runCheckedCommand([
        'curl',
        '--proto',
        '=https',
        '--tlsv1.2',
        '-s',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        url,
      ]);
      if (answer.trim() !== '302')
        throw new Error(`${redactedUrl(url)} answered ${answer.trim()}, not 302.`);
      const target = join(scratch, file);
      const maxBytes =
        file === DMG || file === UPDATE_FILES.archive || file.endsWith('.patch')
          ? MAX_ARCHIVE_BYTES
          : MAX_MANIFEST_BYTES;
      await runCheckedCommand([
        'curl',
        '--proto',
        '=https',
        '--tlsv1.2',
        '--max-filesize',
        String(maxBytes),
        '-sSfL',
        '-o',
        target,
        url,
      ]);
      // The feed URL always answers with the latest release, which may not be this one.
      if (file === UPDATE_FILES.integrity) {
        verifyEmbeddedMetadata(await readFile(target, 'utf8'), {
          identifier: PRODUCTION_IDENTIFIER,
          version: tag,
        });
      }
      const want = localHashes.get(file);
      if (!want || (await hashFile(target)) !== want)
        throw new Error(`The downloaded ${file} does not match the built file.`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`\nPublished ${tag}: ${redactedUrl(release.url)}`);
};

let published = false;

const main = async () => {
  stage(`Preflight for ${tag}`);
  const { commit, notes } = await preflight();
  stage('Build, sign and notarize');
  await runForeground([process.execPath, 'scripts/build.ts', 'stable'], process.env, 'inherit');
  stage('Verify signatures, notarization, payload and DMG');
  await runForeground([process.execPath, 'scripts/verify-release.ts'], process.env, 'inherit');
  stage('Write checksums and release notes');
  const localHashes = await writeChecksums();
  const notesPath = join(root, '.cache', `release-notes-${tag}.md`);
  await mkdir(join(root, '.cache'), { recursive: true });
  await writeFile(notesPath, `${notes}\n`);
  // Signing takes minutes; the files built and read since preflight must still be that commit's.
  if (
    (await runCheckedCommand(['git', 'status', '--porcelain'])).trim() ||
    (await runCheckedCommand(['git', 'rev-parse', 'HEAD'])).trim() !== commit
  )
    throw new Error(
      'The checkout changed during the build; it no longer matches the release commit.',
    );
  stage('Publish the GitHub release');
  await publish(commit, notesPath);
  published = true;
  stage('Read the release and the update feed back');
  await confirmPublished(localHashes);
};

try {
  await main();
} catch (error) {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  console.error(
    published
      ? `\nRelease ${tag} IS published, but its read-back failed; inspect it, do not publish again: ${message}`
      : `\nRelease not published: ${message}`,
  );
  process.exit(1);
}
