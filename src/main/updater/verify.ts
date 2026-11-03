import { spawn } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  isSafeRelativeComponent,
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
const COMMAND_OUTPUT_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;
const CODESIGN = "/usr/bin/codesign";
const LIPO = "/usr/bin/lipo";
const PLUTIL = "/usr/bin/plutil";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<CommandResult>;

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

export interface VerificationChild {
  readonly pid?: number;
  readonly stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  readonly stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  kill(signal: "SIGKILL"): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
}

export function createCommandRunner(
  start: (command: string, args: readonly string[]) => VerificationChild = (command, args) =>
    spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }),
): CommandRunner {
  return (command, args, timeoutMs = COMMAND_TIMEOUT_MS, signal) =>
    new Promise((resolvePromise, reject) => {
      if (signal?.aborted) {
        reject(new Error("Verification command cancelled"));
        return;
      }
      const child = start(command, args);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let termination: Error | undefined;
      let abortHandler: (() => void) | undefined;
      const finish = (result: CommandResult | Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abortHandler) signal?.removeEventListener("abort", abortHandler);
        if (result instanceof Error) reject(result);
        else resolvePromise(result);
      };
      const terminate = (error: Error) => {
        if (settled || termination) return;
        termination = error;
        try {
          child.kill("SIGKILL");
        } catch (failure) {
          termination =
            failure instanceof Error
              ? failure
              : new Error("Verification command termination failed");
        }
        // Ownership stays unsettled until close, even if termination is unconfirmed.
      };
      const timer = setTimeout(
        () => terminate(new Error("Verification command timed out")),
        timeoutMs,
      );
      abortHandler = () => terminate(new Error("Verification command cancelled"));
      signal?.addEventListener("abort", abortHandler, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= COMMAND_OUTPUT_BYTES) stdout.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= COMMAND_OUTPUT_BYTES) stderr.push(chunk);
      });
      child.on("error", (error) => {
        if (child.pid === undefined) finish(error);
        else termination ??= error;
      });
      if (signal?.aborted) terminate(new Error("Verification command cancelled"));
      child.on("close", (code) => {
        if (termination) {
          finish(termination);
          return;
        }
        if (stdoutBytes > COMMAND_OUTPUT_BYTES || stderrBytes > COMMAND_OUTPUT_BYTES) {
          finish(new Error("Verification command output exceeded the limit"));
          return;
        }
        finish({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: code ?? -1,
        });
      });
    });
}

export const runCommand = createCommandRunner();

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

async function assertPlainBundleTree(bundlePath: string, signal?: AbortSignal): Promise<void> {
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
  const executableInfo = await lstat(executablePath);
  if (executableInfo.isSymbolicLink() || !executableInfo.isFile())
    fail("candidate_executable_invalid");
  const uninstallInfo = await lstat(join(bundlePath, "Contents/Resources/uninstall"));
  if (uninstallInfo.isSymbolicLink() || !uninstallInfo.isFile()) fail("candidate_manager_invalid");
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

export class ApplicationVerifier {
  constructor(private readonly run: CommandRunner = runCommand) {}

  async inspect(appBundlePath: string, signal?: AbortSignal): Promise<BundleMetadata> {
    return readMetadata(this.run, appBundlePath, signal);
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

  async verifyCandidate(
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

  async verifyRetained(
    appBundlePath: string,
    expected: ExpectedCandidate,
    signal?: AbortSignal,
  ): Promise<BundleMetadata> {
    return this.verifyCandidate(appBundlePath, expected, signal);
  }
}
