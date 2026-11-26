import { spawn } from 'node:child_process';
import { lstat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createCommandRunner } from '@mcp-gateway/core/process';

const root = resolve(import.meta.dir, '..');
export const ELECTROBUN_CLI = resolve(root, 'node_modules/electrobun/bin/electrobun.cjs');

const validateBuildHost = (): void => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error(`Unsupported build host: ${process.platform}/${process.arch}.`);
};

const MODES = {
  stable: { kind: 'production', signed: true, arguments: ['build', '--env=stable'] },
  'stable-test': { kind: 'test', signed: true, arguments: ['build', '--env=stable'] },
  dev: { kind: 'production', signed: false, arguments: ['dev', '--watch'] },
  'dev-build': { kind: 'production', signed: false, arguments: ['build', '--env=dev'] },
} as const;

type BuildMode = keyof typeof MODES;

const isBuildMode = (value: string | undefined): value is BuildMode =>
  value !== undefined && Object.hasOwn(MODES, value);

export const buildPlan = (mode: string | undefined) => {
  validateBuildHost();
  if (!isBuildMode(mode)) throw new Error('Choose stable, stable-test, dev, or dev-build.');
  return { ...MODES[mode], mode };
};

const createToolchainEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv & {
  HUTCH_HOME: string;
  TMPDIR: string;
  BUN_INSTALL_CACHE_DIR: string;
} => {
  const temporaryDirectory = resolve(root, '.cache/tmp');
  return {
    ...environment,
    HUTCH_HOME: resolve(root, '.hutch-home'),
    TMPDIR: temporaryDirectory,
    BUN_INSTALL_CACHE_DIR: resolve(root, '.cache/bun'),
  };
};

export const toolchainEnvironment = createToolchainEnvironment();

export const runForeground = (
  args: readonly string[],
  env: NodeJS.ProcessEnv = toolchainEnvironment,
  stdin: 'ignore' | 'inherit' = 'ignore',
): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    const [executable, ...rest] = args;
    if (!executable) {
      reject(new Error('Command executable is required.'));
      return;
    }
    const child = spawn(executable, rest, {
      cwd: root,
      env,
      shell: false,
      stdio: [stdin, 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${executable} failed with exit code ${code ?? -1}`));
    });
  });

export const command = runForeground;

export const captureCommand = async (
  args: readonly [string, ...string[]],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number },
) => {
  const timeoutMs = options?.timeoutMs ?? 120_000;
  const run = createCommandRunner({
    defaultTimeoutMs: timeoutMs,
    maxOutputBytes: options?.maxOutputBytes ?? 16 * 1024 * 1024,
    env: options?.env,
  });
  return run(args[0], args.slice(1), timeoutMs);
};

export const runCheckedCommand = async (
  args: readonly [string, ...string[]],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; maxOutputBytes?: number },
): Promise<string> => {
  const result = await captureCommand(args, options);
  const text = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0) throw new Error(`Command failed: ${args.join(' ')}\n${text.trim()}`);
  return text;
};

export const prepareToolchain = async (environment = toolchainEnvironment) => {
  validateBuildHost();
  try {
    const cliInfo = await lstat(ELECTROBUN_CLI);
    if (!cliInfo.isFile() || cliInfo.isSymbolicLink()) throw new Error('Invalid CLI binary.');
  } catch {
    throw new Error(
      'Missing local node_modules/electrobun/bin/electrobun.cjs. Run bun install --frozen-lockfile first.',
    );
  }
  await mkdir(environment.TMPDIR, { recursive: true });
  await runForeground(['node', ELECTROBUN_CLI, 'prepare'], environment);
};

if (import.meta.main) await prepareToolchain();
