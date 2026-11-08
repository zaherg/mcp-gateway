import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

export function validateBuildHost(platform: NodeJS.Platform, architecture: string): void {
  if (platform !== "darwin" || architecture !== "arm64")
    throw new Error(`Unsupported build host: ${platform}/${architecture}.`);
}

export function buildPlan(
  mode: string | undefined,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): { signed: boolean; arguments: string[] } {
  validateBuildHost(platform, architecture);
  if (!["stable", "dev", "dev-build"].includes(mode ?? ""))
    throw new Error("Choose stable, dev, or dev-build.");
  return {
    signed: mode === "stable",
    arguments:
      mode === "dev" ? ["dev"] : ["build", `--env=${mode === "dev-build" ? "dev" : "stable"}`],
  };
}

export function createToolchainEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv & {
  HUTCH_HOME: string;
  TMPDIR: string;
  TMP: string;
  TEMP: string;
  BUN_INSTALL_CACHE_DIR: string;
} {
  const temporaryDirectory = resolve(root, ".cache/tmp");
  return {
    ...environment,
    HUTCH_HOME: resolve(root, ".hutch-home"),
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
    BUN_INSTALL_CACHE_DIR: resolve(root, ".cache/bun"),
  };
}

export const toolchainEnvironment = createToolchainEnvironment();

export async function command(args: string[], env = toolchainEnvironment) {
  const child = Bun.spawn(args, {
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${args[0]} failed with exit code ${code}`);
}

export async function prepareToolchain() {
  validateBuildHost(process.platform, process.arch);
  await mkdir(toolchainEnvironment.TMPDIR, { recursive: true });
  await command(["node", "node_modules/electrobun/bin/electrobun.cjs", "prepare"]);
}

if (import.meta.main) await prepareToolchain();
