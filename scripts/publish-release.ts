import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import packageInfo from '../package.json';
import { PRODUCTION_FEED, releaseOutputEnvironment } from './build-config';
import { hashFile, UPDATE_FILES } from './update-artifacts';

// Builds, verifies, checksums and publishes the version in package.json, in that order.
// Every step refuses to continue once an earlier one has failed or left the tree dirty.

const root = resolve(import.meta.dir, '..');
const tag = packageInfo.version;
const environment = releaseOutputEnvironment(tag, process.env);
const artifacts = resolve(root, environment.MCP_GATEWAY_ARTIFACTS_DIR);
const CHECKSUMS = 'SHA256SUMS';
const DMG = 'macos-arm64-MCPGateway.dmg';
// The integrity manifest goes first, so a feed still serving an older release is named as such.
const RELEASE_ASSETS = [UPDATE_FILES.integrity, UPDATE_FILES.manifest, UPDATE_FILES.archive, DMG];
const PUBLISHED_ASSETS = [...RELEASE_ASSETS, CHECKSUMS];

interface Result {
  code: number;
  text: string;
}

interface Release {
  assets: Array<{ name: string }>;
  isDraft: boolean;
  isPrerelease: boolean;
  tagName: string;
  url: string;
}

/** Runs a step in the foreground, so its credentials prompts and progress stay visible. */
const stream = async (args: readonly string[]): Promise<void> => {
  const child = Bun.spawn([...args], {
    cwd: root,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(`Step failed with exit code ${code}: ${args.slice(0, 3).join(' ')}`);
};

const capture = async (args: readonly string[]): Promise<Result> => {
  const child = Bun.spawn([...args], {
    cwd: root,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, text: `${stdout}${stderr}` };
};

const checked = async (args: readonly string[]): Promise<string> => {
  const result = await capture(args);
  if (result.code !== 0)
    throw new Error(`Command failed: ${args.join(' ')}\n${result.text.trim()}`);
  return result.text;
};

/** The remote that already has the tag, so an existing tag cannot surface inside `gh`. */
const remoteWithTag = async (): Promise<string | null> => {
  const remotes = (await checked(['git', 'remote']))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const remote of remotes) {
    const listed = await capture(['git', 'ls-remote', '--tags', remote, `refs/tags/${tag}`]);
    if (listed.code !== 0)
      throw new Error(
        `Cannot list tags on ${remote}, so the release would publish blind:\n${listed.text.trim()}`,
      );
    if (listed.text.trim()) return remote;
  }
  return null;
};

const stage = (name: string) => console.log(`\n== ${name}`);

/** Everything that must hold before minutes of signing, or the release must not be published. */
const preflight = async (): Promise<string> => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('A signed release builds only on macOS arm64.');
  if (process.env.MCP_GATEWAY_TEST_FEED)
    throw new Error(
      'Unset MCP_GATEWAY_TEST_FEED; a production release always uses the GitHub feed.',
    );
  const status = await checked(['git', 'status', '--porcelain']);
  if (status.trim())
    throw new Error(
      'Commit the working tree first; the release is built from the committed files.',
    );
  const containing = await checked(['git', 'branch', '-r', '--contains', 'HEAD']);
  if (!containing.trim())
    throw new Error('Push HEAD to a remote branch first; the release points at that commit.');
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  if (!versionHeading().test(changelog))
    throw new Error(
      `CHANGELOG.md has no dated section for ${tag}. Run: bun run changelog --tag ${tag}`,
    );
  await checked(['gh', 'auth', 'status']);
  const localTag = await capture(['git', 'rev-parse', '-q', '--verify', `refs/tags/${tag}`]);
  if (localTag.code === 0) throw new Error(`Tag ${tag} already exists.`);
  const remote = await remoteWithTag();
  if (remote) throw new Error(`Tag ${tag} already exists on ${remote}.`);
  // Published assets are never replaced, so a second run needs its own version.
  const release = await capture(['gh', 'release', 'view', tag]);
  if (release.code === 0) throw new Error(`Release ${tag} already exists.`);
  return (await checked(['git', 'rev-parse', 'HEAD'])).trim();
};

/** The release description `gh` returns, or an error instead of a partial read. */
const parseRelease = (text: string): Release => {
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

/** Version of an update manifest, so a feed serving another release fails with a clear reason. */
const manifestVersion = (text: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The feed did not serve a JSON update manifest.');
  }
  const version = (value as { version?: unknown } | null)?.version;
  if (typeof version !== 'string') throw new Error('The feed manifest has no version.');
  return version;
};

const versionHeading = () =>
  new RegExp(`^## \\[${tag.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm');

/** The released section of CHANGELOG.md, which is also the text of the GitHub release. */
const releaseNotes = async (): Promise<string> => {
  const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8');
  const heading = versionHeading().exec(changelog);
  if (!heading) throw new Error(`CHANGELOG.md has no dated section for ${tag}.`);
  const rest = changelog.slice(heading.index + heading[0].length);
  const next = /^## \[/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
};

/** `shasum -a 256` compatible, because the release notes tell readers to check with it. */
const writeChecksums = async (): Promise<void> => {
  const lines = await Promise.all(
    RELEASE_ASSETS.map(async (file) => `${await hashFile(join(artifacts, file))}  ${file}`),
  );
  await writeFile(join(artifacts, CHECKSUMS), `${lines.join('\n')}\n`);
};

const publish = async (commit: string, notes: string): Promise<void> => {
  await stream([
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
    notes,
  ]);
};

/** Reads back the published release, its asset names and the bytes the update feed serves. */
const confirmPublished = async (): Promise<void> => {
  const release = parseRelease(
    await checked([
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
  const local = new Map(
    (await readFile(join(artifacts, CHECKSUMS), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, name] = line.split(/\s+/);
        return [name as string, hash as string] as const;
      }),
  );
  await mkdir(join(root, '.cache'), { recursive: true });
  const scratch = await mkdtemp(join(root, '.cache/release-download-'));
  try {
    for (const file of PUBLISHED_ASSETS) {
      const url = `${PRODUCTION_FEED}/${file}`;
      // GitHub answers the feed URL with a redirect to a CDN host.
      const answer = await checked(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url]);
      if (answer.trim() !== '302') throw new Error(`${url} answered ${answer.trim()}, not 302.`);
      const target = join(scratch, file);
      await checked(['curl', '-sSfL', '-o', target, url]);
      // The feed URL always answers with the latest release, which may not be this one.
      if (file === UPDATE_FILES.integrity) {
        const served = manifestVersion(await readFile(target, 'utf8'));
        if (served !== tag) throw new Error(`The feed serves ${served}, not ${tag}.`);
      }
      const want = local.get(file) ?? (await hashFile(join(artifacts, file)));
      if ((await hashFile(target)) !== want)
        throw new Error(`The downloaded ${file} does not match the built file.`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`\nPublished ${tag}: ${release.url}`);
};

let published = false;

const main = async (): Promise<void> => {
  stage(`Preflight for ${tag}`);
  const commit = await preflight();
  stage('Build, sign and notarize');
  await stream([process.execPath, 'scripts/build.ts', 'stable']);
  stage('Verify signatures, notarization, payload and DMG');
  await stream([process.execPath, 'scripts/verify-release.ts']);
  stage('Write checksums and release notes');
  await writeChecksums();
  const notes = join(root, '.cache', `release-notes-${tag}.md`);
  await mkdir(join(root, '.cache'), { recursive: true });
  await writeFile(notes, `${await releaseNotes()}\n`);
  stage('Publish the GitHub release');
  await publish(commit, notes);
  published = true;
  stage('Read the release and the update feed back');
  await confirmPublished();
};

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : error;
  console.error(
    published
      ? `\nRelease ${tag} IS published, but its read-back failed; inspect it, do not publish again: ${message}`
      : `\nRelease not published: ${message}`,
  );
  process.exit(1);
}
