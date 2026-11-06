import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { UPDATER_STABLE_VERSION_PATTERN } from "../src/main/updater/constants";

export function releaseOutputEnvironment<T extends NodeJS.ProcessEnv>(
  version: string,
  environment: T,
): T & { MCP_GATEWAY_BUILD_ROOT: string; MCP_GATEWAY_ARTIFACTS_DIR: string } {
  if (!UPDATER_STABLE_VERSION_PATTERN.test(version)) throw new Error("Invalid release version.");
  return {
    ...environment,
    MCP_GATEWAY_BUILD_ROOT: environment.MCP_GATEWAY_BUILD_ROOT ?? `build/v${version}`,
    MCP_GATEWAY_ARTIFACTS_DIR: environment.MCP_GATEWAY_ARTIFACTS_DIR ?? `artifacts/v${version}`,
  };
}

export function releaseArtifactFolder(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.MCP_GATEWAY_ARTIFACTS_DIR ?? "artifacts";
}

export async function assertEmptyReleaseArtifacts(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const directory = resolve(root, releaseArtifactFolder(environment));
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory())
    throw new Error("Release artifact destination is not a plain directory.");
  if ((await readdir(directory)).length > 0)
    throw new Error(
      "Release artifact directory is not empty. Choose a fresh MCP_GATEWAY_ARTIFACTS_DIR.",
    );
}
