import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateBuildHost } from "./build-platform";

const root = resolve(import.meta.dir, "..");
const macDevkitRoot = resolve(root, ".cache/toolchain/electrobun-2.0.5");

export function createToolchainEnvironment(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv & {
  HUTCH_HOME: string;
  TMPDIR: string;
  TMP: string;
  TEMP: string;
  BUN_INSTALL_CACHE_DIR: string;
} {
  // Only the verified macOS workaround uses local runtime overrides. Other hosts
  // use the pinned bootstrap's own architecture selection and checksum checks.
  const macOverrides =
    platform === "darwin" && architecture === "arm64"
      ? {
          HUTCH_ELECTROBUN_DEVKIT_ROOT: macDevkitRoot,
          COTTONTAIL_BINARY: resolve(
            root,
            ".cache/toolchain/cottontail-0.7.3/cottontail-v0.7.3-macos-arm64/bin/cottontail",
          ),
        }
      : {};
  const temporaryDirectory = resolve(root, ".cache/tmp");
  return {
    ...environment,
    ...macOverrides,
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

async function download(name: string, url: string, sha256: string) {
  const path = resolve(root, ".cache/research", name);
  await mkdir(resolve(root, ".cache/research"), { recursive: true });
  if (!existsSync(path)) {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 MCP-Gateway-build" },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Toolchain download failed: ${name} HTTP ${response.status}`);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (digest !== sha256) throw new Error(`Toolchain checksum mismatch: ${name}`);
  return path;
}

export async function prepareToolchain() {
  validateBuildHost(process.platform, process.arch);
  await mkdir(toolchainEnvironment.TMPDIR, { recursive: true });
  if (process.platform !== "darwin") {
    await command(["node", "node_modules/electrobun/bin/electrobun.cjs", "prepare"]);
    return;
  }
  // Hutch's downloader timed out here. Use verified official release artifacts and
  // supported local runtime/devkit overrides instead of patching framework code.
  const core = await download(
    "electrobun-core-darwin-arm64.tar.gz",
    "https://github.com/blackboardsh/electrobun/releases/download/v2.0.5/electrobun-core-darwin-arm64.tar.gz",
    "610db158df864a067055be365e443d3945392012f92092fb77c26bd2215ef892",
  );
  const coreRoot = macDevkitRoot;
  await mkdir(coreRoot, { recursive: true });
  await command(["/usr/bin/tar", "-xzf", core, "-C", coreRoot]);
  const cotton = await download(
    "cottontail-0.7.3.tar.gz",
    "https://electrobun-artifacts.blackboard.sh/cottontail/builds/e612fc3e1692d963054cc4547d1c47f602b96d03/macos-arm64/cottontail.tar.gz",
    "f2c8c4dd6be4c24ed1b178fc778648163a5677c95176b641986c50020aa0ac66",
  );
  const cottonRoot = resolve(root, ".cache/toolchain/cottontail-0.7.3");
  await mkdir(cottonRoot, { recursive: true });
  await command(["/usr/bin/tar", "-xzf", cotton, "-C", cottonRoot]);
  const bun = await download(
    "bun-darwin-aarch64-1.4.4.zip",
    "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-darwin-aarch64.zip",
    "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510",
  );
  const unpack = resolve(root, ".cache/toolchain/bun-unpack");
  await mkdir(unpack, { recursive: true });
  await command(["/usr/bin/ditto", "-x", "-k", bun, unpack]);
  // Populate the exact-version managed cache layout used by Hutch 0.28.2.
  // The original release bytes are preserved; Hutch verifies the binary version.
  const bunRoot = resolve(toolchainEnvironment.HUTCH_HOME, "toolchains/bun/1.4.4/macos-arm64");
  await mkdir(bunRoot, { recursive: true });
  const destination = resolve(bunRoot, "bun");
  await writeFile(destination, await readFile(resolve(unpack, "bun-darwin-aarch64/bun")));
  await chmod(destination, 0o755);
  const version = await new Response(
    Bun.spawn([destination, "--version"], {
      stdout: "pipe",
      stderr: "inherit",
      env: toolchainEnvironment,
    }).stdout,
  ).text();
  if (version.trim() !== "1.4.4") throw new Error("Downloaded Bun version mismatch");
  await writeFile(resolve(bunRoot, ".hutch-toolchain"), "1.4.4");
  await command(["node", "node_modules/electrobun/bin/electrobun.cjs", "prepare"]);
}

if (import.meta.main) await prepareToolchain();
