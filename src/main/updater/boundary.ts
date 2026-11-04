import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type BuildIdentity, parseBuildIdentity } from "../../shared/build-identity";
import type { ApplySdk } from "./apply";
import {
  extractAdmittedArchive,
  UpdateArchiveError,
  type UpdateArchiveInspection,
} from "./archive";
import { assertStorageBudget } from "./budget";
import {
  discardFrozenCandidate,
  type FrozenCandidate,
  freezePreparedCandidate,
  isHigherStableVersion,
  readPreparedUpdate,
  revalidateFrozenCandidate,
  type SelectedUpdate,
} from "./candidate";
import {
  MAX_COMPRESSED_ARTIFACT_BYTES,
  MAX_EXPANDED_ARCHIVE_BYTES,
  MAX_STAGING_BYTES,
  MAX_WORKER_FILE_BYTES,
  MIN_FREE_SPACE_RESERVE_BYTES,
  PREPARED_UPDATE_FILE,
  UPDATER_CHANNEL,
  UPDATER_FEED_URL,
  UPDATER_IDENTIFIER,
  UPDATER_STABLE_VERSION_PATTERN,
} from "./constants";
import {
  type HandoffAuthority,
  type HandoffSession,
  HandoffSessionImplementation,
} from "./handoff";
import {
  assertStagingCapacity,
  assertUpdateStoragePaths,
  cleanupInterruptedStaging,
  createRunDirectory,
  runOwnedWorker,
} from "./process";
import { type RecoveryRecord, retainPreviousApplication } from "./recovery";
import { captureRegisteredGroup, inspectRegisteredGroup } from "./registered-group";
import { ensurePrivateDirectory, UpdaterStateError } from "./storage";
import {
  type ExpectedNativePlan,
  readLease,
  reconcileTransaction,
  TransactionLease,
  TransactionLeaseError,
  type TransactionReconciliation,
  type UpdateAttempt,
} from "./transaction";
import {
  ApplicationVerificationError,
  ApplicationVerifier,
  type BundleMetadata,
  type PublisherIdentity,
  runCommand,
} from "./verify";
import type { WorkerResult } from "./worker-protocol";

const DEFAULT_DEADLINE_MS = 15 * 60_000;
const DEFAULT_STARTUP_RECONCILE_WAIT_MS = 5_000;
const DEFAULT_STARTUP_RECONCILE_DELAY_MS = 100;
const MAX_HELPER_BYTES = 32 * 1024 * 1024;
const NATIVE_TRANSACTION_FILE = /^\.electrobun-update-([a-f0-9]{32})(?:\.result)?\.json$/;

export type BoundaryErrorCode =
  | "unavailable"
  | "identity"
  | "feed"
  | "worker"
  | "workerTimeout"
  | "cancelled"
  | "version"
  | "selection"
  | "prepared"
  | "archive"
  | "signature"
  | "recovery"
  | "busy"
  | "state";

export class UpdateBoundaryError extends Error {
  readonly code: BoundaryErrorCode;

  constructor(code: BoundaryErrorCode) {
    const messages: Record<BoundaryErrorCode, string> = {
      unavailable: "Update preparation is unavailable in this build.",
      identity: "The installed application identity is not eligible for updates.",
      feed: "The update feed is not the approved stable source.",
      worker: "Update preparation did not complete.",
      workerTimeout: "Update preparation timed out.",
      cancelled: "Update preparation was cancelled.",
      version: "The offered update version is not eligible.",
      selection: "The prepared update does not match the selected release.",
      prepared: "No complete prepared update is available.",
      archive: "The downloaded update archive was rejected.",
      signature: "The downloaded application signature was rejected.",
      recovery: "The previous application could not be retained.",
      busy: "Another update transaction is active.",
      state: "The local update state is unavailable.",
    };
    super(messages[code]);
    this.name = "UpdateBoundaryError";
    this.code = code;
  }
}

export interface PreparationCommand {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface UpdaterBoundaryOptions {
  appBundlePath: string;
  dataDirectory: string;
  channelRoot: string;
  appDataDirectory: string;
  executingBuild?: BuildIdentity;
  home?: string;
  deadlineMs?: number;
  startupReconcileWaitMs?: number;
  startupReconcileDelayMs?: number;
  preparation?: PreparationCommand;
  verifier?: ApplicationVerifier;
  runner?: typeof runCommand;
}

export interface UpdateCheckResult {
  available: boolean;
  version: string | null;
  hash: string | null;
  currentVersion: string;
}

export interface PreparedUpdateAttempt {
  candidate: FrozenCandidate;
  admission: UpdateArchiveInspection;
  metadata: BundleMetadata;
  recovery: RecoveryRecord;
  previous: BundleMetadata;
}

export interface VerifiedCandidate {
  candidate: FrozenCandidate;
  metadata: BundleMetadata;
}

function canonicalAbsolute(value: string): string {
  if (!isAbsolute(value) || value.includes("\0") || resolve(value) !== value)
    throw new UpdateBoundaryError("state");
  return value;
}

function defaultPreparation(appBundlePath: string): PreparationCommand | undefined {
  const command = join(appBundlePath, "Contents/MacOS/bun");
  const script = join(appBundlePath, "Contents/Resources/app/bun/index.js");
  const cwd = join(appBundlePath, "Contents/MacOS");
  return { command, args: [script], cwd };
}

async function digestFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size <= 0 ||
    info.size > MAX_HELPER_BYTES ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new UpdateBoundaryError("identity");
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function resolveLauncherPid(): number {
  const launcher = process.env.ELECTROBUN_LAUNCHER_PID;
  if (typeof launcher === "string" && /^[1-9]\d{0,9}$/.test(launcher)) {
    const parsed = Number(launcher);
    if (Number.isSafeInteger(parsed) && parsed <= 0x7fffffff) return parsed;
  }
  return process.pid;
}

/**
 * Installation is enabled only for the signed macOS arm64 stable path that the
 * support probe admits. Package signing and the private two-version acceptance
 * remain a separate gate before publication.
 */
export const INSTALLATION_ENABLED = true;

/**
 * Owns the application-side trust boundary between the pinned SDK preparation
 * and native replacement, including the checked handoff journal.
 */
export class UpdaterSafetyBoundary {
  private readonly appBundlePath: string;
  private readonly dataDirectory: string;
  private readonly channelRoot: string;
  private readonly home: string;
  private readonly deadlineMs: number;
  private readonly preparation: PreparationCommand | undefined;
  private readonly verifier: ApplicationVerifier;
  private controller: AbortController | undefined;
  private lease: TransactionLease | undefined;
  private activeOperation: Promise<unknown> | undefined;
  private reconciliation: Promise<TransactionReconciliation> | undefined;
  private readonly executingBuild: BuildIdentity | undefined;
  private abandonment: Promise<void> | undefined;
  private handoffAuthority: HandoffAuthority | undefined;
  private readonly startupReconcileWaitMs: number;
  private readonly startupReconcileDelayMs: number;

  constructor(options: UpdaterBoundaryOptions) {
    this.appBundlePath = canonicalAbsolute(options.appBundlePath);
    this.executingBuild = options.executingBuild
      ? parseBuildIdentity(options.executingBuild)
      : undefined;
    this.dataDirectory = canonicalAbsolute(options.dataDirectory);
    this.channelRoot = canonicalAbsolute(options.channelRoot);
    this.home = canonicalAbsolute(options.home ?? homedir());
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.startupReconcileWaitMs =
      options.startupReconcileWaitMs ?? DEFAULT_STARTUP_RECONCILE_WAIT_MS;
    this.startupReconcileDelayMs =
      options.startupReconcileDelayMs ?? DEFAULT_STARTUP_RECONCILE_DELAY_MS;
    this.preparation = options.preparation ?? defaultPreparation(this.appBundlePath);
    this.verifier = options.verifier ?? new ApplicationVerifier(options.runner ?? runCommand);
    const expectedRoot = resolve(
      join(canonicalAbsolute(options.appDataDirectory), UPDATER_IDENTIFIER, UPDATER_CHANNEL),
    );
    if (this.channelRoot !== expectedRoot) throw new UpdateBoundaryError("identity");
  }

  get installationEnabled(): boolean {
    return INSTALLATION_ENABLED;
  }

  async inspectInstalled(
    signal?: AbortSignal,
  ): Promise<{ metadata: BundleMetadata; publisher: PublisherIdentity }> {
    try {
      const metadata = await this.verifier.inspect(this.appBundlePath, signal);
      if (signal?.aborted) throw new UpdateBoundaryError("cancelled");
      if (
        metadata.identifier !== UPDATER_IDENTIFIER ||
        metadata.channel !== UPDATER_CHANNEL ||
        metadata.baseUrl.length === 0
      )
        throw new UpdateBoundaryError("identity");
      const publisher = await this.verifier.readPublisher(this.appBundlePath, signal);
      if (signal?.aborted) throw new UpdateBoundaryError("cancelled");
      return { metadata, publisher };
    } catch (error) {
      if (signal?.aborted || error instanceof UpdateBoundaryError) {
        if (signal?.aborted) throw new UpdateBoundaryError("cancelled");
        throw error;
      }
      throw new UpdateBoundaryError("signature");
    }
  }

  private assertActive(controller: AbortController): void {
    if (controller.signal.aborted) throw new UpdateBoundaryError("cancelled");
  }

  private workerGrant(lease: TransactionLease, resultPath: string, signal: AbortSignal) {
    return {
      requireGrant: true as const,
      onRegistered: async (pid: number, registrationSignal?: AbortSignal): Promise<void> => {
        if (!this.preparation) throw new UpdateBoundaryError("unavailable");
        const record = await captureRegisteredGroup({
          leaderPid: pid,
          helperPath: this.preparation.command,
          planPath: resultPath,
          signal: registrationSignal,
        });
        if (signal.aborted) throw new UpdateBoundaryError("cancelled");
        lease.registerWorkerGroupSync(record);
      },
      onGranted: (): void => lease.markWorkerGrantedSync(),
      onSettled: async (): Promise<void> => {
        const group = lease.snapshot().registered_group;
        if (!group) return;
        // Settlement uses its own bounded inspection lifetime, not the possibly
        // aborted work signal, so required cleanup is never skipped.
        const state = await inspectRegisteredGroup(group);
        if (state.status === "absent") lease.clearWorkerGroupSync();
      },
    };
  }

  cancel(): void {
    this.controller?.abort();
  }

  private async pruneSdkArchiveCache(signal?: AbortSignal): Promise<void> {
    const staging = join(this.channelRoot, "self-extraction");
    await assertUpdateStoragePaths({
      channelRoot: this.channelRoot,
      dataDirectory: this.dataDirectory,
    });
    for (const name of await readdir(staging).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return [];
    })) {
      if (signal?.aborted) throw new UpdateBoundaryError("cancelled");
      const removable =
        name === PREPARED_UPDATE_FILE ||
        /\.tar(?:\.previous)?$/.test(name) ||
        /\.tar\.zst(?:\.partial)?$/.test(name) ||
        /\.patch(?:\.partial)?$/.test(name);
      if (!removable) continue;
      const path = join(staging, name);
      const info = await lstat(path).catch(() => undefined);
      if (!info || info.isSymbolicLink() || !info.isFile()) continue;
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) continue;
      await rm(path, { force: true });
    }
    await assertStorageBudget({
      channelRoot: this.channelRoot,
      dataDirectory: this.dataDirectory,
      appBundlePath: this.appBundlePath,
      ...(signal ? { signal } : {}),
    });
  }

  private async acquireLease(controller: AbortController): Promise<TransactionLease> {
    if (controller.signal.aborted) throw new UpdateBoundaryError("cancelled");
    let lease: TransactionLease;
    try {
      await assertUpdateStoragePaths({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
      });
      lease = await TransactionLease.acquire({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
        appBundlePath: this.appBundlePath,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new UpdateBoundaryError("cancelled");
      if (error instanceof TransactionLeaseError)
        throw new UpdateBoundaryError(error.code === "busy" ? "busy" : "state");
      throw new UpdateBoundaryError("state");
    }
    if (controller.signal.aborted) {
      await lease.releaseUncommitted();
      throw new UpdateBoundaryError("cancelled");
    }
    this.lease = lease;
    return lease;
  }

  private runOperation<T>(
    work: (signal: AbortSignal, controller: AbortController) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.activeOperation || this.abandonment)
      return Promise.reject(new UpdateBoundaryError("busy"));
    const controller = new AbortController();
    this.controller = controller;
    const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const operation = Promise.resolve()
      .then(() => work(combined, controller))
      .finally(() => {
        if (this.controller === controller) this.controller = undefined;
        if (this.activeOperation === operation) this.activeOperation = undefined;
      });
    this.activeOperation = operation;
    return operation;
  }

  checkForUpdate(): Promise<UpdateCheckResult> {
    return this.runOperation((_signal, controller) => this.performCheck(controller));
  }

  private async performCheck(controller: AbortController): Promise<UpdateCheckResult> {
    if (!this.preparation) throw new UpdateBoundaryError("unavailable");
    const lease = await this.acquireLease(controller);
    let runDirectory: string | undefined;
    try {
      const installed = await this.inspectInstalled(controller.signal);
      this.assertActive(controller);
      if (installed.metadata.baseUrl !== UPDATER_FEED_URL) throw new UpdateBoundaryError("feed");
      const worker = await lstat(this.preparation.command).catch(() => undefined);
      this.assertActive(controller);
      if (!worker || worker.isSymbolicLink() || !worker.isFile())
        throw new UpdateBoundaryError("unavailable");
      await ensurePrivateDirectory(join(this.dataDirectory, "updates"));
      this.assertActive(controller);
      runDirectory = await createRunDirectory(this.dataDirectory);
      const workerTemp = join(runDirectory, "tmp");
      await mkdir(workerTemp, { recursive: true, mode: 0o700 });
      const resultPath = join(runDirectory, "worker-result.json");
      await cleanupInterruptedStaging({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
        activeRunDirectory: runDirectory,
      });
      await assertStagingCapacity(
        this.channelRoot,
        MAX_STAGING_BYTES + MIN_FREE_SPACE_RESERVE_BYTES,
      );
      this.assertActive(controller);
      const outcome = await runOwnedWorker({
        command: this.preparation.command,
        args: this.preparation.args,
        cwd: this.preparation.cwd,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: this.home,
          TMPDIR: workerTemp,
          ...this.preparation.env,
          MCP_GATEWAY_UPDATE_CHANNEL_ROOT: this.channelRoot,
          MCP_GATEWAY_UPDATE_GRANT: "1",
          MCP_GATEWAY_UPDATE_WORKER: "check",
          MCP_GATEWAY_UPDATE_RESULT: resultPath,
        },
        deadlineMs: this.deadlineMs,
        resultPath,
        signal: controller.signal,
        fileSizeLimitBytes: MAX_WORKER_FILE_BYTES,
        ...this.workerGrant(lease, resultPath, controller.signal),
      });
      this.assertActive(controller);
      if (outcome.status === "cancelled") throw new UpdateBoundaryError("cancelled");
      if (outcome.status === "timeout") throw new UpdateBoundaryError("workerTimeout");
      if (outcome.status !== "completed" || !outcome.result)
        throw new UpdateBoundaryError("worker");
      if (outcome.result.status === "no-update")
        return {
          available: false,
          version: null,
          hash: null,
          currentVersion: installed.metadata.version,
        };
      if (outcome.result.status !== "available") throw new UpdateBoundaryError("worker");
      const selection = this.validateWorkerSelection(outcome.result);
      if (!isHigherStableVersion(installed.metadata.version, selection.version))
        throw new UpdateBoundaryError("version");
      return {
        available: true,
        version: selection.version,
        hash: selection.hash,
        currentVersion: installed.metadata.version,
      };
    } catch (error) {
      if (controller.signal.aborted) throw new UpdateBoundaryError("cancelled");
      if (error instanceof UpdateBoundaryError) throw error;
      if (error instanceof UpdaterStateError) throw new UpdateBoundaryError("state");
      throw new UpdateBoundaryError("worker");
    } finally {
      await lease.assertWorkerSettled();
      if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
      await cleanupInterruptedStaging({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
      });
      await lease.releaseUncommitted();
      if (this.lease === lease) this.lease = undefined;
    }
  }

  prepareUpdateAttempt(): Promise<PreparedUpdateAttempt> {
    return this.runOperation((_signal, controller) => this.performPreparation(controller));
  }

  private async performPreparation(controller: AbortController): Promise<PreparedUpdateAttempt> {
    if (!this.preparation) throw new UpdateBoundaryError("unavailable");
    const lease = await this.acquireLease(controller);
    let runDirectory: string | undefined;
    let selected: SelectedUpdate | undefined;
    let retainLease = false;
    try {
      const installed = await this.inspectInstalled(controller.signal);
      this.assertActive(controller);
      if (installed.metadata.baseUrl !== UPDATER_FEED_URL) throw new UpdateBoundaryError("feed");
      const worker = await lstat(this.preparation.command).catch(() => undefined);
      this.assertActive(controller);
      if (!worker || worker.isSymbolicLink() || !worker.isFile())
        throw new UpdateBoundaryError("unavailable");
      await ensurePrivateDirectory(join(this.dataDirectory, "updates"));
      this.assertActive(controller);
      runDirectory = await createRunDirectory(this.dataDirectory);
      const workerTemp = join(runDirectory, "tmp");
      await mkdir(workerTemp, { recursive: true, mode: 0o700 });
      const resultPath = join(runDirectory, "worker-result.json");
      await cleanupInterruptedStaging({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
        activeRunDirectory: runDirectory,
      });
      await assertStagingCapacity(
        this.channelRoot,
        MAX_STAGING_BYTES + MIN_FREE_SPACE_RESERVE_BYTES,
      );
      await this.pruneSdkArchiveCache(controller.signal);
      this.assertActive(controller);
      const outcome = await runOwnedWorker({
        command: this.preparation.command,
        args: this.preparation.args,
        cwd: this.preparation.cwd,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          HOME: this.home,
          TMPDIR: workerTemp,
          ...this.preparation.env,
          MCP_GATEWAY_UPDATE_CHANNEL_ROOT: this.channelRoot,
          MCP_GATEWAY_UPDATE_GRANT: "1",
          MCP_GATEWAY_UPDATE_MAX_COMPRESSED_BYTES: String(MAX_COMPRESSED_ARTIFACT_BYTES),
          MCP_GATEWAY_UPDATE_MAX_EXPANDED_BYTES: String(MAX_EXPANDED_ARCHIVE_BYTES),
          MCP_GATEWAY_UPDATE_WORKER: "prepare",
          MCP_GATEWAY_UPDATE_RESULT: resultPath,
        },
        deadlineMs: this.deadlineMs,
        resultPath,
        signal: controller.signal,
        fileSizeLimitBytes: MAX_WORKER_FILE_BYTES,
        ...this.workerGrant(lease, resultPath, controller.signal),
      });
      this.assertActive(controller);
      if (outcome.status === "cancelled") throw new UpdateBoundaryError("cancelled");
      if (outcome.status === "timeout") throw new UpdateBoundaryError("workerTimeout");
      if (outcome.status !== "completed" || !outcome.result)
        throw new UpdateBoundaryError("worker");
      const selection = this.validateWorkerSelection(outcome.result);
      selected = selection;
      if (!isHigherStableVersion(installed.metadata.version, selection.version))
        throw new UpdateBoundaryError("version");
      await assertStorageBudget({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
        appBundlePath: this.appBundlePath,
        signal: controller.signal,
      });
      const prepared = await readPreparedUpdate(this.channelRoot).catch(() => undefined);
      this.assertActive(controller);
      if (!prepared || prepared.version !== selection.version || prepared.hash !== selection.hash)
        throw new UpdateBoundaryError("selection");
      const frozen = await freezePreparedCandidate({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
        selected: selection,
        signal: controller.signal,
      });
      this.assertActive(controller);
      await assertStorageBudget({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
        appBundlePath: this.appBundlePath,
        signal: controller.signal,
      });
      const extractedRoot = join(runDirectory, "extracted");
      let metadata: BundleMetadata;
      try {
        const bundle = await extractAdmittedArchive(
          frozen.admission,
          extractedRoot,
          controller.signal,
        );
        this.assertActive(controller);
        metadata = await this.verifier.verifyCandidate(
          bundle,
          {
            publisher: installed.publisher,
            version: selection.version,
            hash: selection.hash,
          },
          controller.signal,
        );
        this.assertActive(controller);
        await assertStorageBudget({
          channelRoot: this.channelRoot,
          dataDirectory: this.dataDirectory,
          appBundlePath: this.appBundlePath,
          extractedRoot,
          signal: controller.signal,
        });
        if (metadata.channel !== UPDATER_CHANNEL) throw new UpdateBoundaryError("identity");
      } catch (error) {
        await discardFrozenCandidate(this.channelRoot, this.dataDirectory, selection);
        if (controller.signal.aborted) throw new UpdateBoundaryError("cancelled");
        if (error instanceof ApplicationVerificationError)
          throw new UpdateBoundaryError("signature");
        throw error;
      } finally {
        await rm(extractedRoot, { recursive: true, force: true });
      }
      this.assertActive(controller);
      const recovery = await retainPreviousApplication({
        appBundlePath: this.appBundlePath,
        dataDirectory: this.dataDirectory,
        publisher: installed.publisher,
        version: installed.metadata.version,
        hash: installed.metadata.hash,
        verifier: this.verifier,
        signal: controller.signal,
      }).catch(() => {
        throw new UpdateBoundaryError("recovery");
      });
      this.assertActive(controller);
      await assertStorageBudget({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
        appBundlePath: this.appBundlePath,
        signal: controller.signal,
      });
      await lease.markPrepared(frozen.candidate, recovery.retained_bundle_path, controller.signal);
      this.assertActive(controller);
      retainLease = true;
      return {
        candidate: frozen.candidate,
        admission: frozen.admission,
        metadata,
        recovery,
        previous: installed.metadata,
      };
    } catch (error) {
      await lease.assertWorkerSettled();
      await lease.discardPrepared();
      if (controller.signal.aborted) {
        if (selected) await discardFrozenCandidate(this.channelRoot, this.dataDirectory, selected);
        throw new UpdateBoundaryError("cancelled");
      }
      if (error instanceof TransactionLeaseError)
        throw new UpdateBoundaryError(error.code === "busy" ? "busy" : "state");
      if (error instanceof UpdateBoundaryError) throw error;
      if (error instanceof UpdaterStateError) throw new UpdateBoundaryError("state");
      if (error instanceof UpdateArchiveError) throw new UpdateBoundaryError("archive");
      if (error instanceof ApplicationVerificationError)
        throw new UpdateBoundaryError(
          error.code.startsWith("installed") ? "identity" : "signature",
        );
      throw new UpdateBoundaryError("worker");
    } finally {
      await lease.assertWorkerSettled();
      if (runDirectory) await rm(runDirectory, { recursive: true, force: true });
      await cleanupInterruptedStaging({
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
      });
      if (!retainLease) {
        await lease.releaseUncommitted();
        if (this.lease === lease) this.lease = undefined;
      }
    }
  }

  setHandoffAuthority(authority: HandoffAuthority): void {
    this.handoffAuthority = authority;
  }

  prepareHandoff(attempt: UpdateAttempt, sdk: ApplySdk): Promise<HandoffSession> {
    return this.runOperation(
      (signal) => this.performHandoff({ ...attempt, signal }, sdk),
      attempt.signal,
    );
  }

  private async performHandoff(attempt: UpdateAttempt, sdk: ApplySdk): Promise<HandoffSession> {
    if (attempt.signal.aborted) throw new UpdateBoundaryError("cancelled");
    const lease = this.lease ?? (await this.readOwnedLease());
    const verified = await this.performRevalidation(attempt.candidate, attempt.signal);
    if (attempt.signal.aborted) throw new UpdateBoundaryError("cancelled");
    const info = await sdk.getLocalInfo(verified, this.channelRoot);
    if (attempt.signal.aborted) throw new UpdateBoundaryError("cancelled");
    if (
      info.identifier !== UPDATER_IDENTIFIER ||
      info.channel !== UPDATER_CHANNEL ||
      info.baseUrl !== UPDATER_FEED_URL ||
      info.version !== verified.metadata.version ||
      info.hash !== verified.metadata.hash
    )
      throw new UpdateBoundaryError("identity");
    const root = resolve(await sdk.appDataFolder());
    if (root !== this.channelRoot) throw new UpdateBoundaryError("identity");
    const physicalTemporaryDirectory = await realpath(tmpdir());
    const temporaryInfo = await lstat(physicalTemporaryDirectory);
    if (
      temporaryInfo.isSymbolicLink() ||
      !temporaryInfo.isDirectory() ||
      (typeof process.getuid === "function" && temporaryInfo.uid !== process.getuid())
    )
      throw new UpdateBoundaryError("state");
    const bundledHelper = join(this.appBundlePath, "Contents/Resources/uninstall");
    const cachedHelper = join(this.channelRoot, "uninstall");
    const cached = await lstat(cachedHelper).catch(() => undefined);
    let helperPath = bundledHelper;
    if (cached) {
      if (cached.isSymbolicLink() || !cached.isFile()) throw new UpdateBoundaryError("state");
      if ((await digestFile(cachedHelper)) !== (await digestFile(bundledHelper)))
        throw new UpdateBoundaryError("identity");
      helperPath = cachedHelper;
    } else {
      const bundled = await lstat(bundledHelper).catch(() => undefined);
      if (!bundled || bundled.isSymbolicLink() || !bundled.isFile())
        throw new UpdateBoundaryError("identity");
    }
    const helperInfo = await lstat(helperPath);
    if (
      helperInfo.isSymbolicLink() ||
      !helperInfo.isFile() ||
      (typeof process.getuid === "function" && helperInfo.uid !== process.getuid())
    )
      throw new UpdateBoundaryError("state");
    const existingNativeIds = await this.scanNativeIds();
    const expected: ExpectedNativePlan = {
      identifier: UPDATER_IDENTIFIER,
      channel: UPDATER_CHANNEL,
      platform: "macos" as const,
      arch: "arm64" as const,
      version: attempt.candidate.version,
      hash: attempt.candidate.hash,
      channelRoot: this.channelRoot,
      appBundlePath: this.appBundlePath,
      retainedTarPath: attempt.candidate.retained_tar_path,
      parentPid: resolveLauncherPid(),
      physicalTemporaryDirectory,
    };
    await lease.prepareHandoff(attempt, expected, existingNativeIds);
    if (!this.handoffAuthority) throw new UpdateBoundaryError("state");
    this.lease = lease;
    return new HandoffSessionImplementation(
      lease,
      attempt,
      expected,
      randomBytes(16).toString("hex"),
      this.handoffAuthority,
    );
  }

  private async scanNativeIds(): Promise<readonly string[]> {
    const ids = new Set<string>();
    for (const name of await readdir(this.channelRoot).catch(() => [])) {
      const match = NATIVE_TRANSACTION_FILE.exec(name);
      if (match?.[1]) ids.add(match[1]);
      if (ids.size > 256) throw new UpdateBoundaryError("state");
    }
    return Object.freeze([...ids].sort());
  }

  revalidate(candidate: FrozenCandidate, signal?: AbortSignal): Promise<VerifiedCandidate> {
    return this.runOperation(
      (activeSignal) => this.performRevalidation(candidate, activeSignal),
      signal,
    );
  }

  private async performRevalidation(
    candidate: FrozenCandidate,
    signal?: AbortSignal,
  ): Promise<VerifiedCandidate> {
    if (signal?.aborted) throw new UpdateBoundaryError("cancelled");
    const lease = this.lease ?? (await this.readOwnedLease());
    lease.assertCandidate(candidate);
    const phase = lease.snapshot().phase;
    if (phase !== "prepared" && phase !== "preflight") throw new UpdateBoundaryError("prepared");
    const installed = await this.inspectInstalled(signal);
    const frozen = await revalidateFrozenCandidate(
      this.channelRoot,
      this.dataDirectory,
      { version: candidate.version, hash: candidate.hash },
      candidate,
      signal,
    ).catch((error) => {
      if (signal?.aborted || (error instanceof UpdaterStateError && error.code === "cancelled"))
        throw new UpdateBoundaryError("cancelled");
      throw new UpdateBoundaryError("prepared");
    });
    lease.assertCandidate(frozen);
    return { candidate: frozen, metadata: installed.metadata };
  }

  abandonPrepared(): Promise<void> {
    if (this.abandonment) return this.abandonment;
    this.cancel();
    const active = this.activeOperation;
    const operation = this.retireAfterOperation(active).finally(() => {
      if (this.abandonment === operation) this.abandonment = undefined;
    });
    this.abandonment = operation;
    return operation;
  }

  private async retireAfterOperation(active: Promise<unknown> | undefined): Promise<void> {
    if (active) {
      try {
        await active;
      } catch (error) {
        // Expected operation refusal is distinct from unresolved finally cleanup.
        if (!(error instanceof UpdateBoundaryError)) throw error;
      }
    }
    const lease = this.lease;
    if (!lease || lease.committed) return;
    await lease.ensureGuard();
    await lease.discardPrepared();
    await lease.releaseUncommitted();
    if (this.lease === lease) this.lease = undefined;
  }

  reconcile(): Promise<TransactionReconciliation> {
    if (this.reconciliation) return this.reconciliation;
    const operation = this.runOperation((signal) => this.performReconciliation(signal)).finally(
      () => {
        if (this.reconciliation === operation) this.reconciliation = undefined;
      },
    );
    this.reconciliation = operation;
    return operation;
  }

  private async performReconciliation(signal: AbortSignal): Promise<TransactionReconciliation> {
    try {
      signal.throwIfAborted();
      const options = {
        channelRoot: this.channelRoot,
        dataDirectory: this.dataDirectory,
        signal,
        inspectRunning: async () => {
          const installed = await this.verifier
            .inspectExecutingBuild(this.appBundlePath, this.executingBuild, signal)
            .catch(() => undefined);
          signal.throwIfAborted();
          return installed
            ? {
                version: installed.version,
                hash: installed.hash,
                appBundlePath: this.appBundlePath,
              }
            : undefined;
        },
      };
      const deadline = Date.now() + this.startupReconcileWaitMs;
      let outcome = await reconcileTransaction(options);
      while (outcome.status === "recovery-required" && Date.now() < deadline) {
        signal.throwIfAborted();
        const journal = await readLease(this.channelRoot).catch(() => undefined);
        if (journal?.phase !== "handed-off") break;
        await delay(
          Math.min(this.startupReconcileDelayMs, Math.max(1, deadline - Date.now())),
          undefined,
          { signal },
        );
        outcome = await reconcileTransaction(options);
      }
      signal.throwIfAborted();
      return outcome;
    } catch (error) {
      if (signal.aborted) throw new UpdateBoundaryError("cancelled");
      throw error;
    }
  }

  private async readOwnedLease(): Promise<TransactionLease> {
    const lease = await readLease(this.channelRoot).catch(() => undefined);
    if (!lease || lease.owner_pid !== process.pid) throw new UpdateBoundaryError("state");
    const owned = new TransactionLease(this.channelRoot, this.dataDirectory, lease);
    this.lease = owned;
    return owned;
  }

  private validateWorkerSelection(result: WorkerResult): { version: string; hash: string } {
    if (result.status !== "ready" && result.status !== "available")
      throw new UpdateBoundaryError("worker");
    if (resolve(result.channelRoot) !== this.channelRoot)
      throw new UpdateBoundaryError("selection");
    const prepared = result.selected;
    if (
      typeof prepared.version !== "string" ||
      typeof prepared.hash !== "string" ||
      !UPDATER_STABLE_VERSION_PATTERN.test(prepared.version) ||
      !/^[a-z0-9]{1,13}$/.test(prepared.hash)
    )
      throw new UpdateBoundaryError("selection");
    return { version: prepared.version, hash: prepared.hash };
  }
}
