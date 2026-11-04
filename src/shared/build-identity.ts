export const BUILD_IDENTITY_FILE = "build-identity.json";
export const BUILD_IDENTITY_DEFINE = "MCP_GATEWAY_EXECUTING_BUILD";

export interface BuildIdentity {
  readonly schema_version: 1;
  readonly identifier: string;
  readonly version: string;
  readonly build_id: string;
}

export function parseBuildIdentity(value: unknown): BuildIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid executing build identity");
  if (
    !("schema_version" in value) ||
    value.schema_version !== 1 ||
    !("identifier" in value) ||
    typeof value.identifier !== "string" ||
    !value.identifier ||
    !("version" in value) ||
    typeof value.version !== "string" ||
    !value.version ||
    !("build_id" in value) ||
    typeof value.build_id !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.build_id) ||
    Object.keys(value).sort().join(",") !== "build_id,identifier,schema_version,version"
  )
    throw new Error("Invalid executing build identity");
  return Object.freeze({
    schema_version: 1,
    identifier: value.identifier,
    version: value.version,
    build_id: value.build_id,
  });
}

export function sameBuild(left: BuildIdentity, right: BuildIdentity): boolean {
  return (
    left.identifier === right.identifier &&
    left.version === right.version &&
    left.build_id === right.build_id
  );
}
