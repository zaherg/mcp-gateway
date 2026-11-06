import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { UPDATER_IDENTIFIER, UPDATER_STABLE_VERSION_PATTERN } from "../src/main/updater/constants";
import {
  BUILD_IDENTITY_DEFINE,
  BUILD_IDENTITY_FILE,
  parseBuildIdentity,
} from "../src/shared/build-identity";

/** Each config evaluation supplies the same fresh identity to bundling and signed resources. */
export function prepareBuildIdentity(root: string, version: string) {
  if (!UPDATER_STABLE_VERSION_PATTERN.test(version)) throw new Error("Invalid build version");
  const identity = parseBuildIdentity({
    schema_version: 1,
    identifier: UPDATER_IDENTIFIER,
    version,
    build_id: randomBytes(32).toString("hex"),
  });
  const directory = join(root, ".cache/build-identities");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const resource = join(directory, `${identity.build_id}.json`);
  writeFileSync(resource, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
  return {
    identity,
    resource,
    define: { [BUILD_IDENTITY_DEFINE]: JSON.stringify(identity) },
    copy: { [relative(root, resource)]: BUILD_IDENTITY_FILE },
  };
}

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
