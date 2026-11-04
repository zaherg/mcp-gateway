import { constants } from "node:fs";
import { access, lstat, open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type CommandChild,
  type CommandResult,
  type CommandRunner,
  type CommandStart,
  createCommandRunner as createOwnedCommandRunner,
  runCommand,
} from "../../core/command";
import {
  BUILD_IDENTITY_FILE,
  type BuildIdentity,
  parseBuildIdentity,
  sameBuild,
} from "../../shared/build-identity";
import {
  isSafeRelativeComponent,
  requiredBundleExecutables,
  UPDATER_ARCH,
  UPDATER_CHANNEL,
  UPDATER_FEED_URL,
  UPDATER_HASH_PATTERN,
  UPDATER_IDENTIFIER,
  UPDATER_STABLE_VERSION_PATTERN,
} from "./constants";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 50_000;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024;
const CODESIGN = "/usr/bin/codesign";
const LIPO = "/usr/bin/lipo";
const PLUTIL = "/usr/bin/plutil";
const MACHO_MAGIC = new Set([
  0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);

export type { CommandChild as VerificationChild, CommandResult, CommandRunner };
export { runCommand };

export function createCommandRunner(start?: CommandStart): CommandRunner {
  return createOwnedCommandRunner({ start });
}

export class ApplicationVerificationError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ApplicationVerificationError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new ApplicationVerificationError(code);
}

export interface BundleMetadata {
  identifier: string;
  version: string;
  hash: string;
  channel: string;
  baseUrl: string;
  displayName: string;
  executable: string;
  architectures: string[];
  bundlePath: string;
}

export interface PublisherIdentity {
  identifier: string;
  teamId: string;
}

export interface ExpectedCandidate {
  version: string;
  hash: string;
  publisher: PublisherIdentity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") fail("candidate_metadata_invalid");
  return value;
}

async function readBoundedText(path: string): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > MAX_DOCUMENT_BYTES)
    fail("candidate_metadata_unavailable");
  return readFile(path, "utf8");
}

function parseVersionDocument(document: unknown): {
  identifier: string;
  version: string;
  hash: string;
  channel: string;
  baseUrl: string;
  name: string;
  displayName: string;
} {
  if (!isRecord(document)) fail("candidate_metadata_invalid");
  const identifier = requiredString(document, "identifier");
  const version = requiredString(document, "version");
  const hash = requiredString(document, "hash");
  const channel = requiredString(document, "channel");
  const baseUrl = requiredString(document, "baseUrl");
  const name = requiredString(document, "name");
  const displayName = requiredString(document, "displayName");
  if (
    identifier !== UPDATER_IDENTIFIER ||
    channel !== UPDATER_CHANNEL ||
    !UPDATER_STABLE_VERSION_PATTERN.test(version) ||
    !UPDATER_HASH_PATTERN.test(hash) ||
    baseUrl !== UPDATER_FEED_URL ||
    !isSafeRelativeComponent(name) ||
    !isSafeRelativeComponent(displayName)
  )
    fail("candidate_metadata_mismatch");
  return { identifier, version, hash, channel, baseUrl, name, displayName };
}

export async function readVersionMetadata(path: string) {
  return parseVersionDocument(JSON.parse(await readBoundedText(path)));
}

export async function readBuildIdentityResource(bundlePath: string): Promise<BuildIdentity> {
  return parseBuildIdentity(
    JSON.parse(
      await readBoundedText(join(bundlePath, "Contents/Resources/app", BUILD_IDENTITY_FILE)),
    ),
  );
}

export function parseCodesignDisplay(output: string): {
  identifier: string;
  teamId: string;
  developerId: boolean;
} {
  const values = output.split(/\r?\n/);
  const identifierLine = values.find((line) => line.startsWith("Identifier="));
  const teamLine = values.find((line) => line.startsWith("TeamIdentifier="));
  const identifier = identifierLine?.slice("Identifier=".length).trim() ?? "";
  const teamId = teamLine?.slice("TeamIdentifier=".length).trim() ?? "";
  const developerId = values.some((line) => line.startsWith("Authority=Developer ID Application:"));
  return { identifier, teamId, developerId };
}

async function runChecked(
  run: CommandRunner,
  command: string,
  args: readonly string[],
  failureCode: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) fail("candidate_cancelled");
  const result = await run(command, args, undefined, signal);
  if (signal?.aborted) fail("candidate_cancelled");
  if (result.exitCode !== 0) fail(failureCode);
  return result;
}

async function assertPlainBundleTree(
  bundlePath: string,
  signal?: AbortSignal,
  onFile?: (path: string) => Promise<void>,
): Promise<void> {
  let entries = 0;
  let bytes = 0;
  async function visit(path: string): Promise<void> {
    if (signal?.aborted) fail("candidate_cancelled");
    const info = await lstat(path);
    if (info.isSymbolicLink()) fail("candidate_bundle_symlink");
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
      return;
    }
    if (signal?.aborted) fail("candidate_cancelled");
    if (!info.isFile()) fail("candidate_bundle_special_file");
    entries++;
    bytes += info.size;
    if (entries > MAX_BUNDLE_ENTRIES || bytes > MAX_BUNDLE_BYTES)
      fail("candidate_bundle_too_large");
    await onFile?.(path);
  }
  await visit(bundlePath);
}

async function readMetadata(
  run: CommandRunner,
  bundlePath: string,
  signal?: AbortSignal,
): Promise<BundleMetadata> {
  const info = await lstat(bundlePath);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("candidate_bundle_unavailable");
  await assertPlainBundleTree(bundlePath, signal);
  if (signal?.aborted) fail("candidate_cancelled");
  const metadata = await readVersionMetadata(join(bundlePath, "Contents/Resources/version.json"));
  const plist = await runChecked(
    run,
    PLUTIL,
    ["-extract", "CFBundleIdentifier", "raw", join(bundlePath, "Contents/Info.plist")],
    "candidate_plist_invalid",
    signal,
  );
  if (plist.stdout.trim() !== UPDATER_IDENTIFIER) fail("candidate_bundle_identifier_mismatch");
  const bundleVersion = await runChecked(
    run,
    PLUTIL,
    ["-extract", "CFBundleVersion", "raw", join(bundlePath, "Contents/Info.plist")],
    "candidate_plist_invalid",
    signal,
  );
  if (bundleVersion.stdout.trim() !== metadata.version) fail("candidate_version_mismatch");
  const executableResult = await runChecked(
    run,
    PLUTIL,
    ["-extract", "CFBundleExecutable", "raw", join(bundlePath, "Contents/Info.plist")],
    "candidate_plist_invalid",
    signal,
  );
  const executable = executableResult.stdout.trim();
  if (!isSafeRelativeComponent(executable)) fail("candidate_executable_invalid");
  const executablePath = join(bundlePath, "Contents/MacOS", executable);
  for (const relative of requiredBundleExecutables(executable)) {
    if (signal?.aborted) fail("candidate_cancelled");
    try {
      const path = join(bundlePath, relative);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) fail("candidate_executable_unavailable");
      // Code signatures do not authenticate executable mode or ACL access.
      await access(path, constants.R_OK | constants.X_OK);
    } catch {
      fail("candidate_executable_unavailable");
    }
  }
  const arch = await runChecked(
    run,
    LIPO,
    ["-archs", executablePath],
    "candidate_architecture_unavailable",
    signal,
  );
  const architectures = arch.stdout.trim().split(/\s+/).filter(Boolean);
  if (!architectures.includes(UPDATER_ARCH)) fail("candidate_architecture_mismatch");
  return {
    ...metadata,
    executable,
    architectures,
    bundlePath: resolve(bundlePath),
  };
}

async function verifySignature(
  run: CommandRunner,
  bundlePath: string,
  identifier: string,
  teamId: string,
  signal?: AbortSignal,
): Promise<void> {
  await runChecked(
    run,
    CODESIGN,
    ["--verify", "--strict", "--deep", "--verbose=2", bundlePath],
    "candidate_signature_invalid",
    signal,
  );
  const requirement = `=anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${teamId}"`;
  await runChecked(
    run,
    CODESIGN,
    ["--verify", "--strict", "--deep", "--verbose=2", "-R", requirement, bundlePath],
    "candidate_signature_requirement_failed",
    signal,
  );
  const display = await runChecked(
    run,
    CODESIGN,
    ["--display", "--verbose=4", bundlePath],
    "candidate_signature_metadata_invalid",
    signal,
  );
  const parsed = parseCodesignDisplay(`${display.stdout}\n${display.stderr}`);
  if (parsed.identifier !== identifier || parsed.teamId !== teamId || !parsed.developerId)
    fail("candidate_publisher_mismatch");
}

async function isMachOFile(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await file.read(magic, 0, 4, 0);
    return bytesRead === 4 && MACHO_MAGIC.has(magic.readUInt32BE());
  } finally {
    await file.close();
  }
}

function macOSVersion(value: unknown): readonly [number, number, number] {
  if (typeof value !== "string" || value.length > 32 || !/^\d+(?:\.\d+){0,2}$/.test(value))
    fail("candidate_macos_invalid");
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)) || !parts[0])
    fail("candidate_macos_invalid");
  return [parts[0], parts[1] ?? 0, parts[2] ?? 0];
}

function requiresNewerMacOS(minimum: readonly number[], host: readonly number[]): boolean {
  for (let index = 0; index < 3; index++) {
    const required = minimum[index] ?? 0;
    const available = host[index] ?? 0;
    if (required !== available) return required > available;
  }
  return false;
}

function executableMinimumMacOS(output: string): string {
  const commands = output.split(/^Load command \d+\r?$/m).slice(1);
  if (commands.length !== 1) fail("candidate_macos_invalid");
  const lines = (commands[0] ?? "").split(/\r?\n/).map((line) => line.trim());
  const field = (name: string): string => {
    const values = lines.filter((line) => line.startsWith(`${name} `));
    if (values.length !== 1) fail("candidate_macos_invalid");
    return (values[0] ?? "").slice(name.length).trim();
  };
  const command = field("cmd");
  if (command === "LC_VERSION_MIN_MACOSX") return field("version");
  if (command !== "LC_BUILD_VERSION" || field("platform") !== "MACOS")
    fail("candidate_macos_invalid");
  return field("minos");
}

async function assertMacOSCompatibility(
  run: CommandRunner,
  metadata: BundleMetadata,
  signal?: AbortSignal,
): Promise<void> {
  const checked = (command: string, args: readonly string[]) =>
    runChecked(run, command, args, "candidate_macos_unavailable", signal);
  try {
    const plistResult = await checked(PLUTIL, [
      "-convert",
      "json",
      "-o",
      "-",
      join(metadata.bundlePath, "Contents/Info.plist"),
    ]);
    let plist: unknown;
    try {
      plist = JSON.parse(plistResult.stdout);
    } catch {
      fail("candidate_macos_invalid");
    }
    if (!isRecord(plist)) fail("candidate_macos_invalid");
    const requirements: (readonly [number, number, number])[] = [];
    if ("LSMinimumSystemVersion" in plist)
      requirements.push(macOSVersion(plist.LSMinimumSystemVersion));
    if ("LSMinimumSystemVersionByArchitecture" in plist) {
      const architectures = plist.LSMinimumSystemVersionByArchitecture;
      if (!isRecord(architectures)) fail("candidate_macos_invalid");
      if (UPDATER_ARCH in architectures)
        requirements.push(macOSVersion(architectures[UPDATER_ARCH]));
    }
    const host = macOSVersion(
      (await checked("/usr/bin/sw_vers", ["-productVersion"])).stdout.trim(),
    );
    if (requirements.some((minimum) => requiresNewerMacOS(minimum, host)))
      fail("candidate_macos_incompatible");
    const checkExecutable = async (path: string) => {
      const build = await checked("/usr/bin/vtool", ["-arch", UPDATER_ARCH, "-show-build", path]);
      if (requiresNewerMacOS(macOSVersion(executableMinimumMacOS(build.stdout)), host))
        fail("candidate_macos_incompatible");
    };
    const executable = join(metadata.bundlePath, "Contents/MacOS", metadata.executable);
    await checkExecutable(executable);
    // Bun, required dylibs and the update helper can require a newer host than the launcher.
    await assertPlainBundleTree(metadata.bundlePath, signal, async (path) => {
      if (path !== executable && (await isMachOFile(path))) await checkExecutable(path);
    });
    if (signal?.aborted) fail("candidate_cancelled");
  } catch (error) {
    if (signal?.aborted) fail("candidate_cancelled");
    if (error instanceof ApplicationVerificationError) throw error;
    fail("candidate_macos_unavailable");
  }
}

export class ApplicationVerifier {
  constructor(private readonly run: CommandRunner = runCommand) {}

  async inspect(appBundlePath: string, signal?: AbortSignal): Promise<BundleMetadata> {
    return readMetadata(this.run, appBundlePath, signal);
  }

  async inspectExecutingBuild(
    appBundlePath: string,
    executing: BuildIdentity | undefined,
    signal?: AbortSignal,
  ): Promise<BundleMetadata> {
    const metadata = await this.inspect(appBundlePath, signal);
    if (!executing) fail("executing_identity_unavailable");
    const resource = await readBuildIdentityResource(appBundlePath);
    if (
      !sameBuild(resource, executing) ||
      resource.identifier !== metadata.identifier ||
      resource.version !== metadata.version
    )
      fail("executing_identity_mismatch");
    await this.readPublisher(appBundlePath, signal);
    const verified = await this.inspect(appBundlePath, signal);
    if (JSON.stringify(verified) !== JSON.stringify(metadata)) fail("executing_identity_changed");
    if (!sameBuild(await readBuildIdentityResource(appBundlePath), executing))
      fail("executing_identity_mismatch");
    if (signal?.aborted) fail("candidate_cancelled");
    return verified;
  }

  async readPublisher(appBundlePath: string, signal?: AbortSignal): Promise<PublisherIdentity> {
    const metadata = await readMetadata(this.run, appBundlePath, signal);
    const display = await runChecked(
      this.run,
      CODESIGN,
      ["--display", "--verbose=4", appBundlePath],
      "installed_signature_metadata_invalid",
      signal,
    );
    const parsed = parseCodesignDisplay(`${display.stdout}\n${display.stderr}`);
    if (
      metadata.identifier !== UPDATER_IDENTIFIER ||
      parsed.identifier !== UPDATER_IDENTIFIER ||
      !parsed.developerId ||
      !/^[A-Z0-9]{10}$/.test(parsed.teamId)
    )
      fail("installed_publisher_unavailable");
    await runChecked(
      this.run,
      CODESIGN,
      ["--verify", "--strict", "--deep", "--verbose=2", appBundlePath],
      "installed_signature_invalid",
      signal,
    );
    return { identifier: UPDATER_IDENTIFIER, teamId: parsed.teamId };
  }

  async verifyRetained(
    appBundlePath: string,
    expected: ExpectedCandidate,
    signal?: AbortSignal,
  ): Promise<BundleMetadata> {
    const metadata = await readMetadata(this.run, appBundlePath, signal);
    if (
      metadata.identifier !== expected.publisher.identifier ||
      metadata.version !== expected.version ||
      metadata.hash !== expected.hash
    )
      fail("candidate_selection_mismatch");
    await verifySignature(
      this.run,
      appBundlePath,
      expected.publisher.identifier,
      expected.publisher.teamId,
      signal,
    );
    return metadata;
  }

  async verifyCandidate(
    appBundlePath: string,
    expected: ExpectedCandidate,
    signal?: AbortSignal,
  ): Promise<BundleMetadata> {
    const metadata = await this.verifyRetained(appBundlePath, expected, signal);
    await assertMacOSCompatibility(this.run, metadata, signal);
    return metadata;
  }
}
