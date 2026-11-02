import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import packageInfo from "../package.json";

const root = resolve(import.meta.dir, "..");
const wrapper = resolve(process.argv[2] ?? join(root, "build/stable-macos-arm64/MCP Gateway.app"));
const dmg = join(root, "artifacts/macos-arm64-MCPGateway.dmg");
const archive = join(root, "artifacts/stable-macos-arm64-MCPGateway.app.tar.zst");
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
async function check(name: string, args: string[]) {
  const child = Bun.spawn(args, {
    cwd: root,
    env: { ...process.env, TMPDIR: join(root, ".cache/tmp") },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  checks.push({ name, exitCode, output: redact(`${stdout}\n${stderr}`).trim() });
  if (exitCode !== 0) throw new Error(`${name} failed; inspect the redacted verification record.`);
  return stdout;
}
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const evidence: Record<string, unknown> = {
  version: packageInfo.version,
  architecture: "arm64",
  checkedAt: new Date().toISOString(),
  checks,
};
try {
  await check("wrapper signature", [
    "/usr/bin/codesign",
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    wrapper,
  ]);
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
  const metadata = JSON.parse(
    await readFile(join(wrapper, "Contents/Resources/metadata.json"), "utf8"),
  );
  if (typeof metadata.hash !== "string" || !/^[A-Za-z0-9]+$/.test(metadata.hash))
    throw new Error("Invalid wrapper payload hash.");
  const digest = await hash(archive);
  if ((await hash(join(wrapper, `Contents/Resources/${metadata.hash}.tar.zst`))) !== digest)
    throw new Error("Wrapper/update payload mismatch.");
  evidence.payloadArchiveSha256 = digest;
  evidence.dmgSha256 = await hash(dmg);
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
      const bytes = Buffer.concat([tail, Buffer.from(chunk)]);
      if (knownSecrets.some((secret) => bytes.includes(secret)))
        throw new Error("Signing account/password bytes were found in the payload.");
      tail = overlap ? bytes.subarray(Math.max(0, bytes.length - overlap)) : Buffer.alloc(0);
    }
  }
  await scan(payload);
  evidence.credentialScan = {
    files,
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
  console.log(
    `Verified app, DMG and signed payload signatures, tickets and Gatekeeper acceptance.\nSigned runtime for smoke test: ${payload}`,
  );
} finally {
  await mkdir(join(root, "artifacts"), { recursive: true });
  await writeFile(
    join(root, "artifacts/release-verification.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o600 },
  );
}
