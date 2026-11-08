import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import packageInfo from "../package.json";
import { runCommand } from "../src/core/process";
import { releaseOutputEnvironment } from "./build-config";
import { withDmgMount } from "./release-dmg";
import { compareBundleInventories, inventoryBundle, inventoryDigest } from "./release-inventory";

const root = resolve(import.meta.dir, "..");
const environment = releaseOutputEnvironment(packageInfo.version, process.env);
const artifacts = resolve(root, environment.MCP_GATEWAY_ARTIFACTS_DIR);
const verificationOutput = resolve(
  process.env.MCP_GATEWAY_VERIFICATION_OUTPUT ?? join(artifacts, "release-verification.json"),
);
const wrapper = resolve(
  process.argv[2] ??
    join(root, environment.MCP_GATEWAY_BUILD_ROOT, "stable-macos-arm64/MCP Gateway.app"),
);
const DMG_FILE = "macos-arm64-MCPGateway.dmg";
const MANIFEST_FILE = "stable-macos-arm64-update.json";
const INTEGRITY_FILE = "stable-macos-arm64-update-v2.json";
const ARCHIVE_FILE = "stable-macos-arm64-MCPGateway.app.tar.zst";
const IDENTIFIER = "dev.srvr.mcpgateway";
const CHANNEL = "stable";
const FEED_URL = "https://github.com/zaherg/mcp-gateway/releases/latest/download";
const HASH_PATTERN = /^[a-z0-9]{1,13}$/;
const MAX_EXPANDED_ARCHIVE_BYTES = 512 * 1024 * 1024;
const dmg = join(artifacts, DMG_FILE);
const manifestPath = join(artifacts, MANIFEST_FILE);
const integrityPath = join(artifacts, INTEGRITY_FILE);
const archive = join(artifacts, ARCHIVE_FILE);
const redact = (value: string) => {
  let text = value;
  for (const name of ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_APP_PASSWORD"])
    if (process.env[name]) text = text.split(process.env[name]).join("[redacted]");
  return text
    .replace(
      /^(Authority|origin)=Developer ID Application:.*$/gm,
      "$1=Developer ID Application [redacted]",
    )
    .replace(/^TeamIdentifier=.*$/gm, "TeamIdentifier=[redacted]");
};
const checks: Array<{ name: string; exitCode: number; output: string }> = [];
const cancellation = new AbortController();
process.env.TMPDIR = join(root, ".cache/tmp");
async function check(name: string, args: [string, ...string[]]) {
  const { stdout, stderr, exitCode } = await runCommand(
    args[0],
    args.slice(1),
    120_000,
    cancellation.signal,
  );
  checks.push({ name, exitCode, output: redact(`${stdout}\n${stderr}`).trim() });
  if (exitCode !== 0) throw new Error(`${name} failed; inspect the redacted verification record.`);
  return stdout;
}
async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    cancellation.signal.throwIfAborted();
    digest.update(chunk);
  }
  return digest.digest("hex");
}
async function archiveDigest(path: string): Promise<{ sha256: string; size: number }> {
  const digest = createHash("sha256");
  let size = 0;
  await pipeline(createReadStream(path), createZstdDecompress(), async (chunks) => {
    for await (const chunk of chunks) {
      cancellation.signal.throwIfAborted();
      size += chunk.length;
      if (size > MAX_EXPANDED_ARCHIVE_BYTES)
        throw new Error("Update archive exceeds the expanded size limit.");
      digest.update(chunk);
    }
  });
  return { sha256: digest.digest("hex"), size };
}
interface UpdateManifest {
  schemaVersion: number;
  identifier: string;
  channel: string;
  version: string;
  hash: string;
  platform: string;
  arch: string;
  artifact: { file: string; tarSha256?: string; tarSize?: number };
}
function parseManifest(value: unknown, label: string): UpdateManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} is not an object.`);
  const manifest = value as Record<string, unknown>;
  const artifact = manifest.artifact;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.identifier !== IDENTIFIER ||
    manifest.channel !== CHANNEL ||
    manifest.version !== packageInfo.version ||
    typeof manifest.hash !== "string" ||
    !HASH_PATTERN.test(manifest.hash) ||
    manifest.platform !== "macos" ||
    manifest.arch !== "arm64" ||
    typeof artifact !== "object" ||
    artifact === null ||
    Array.isArray(artifact) ||
    (artifact as Record<string, unknown>).file !== ARCHIVE_FILE
  )
    throw new Error(`${label} does not match the app identity, version, or artifact name.`);
  return value as UpdateManifest;
}
const evidence: Record<string, unknown> = {
  version: packageInfo.version,
  architecture: "arm64",
  feed: FEED_URL,
  checkedAt: new Date().toISOString(),
  checks,
};
const cancel = (signal: "SIGINT" | "SIGTERM") => {
  if (cancellation.signal.aborted) return;
  evidence.cancelledBy = signal;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  cancellation.abort(new Error("Release verification cancelled."));
};
const interrupt = () => cancel("SIGINT");
const terminate = () => cancel("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  await mkdir(process.env.TMPDIR, { recursive: true });
  for (const [name, path] of [
    ["DMG", dmg],
    ["update manifest", manifestPath],
    ["update integrity manifest", integrityPath],
    ["runtime archive", archive],
  ] as const) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size <= 0)
      throw new Error(`${name} is missing or unsafe: ${path}`);
  }
  const manifest = parseManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
    "Update manifest",
  );
  const integrity = parseManifest(
    JSON.parse(await readFile(integrityPath, "utf8")),
    "Update integrity manifest",
  );
  for (const key of [
    "schemaVersion",
    "identifier",
    "channel",
    "version",
    "hash",
    "platform",
    "arch",
  ] as const)
    if (integrity[key] !== manifest[key]) throw new Error(`Update manifests disagree on ${key}.`);
  const artifact = integrity.artifact;
  if (
    typeof artifact.tarSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(artifact.tarSha256) ||
    !Number.isSafeInteger(artifact.tarSize) ||
    (artifact.tarSize as number) <= 0 ||
    (artifact.tarSize as number) > MAX_EXPANDED_ARCHIVE_BYTES
  )
    throw new Error("Update integrity manifest has invalid archive metadata.");
  const archiveIntegrity = await archiveDigest(archive);
  if (archiveIntegrity.size !== artifact.tarSize || archiveIntegrity.sha256 !== artifact.tarSha256)
    throw new Error("Update archive integrity metadata mismatch.");
  evidence.manifest = {
    file: MANIFEST_FILE,
    version: manifest.version,
    hash: manifest.hash,
    artifact: ARCHIVE_FILE,
  };
  evidence.archive = {
    file: ARCHIVE_FILE,
    sha256: archiveIntegrity.sha256,
    size: archiveIntegrity.size,
  };
  evidence.assets = {
    dmg: DMG_FILE,
    manifest: MANIFEST_FILE,
    integrity: INTEGRITY_FILE,
    runtimeArchive: ARCHIVE_FILE,
  };
  await check("wrapper signature", [
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    wrapper,
  ]);
  const wrapperVersion = (
    await check("wrapper version", [
      "/usr/bin/plutil",
      "-extract",
      "CFBundleVersion",
      "raw",
      join(wrapper, "Contents/Info.plist"),
    ])
  ).trim();
  if (wrapperVersion !== packageInfo.version)
    throw new Error("Wrapper version does not match package.json.");
  await check("wrapper ticket", ["/usr/bin/xcrun", "stapler", "validate", wrapper]);
  await check("wrapper Gatekeeper", [
    "/usr/sbin/spctl",
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    wrapper,
  ]);
  await check("DMG signature", ["/usr/bin/codesign", "--verify", "--strict", "--verbose=2", dmg]);
  await check("DMG ticket", ["/usr/bin/xcrun", "stapler", "validate", dmg]);
  await check("DMG Gatekeeper", [
    "/usr/sbin/spctl",
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmg,
  ]);
  const wrapperInventory = await inventoryBundle(wrapper, cancellation.signal);
  evidence.wrapperInventory = {
    entries: wrapperInventory.length,
    digest: inventoryDigest(wrapperInventory),
  };
  const metadata = JSON.parse(
    await readFile(join(wrapper, "Contents/Resources/metadata.json"), "utf8"),
  );
  if (
    metadata.identifier !== IDENTIFIER ||
    metadata.channel !== CHANNEL ||
    metadata.hash !== manifest.hash
  )
    throw new Error("Wrapper metadata does not match the update manifest.");
  const digest = await hash(archive);
  if ((await hash(join(wrapper, `Contents/Resources/${metadata.hash}.tar.zst`))) !== digest)
    throw new Error("Wrapper/update payload mismatch.");
  evidence.payloadArchiveSha256 = digest;
  evidence.dmgSha256 = await hash(dmg);
  await withDmgMount(
    dmg,
    join(root, ".cache"),
    async (dmgMount) => {
      const dmgApps = (await readdir(dmgMount)).filter((name) => name.endsWith(".app"));
      if (dmgApps.length !== 1) throw new Error("DMG must contain exactly one application bundle.");
      const dmgApp = join(dmgMount, dmgApps[0] as string);
      await check("DMG app signature", [
        "/usr/bin/codesign",
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        dmgApp,
      ]);
      await check("DMG app ticket", ["/usr/bin/xcrun", "stapler", "validate", dmgApp]);
      const dmgMetadata = JSON.parse(
        await readFile(join(dmgApp, "Contents/Resources/metadata.json"), "utf8"),
      );
      if (
        dmgMetadata.identifier !== IDENTIFIER ||
        dmgMetadata.channel !== CHANNEL ||
        dmgMetadata.hash !== manifest.hash
      )
        throw new Error("DMG application metadata does not match the update manifest.");
      const dmgVersion = (
        await check("DMG app version", [
          "/usr/bin/plutil",
          "-extract",
          "CFBundleVersion",
          "raw",
          join(dmgApp, "Contents/Info.plist"),
        ])
      ).trim();
      if (dmgVersion !== packageInfo.version)
        throw new Error("DMG application version does not match package.json.");
      const dmgPayload = join(dmgApp, "Contents/Resources", `${manifest.hash}.tar.zst`);
      if ((await hash(dmgPayload)) !== digest)
        throw new Error("DMG application update payload does not match the runtime archive.");
      const dmgInventory = await inventoryBundle(dmgApp, cancellation.signal);
      try {
        compareBundleInventories(wrapperInventory, dmgInventory, {
          expected: "verified wrapper",
          actual: "DMG wrapper",
        });
      } catch (error) {
        evidence.dmgApp = {
          name: dmgApps[0],
          version: dmgVersion,
          payloadMatched: true,
          inventoryMatched: false,
        };
        throw error;
      }
      evidence.dmgApp = {
        name: dmgApps[0],
        version: dmgVersion,
        payloadMatched: true,
        inventoryMatched: true,
        inventoryEntries: dmgInventory.length,
        inventoryDigest: inventoryDigest(dmgInventory),
      };
    },
    {
      signal: cancellation.signal,
      onCleanup: (result) => {
        evidence.dmgDetach = result;
      },
    },
  );
  const destination = await mkdtemp(join(root, ".cache/signed-payload-"));
  // The wrapper replaces itself on first launch; execute a separate signed payload
  // for local verification without changing the deliverable or using Launch Services.
  await check("extract signed payload", ["/usr/bin/tar", "-xf", archive, "-C", destination]);
  const payload = join(destination, "MCP Gateway.app");
  evidence.payloadPath = payload;
  await check("payload signature", [
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    payload,
  ]);
  await check("payload ticket", ["/usr/bin/xcrun", "stapler", "validate", payload]);
  await check("payload Gatekeeper", [
    "/usr/sbin/spctl",
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    payload,
  ]);
  const payloadVersion = (
    await check("payload version", [
      "/usr/bin/plutil",
      "-extract",
      "CFBundleVersion",
      "raw",
      join(payload, "Contents/Info.plist"),
    ])
  ).trim();
  if (payloadVersion !== packageInfo.version)
    throw new Error("Payload version does not match package.json.");
  const payloadMetadata = JSON.parse(
    await readFile(join(payload, "Contents/Resources/version.json"), "utf8"),
  ) as Record<string, unknown>;
  if (
    payloadMetadata.identifier !== IDENTIFIER ||
    payloadMetadata.channel !== CHANNEL ||
    payloadMetadata.version !== manifest.version ||
    payloadMetadata.hash !== manifest.hash ||
    payloadMetadata.baseUrl !== FEED_URL
  )
    throw new Error("Payload identity, version, hash, or fixed feed does not match the manifest.");
  await check("payload signing metadata", [
    "/usr/bin/codesign",
    "--display",
    "--verbose=4",
    payload,
  ]);
  await check("payload entitlements", [
    "/usr/bin/codesign",
    "--display",
    "--entitlements",
    ":-",
    payload,
  ]);
  const knownSecrets = [process.env.APPLE_ID, process.env.APPLE_APP_PASSWORD]
    .filter((value): value is string => !!value)
    .map((value) => Buffer.from(value));
  let files = 0;
  async function scan(path: string): Promise<void> {
    cancellation.signal.throwIfAborted();
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) await scan(join(path, entry));
      return;
    }
    if (!info.isFile()) return;
    files++;
    let tail = Buffer.alloc(0);
    const overlap = Math.max(1, ...knownSecrets.map((secret) => secret.length)) - 1;
    for await (const chunk of createReadStream(path)) {
      cancellation.signal.throwIfAborted();
      const bytes = Buffer.concat([tail, Buffer.from(chunk)]);
      if (knownSecrets.some((secret) => bytes.includes(secret)))
        throw new Error("Signing account/password bytes were found in the payload.");
      tail = overlap ? bytes.subarray(Math.max(0, bytes.length - overlap)) : Buffer.alloc(0);
    }
  }
  await scan(payload);
  evidence.credentialScan = {
    files,
    configuredSecretCount: knownSecrets.length,
    performed: knownSecrets.length > 0,
    accountPasswordMatches: 0,
    publicSigningCertificateMetadataExcluded: true,
  };
  const keys = ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_APP_PASSWORD"];
  if (keys.every((key) => !!process.env[key])) {
    const output = await check("Apple notarization history", [
      "/usr/bin/xcrun",
      "notarytool",
      "history",
      "--apple-id",
      process.env.APPLE_ID ?? "",
      "--team-id",
      process.env.APPLE_TEAM_ID ?? "",
      "--password",
      process.env.APPLE_APP_PASSWORD ?? "",
      "--output-format",
      "json",
    ]);
    const history = JSON.parse(output);
    evidence.notarization = history.history
      .filter(
        (entry: { name?: string }) =>
          entry.name === "MCP Gateway.app.zip" || entry.name === "MCPGateway.dmg",
      )
      .slice(0, 3)
      .map((entry: { id: string; name: string; status: string; createdDate: string }) => ({
        id: entry.id,
        name: entry.name,
        status: entry.status,
        createdDate: entry.createdDate,
      }));
    // Preserve only the relevant redacted, structured receipt rather than account history.
    checks.pop();
  }
  cancellation.signal.throwIfAborted();
  evidence.ok = true;
  console.log(
    `Verified app, DMG and signed payload signatures, tickets and Gatekeeper acceptance.\nSigned runtime: ${payload}`,
  );
} catch (error) {
  evidence.ok = false;
  evidence.error = redact(error instanceof Error ? error.message : "Release verification failed.");
  process.exitCode ||= 1;
  console.error(evidence.error);
} finally {
  await mkdir(dirname(verificationOutput), { recursive: true });
  await writeFile(verificationOutput, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
