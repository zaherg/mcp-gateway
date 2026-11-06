import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

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
