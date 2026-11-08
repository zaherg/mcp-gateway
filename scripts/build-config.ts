import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { PRODUCTION_IDENTIFIER, TEST_IDENTIFIER } from "@mcp-gateway/shared/identity";

export { PRODUCTION_IDENTIFIER, TEST_IDENTIFIER };

export const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const PRODUCTION_FEED = "https://github.com/zaherg/mcp-gateway/releases/latest/download";
type BuildKind = "production" | "test";

export const validateFeedUrl = (value: string | undefined): string => {
  if (
    !value ||
    /\s/.test(value) ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value.endsWith("/")
  )
    throw new Error("An update feed URL without whitespace or a trailing slash is required.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid update feed URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    value.includes("?") ||
    value.includes("#")
  )
    throw new Error(
      "Update feeds require HTTPS (or loopback HTTP), without credentials, query or fragment.",
    );
  return value;
};

export const buildIdentity = (environment: NodeJS.ProcessEnv = process.env) => {
  const kind = environment.MCP_GATEWAY_BUILD_KIND ?? "production";
  if (kind !== "production" && kind !== "test") throw new Error("Invalid build kind.");
  return {
    kind,
    identifier: kind === "test" ? TEST_IDENTIFIER : PRODUCTION_IDENTIFIER,
    feed: kind === "test" ? validateFeedUrl(environment.MCP_GATEWAY_TEST_FEED) : PRODUCTION_FEED,
    notarize: kind === "production",
  };
};

export const releaseOutputEnvironment = <T extends NodeJS.ProcessEnv>(
  version: string,
  environment: T,
  kind: BuildKind = "production",
): T & { MCP_GATEWAY_BUILD_ROOT: string; MCP_GATEWAY_ARTIFACTS_DIR: string } => {
  if (!STABLE_VERSION_PATTERN.test(version)) throw new Error("Invalid release version.");
  const prefix = kind === "test" ? "test-v" : "v";
  return {
    ...environment,
    MCP_GATEWAY_BUILD_ROOT: environment.MCP_GATEWAY_BUILD_ROOT ?? `build/${prefix}${version}`,
    MCP_GATEWAY_ARTIFACTS_DIR:
      environment.MCP_GATEWAY_ARTIFACTS_DIR ?? `artifacts/${prefix}${version}`,
  };
};

export const releaseArtifactFolder = (environment: NodeJS.ProcessEnv = process.env): string => {
  return environment.MCP_GATEWAY_ARTIFACTS_DIR ?? "artifacts";
};

export const assertEmptyReleaseOutputs = async (
  root: string,
  environment: NodeJS.ProcessEnv,
  kind: BuildKind,
): Promise<void> => {
  const paths = [environment.MCP_GATEWAY_BUILD_ROOT, environment.MCP_GATEWAY_ARTIFACTS_DIR];
  const directories = paths.map((value) => {
    if (!value) throw new Error("Release output directories are required.");
    const directory = resolve(root, value);
    const local = relative(root, directory);
    if (!local || isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
      throw new Error("Release output directories must stay inside the project.");
    const opposite =
      kind === "test" ? /^(?:build|artifacts)\/v\d/ : /^(?:build|artifacts)\/test-v\d/;
    if (opposite.test(local)) throw new Error("Release output belongs to the other build kind.");
    return directory;
  });
  if (directories[0] === directories[1])
    throw new Error("Build and artifact directories must differ.");
  for (const directory of directories) {
    let current = root;
    for (const part of relative(root, directory).split(sep)) {
      current = resolve(current, part);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink() || !entry.isDirectory())
          throw new Error("Release output ancestors must be plain directories.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
    try {
      if ((await readdir(directory)).length > 0)
        throw new Error(
          "Release output directory is not empty; choose fresh build and artifact paths.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};
