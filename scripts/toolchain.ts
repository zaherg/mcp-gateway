import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

const validateBuildHost = (platform: NodeJS.Platform, architecture: string): void => {
  if (platform !== 'darwin' || architecture !== 'arm64')
    throw new Error(`Unsupported build host: ${platform}/${architecture}.`);
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

export const buildPlan = (
  mode: string | undefined,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
) => {
  validateBuildHost(platform, architecture);
  if (!isBuildMode(mode)) throw new Error('Choose stable, stable-test, dev, or dev-build.');
  return { ...MODES[mode], mode };
};

const createToolchainEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv & {
  HUTCH_HOME: string;
  TMPDIR: string;
  TMP: string;
  TEMP: string;
  BUN_INSTALL_CACHE_DIR: string;
} => {
  const temporaryDirectory = resolve(root, '.cache/tmp');
  return {
    ...environment,
    HUTCH_HOME: resolve(root, '.hutch-home'),
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    BUN_INSTALL_CACHE_DIR: resolve(root, '.cache/bun'),
  };
};

export const toolchainEnvironment = createToolchainEnvironment();

export const command = async (args: string[], env = toolchainEnvironment) => {
  const child = Bun.spawn(args, {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args[0]} failed with exit code ${code}`);
};

export const prepareToolchain = async (environment = toolchainEnvironment) => {
  validateBuildHost(process.platform, process.arch);
  await mkdir(environment.TMPDIR, { recursive: true });
  await command(['node', 'node_modules/electrobun/bin/electrobun.cjs', 'prepare'], environment);
};

if (import.meta.main) await prepareToolchain();
