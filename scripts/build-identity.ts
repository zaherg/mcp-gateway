import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
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
