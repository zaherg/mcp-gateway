import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import packageInfo from "../package.json";
import {
  UPDATER_CHANNEL,
  UPDATER_FEED_URL,
  UPDATER_HASH_PATTERN,
  UPDATER_IDENTIFIER,
} from "../src/main/updater/constants";
import { runCommand } from "../src/main/updater/verify";
import { withDmgMount } from "./release-dmg";
import { compareBundleInventories, inventoryBundle, inventoryDigest } from "./release-inventory";

const root = resolve(import.meta.dir, "..");
const artifacts = resolve(process.env.MCP_GATEWAY_ARTIFACTS_DIR ?? join(root, "artifacts"));
const verificationOutput = resolve(
  process.env.MCP_GATEWAY_VERIFICATION_OUTPUT ?? join(artifacts, "release-verification.json"),
);
const wrapper = resolve(process.argv[2] ?? join(root, "build/stable-macos-arm64/MCP Gateway.app"));
const DMG_FILE = "macos-arm64-MCPGateway.dmg";
const MANIFEST_FILE = "stable-macos-arm64-update.json";
const ARCHIVE_FILE = "stable-macos-arm64-MCPGateway.app.tar.zst";
const dmg = join(artifacts, DMG_FILE);
const manifestPath = join(artifacts, MANIFEST_FILE);
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
const evidence: Record<string, unknown> = {
  version: packageInfo.version,
  architecture: "arm64",
  feed: UPDATER_FEED_URL,
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
    ["runtime archive", archive],
  ] as const) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size <= 0)
      throw new Error(`${name} is missing or unsafe: ${path}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const artifact = manifest.artifact;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.identifier !== UPDATER_IDENTIFIER ||
    manifest.channel !== UPDATER_CHANNEL ||
    manifest.version !== packageInfo.version ||
    typeof manifest.hash !== "string" ||
    !UPDATER_HASH_PATTERN.test(manifest.hash) ||
    manifest.platform !== "macos" ||
    manifest.arch !== "arm64" ||
    typeof artifact !== "object" ||
    artifact === null ||
    Array.isArray(artifact) ||
    (artifact as Record<string, unknown>).file !== ARCHIVE_FILE
  )
    throw new Error(
      "Update manifest does not match the package identity, version, or asset names.",
    );
  const manifestHash = manifest.hash as string;
  evidence.manifest = {
    file: MANIFEST_FILE,
    version: manifest.version,
    hash: manifestHash,
    artifact: ARCHIVE_FILE,
  };
  evidence.assets = {
    dmg: DMG_FILE,
    manifest: MANIFEST_FILE,
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
    metadata.identifier !== UPDATER_IDENTIFIER ||
    metadata.channel !== UPDATER_CHANNEL ||
    metadata.hash !== manifestHash
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
        dmgMetadata.identifier !== UPDATER_IDENTIFIER ||
        dmgMetadata.channel !== UPDATER_CHANNEL ||
        dmgMetadata.hash !== manifestHash
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
      const dmgPayload = join(dmgApp, "Contents/Resources", `${manifestHash}.tar.zst`);
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
    payloadMetadata.identifier !== UPDATER_IDENTIFIER ||
    payloadMetadata.channel !== UPDATER_CHANNEL ||
    payloadMetadata.version !== manifest.version ||
    payloadMetadata.hash !== manifestHash ||
    payloadMetadata.baseUrl !== UPDATER_FEED_URL
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
    `Verified app, DMG and signed payload signatures, tickets and Gatekeeper acceptance.\nSigned runtime for smoke test: ${payload}`,
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
