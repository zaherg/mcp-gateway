import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import packageInfo from '../package.json';
import { STABLE_VERSION_PATTERN } from './build-config';

// CHANGELOG.md follows Keep a Changelog 1.0.0. git-cliff renders one section from the
// commits; this script splices it into the file and keeps the version links current.

const root = resolve(import.meta.dir, '..');
const changelogPath = join(root, 'CHANGELOG.md');
const repository = packageInfo.repository.url;
const UNRELEASED_HEADING = /^## \[Unreleased\]$/m;
const VERSION_HEADING = /^## \[([0-9]+\.[0-9]+\.[0-9]+)\]/m;
const UNRELEASED_LINK = /^\[Unreleased\]: .*$/m;
const PREVIOUS_NOTE = /^Changes after `[^`]*`\.[ \t]*$/m;

const options = parseArgs({
  args: process.argv.slice(2),
  options: { tag: { type: 'string' } },
});

/** Collapses blank runs inside one section; the rest of the file is never rewritten. */
const normalize = (text: string): string => text.replace(/\n{3,}/g, '\n\n').trim();

/** Replaces `[start, end)` with `text`, keeping one blank line before the next section. */
const splice = (original: string, start: number, end: number, text: string): string =>
  `${original.slice(0, start)}${text}\n\n${original.slice(end)}`;

/** Byte range of a `## [...]` section, from its heading to the next one or the end. */
const section = (text: string, heading: RegExp): { start: number; end: number } => {
  const match = heading.exec(text);
  if (!match) throw new Error('CHANGELOG.md has no ## [Unreleased] section.');
  const start = match.index;
  const tail = text.slice(start + match[0].length);
  const next = /^## \[/m.exec(tail);
  return { start, end: next ? start + match[0].length + next.index : text.length };
};

const localDate = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${String(now.getDate()).padStart(2, '0')}`;
};

/** Starts git-cliff, reporting a missing binary as an instruction instead of a spawn error. */
const spawnCliff = (args: string[]) => {
  try {
    return Bun.spawn(args, { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch {
    throw new Error('git-cliff is not installed. Install it, then run this again.');
  }
};

const render = async (): Promise<string> => {
  const child = spawnCliff(['git-cliff', '--unreleased']);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git-cliff failed: ${stderr.trim()}`);
  return normalize(stdout.replace(/[ \t]+$/gm, ''));
};

/** Replaces the Unreleased section with entries rendered from the commits since the last tag. */
const refresh = async (original: string): Promise<string> => {
  const { start, end } = section(original, UNRELEASED_HEADING);
  const rendered = await render();
  if (!/^## \[/m.test(rendered)) throw new Error('No changelog-worthy commits since the last tag.');
  return splice(original, start, end, rendered);
};

/** Moves the Unreleased entries under the version and opens a new Unreleased section. */
const stamp = (original: string, tag: string): string => {
  if (!STABLE_VERSION_PATTERN.test(tag))
    throw new Error('The tag must be a version, such as 0.8.0.');
  if (tag !== packageInfo.version)
    throw new Error(
      `CHANGELOG.md takes the version from package.json, which is ${packageInfo.version}.`,
    );
  if (new RegExp(`^## \\[${tag.replaceAll('.', '\\.')}\\]`, 'm').test(original))
    throw new Error(`CHANGELOG.md already has a section for ${tag}.`);
  const { start, end } = section(original, UNRELEASED_HEADING);
  const entries = original.slice(start, end).replace(/^## \[Unreleased\]$/m, '');
  const body = normalize(entries.replace(PREVIOUS_NOTE, ''));
  if (!body) throw new Error('The Unreleased section has no entries to release.');
  const previous = VERSION_HEADING.exec(original.slice(end))?.[1];
  if (!previous) throw new Error('No released version follows the Unreleased section.');
  const reopened = [
    '## [Unreleased]',
    '',
    `Changes after \`${tag}\`.`,
    '',
    `## [${tag}] - ${localDate()}`,
    '',
    body,
  ].join('\n');
  const linked = splice(original, start, end, reopened);
  if (!UNRELEASED_LINK.test(linked)) throw new Error('CHANGELOG.md has no [Unreleased] link.');
  const refs = [
    `[Unreleased]: ${repository}/compare/${tag}...HEAD`,
    `[${tag}]: ${repository}/compare/${previous}...${tag}`,
  ].join('\n');
  return linked.replace(UNRELEASED_LINK, () => refs);
};

const main = async (): Promise<void> => {
  const original = await readFile(changelogPath, 'utf8');
  const tag = options.values.tag;
  const next = tag === undefined ? await refresh(original) : stamp(original, tag);
  if (next === original) {
    console.log('CHANGELOG.md is already current.');
    return;
  }
  await writeFile(changelogPath, next);
  console.log(`Updated CHANGELOG.md${tag === undefined ? '' : ` for ${tag}`}.`);
};

try {
  await main();
} catch (error) {
  console.error(`\nCHANGELOG.md unchanged: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
