import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { lstat, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { FrozenCandidate } from "./candidate";
import { discardFrozenCandidate } from "./candidate";
import {
  UPDATER_ARCH,
  UPDATER_CHANNEL,
  UPDATER_HASH_PATTERN,
  UPDATER_IDENTIFIER,
  UPDATER_PLATFORM,
  UPDATER_STABLE_VERSION_PATTERN,
} from "./constants";
import { acquireKernelGuard, KERNEL_GUARD_FILE, type KernelGuard } from "./kernel-guard";
import { cleanupInterruptedStaging } from "./process";
import { type ExactHelperInspection, inspectExactHelper } from "./process-inspector";
import {
  inspectRegisteredGroup,
  isRegisteredGroup,
  type RegisteredGroup,
} from "./registered-group";
import {
  atomicWritePrivateJson,
  atomicWritePrivateJsonSync,
  readNativeJsonSync,
  readPrivateJson,
  readPrivateJsonSync,
  syncDirectory,
  UpdaterStateError,
} from "./storage";

const LEASE_DIRECTORY = ".mcp-gateway-update-transaction";
const LEASE_FILE = "lease.json";
const NATIVE_ID_PATTERN = /^[a-f0-9]{32}$/;
const NATIVE_FILE_PATTERN = /^\.electrobun-update-([a-f0-9]{32})(?:\.result)?\.json$/;
const MAX_NATIVE_IDS = 256;
const MAX_TEXT_LENGTH = 4096;
const RESULT_FIELDS = [
  "channel",
  "hash",
  "identifier",
  "message",
  "phase",
  "schema_version",
  "success",
  "transaction_id",
  "version",
];
const JOURNAL_FIELDS = [
  "app_bundle_path",
  "attempt_id",
  "binding",
  "candidate",
  "created_at",
  "existing_native_ids",
  "expected_native",
  "lease_id",
  "owner_pid",
  "phase",
  "registered_group",
  "schema_version",
  "updated_at",
  "worker_granted",
];
const CANDIDATE_FIELDS = [
  "archive_bytes",
  "archive_sha256",
  "hash",
  "prepared_path",
  "prepared_sha256",
  "recovery_path",
  "retained_tar_path",
  "version",
];
const EXPECTED_PLAN_FIELDS = [
  "appBundlePath",
  "arch",
  "channel",
  "channelRoot",
  "hash",
  "identifier",
  "parentPid",
  "physicalTemporaryDirectory",
  "platform",
  "retainedTarPath",
  "version",
];
const OBSERVED_BINDING_FIELDS = [
  "evidence",
  "helperPath",
  "plan",
  "planPath",
  "resultPath",
  "transactionId",
];
const EARLY_BINDING_FIELDS = ["evidence", "helperPath", "resultPath", "transactionId"];

export type JournalPhase = "operation" | "prepared" | "preflight" | "arming" | "handed-off";

export type TransactionCandidate = Readonly<{
  version: string;
  hash: string;
  prepared_path: string;
  prepared_sha256: string;
  retained_tar_path: string;
  archive_sha256: string;
  archive_bytes: number;
  recovery_path: string | null;
}>;

/**
 * The deterministic inputs that must be established before SDK approval. The
 * physical temporary directory is the resolved SDK launcher location; it is not
 * a field of the native plan document.
 */
export type ExpectedNativePlan = Readonly<{
  identifier: string;
  channel: "stable";
  platform: "macos";
  arch: "arm64";
  version: string;
  hash: string;
  channelRoot: string;
  appBundlePath: string;
  retainedTarPath: string;
  parentPid: number;
  physicalTemporaryDirectory: string;
}>;

export type ObservedPlanBinding = Readonly<{
  evidence: "observed-plan";
  transactionId: string;
  planPath: string;
  resultPath: string;
  helperPath: string;
  plan: ExpectedNativePlan;
}>;

/**
 * A terminal failure result can outlive a removed plan. This variant binds the
 * unique transaction ID and exact result/helper paths without claiming that the
 * missing plan fields, parent PID, or platform were observed.
 */
export type EarlyTerminalResultBinding = Readonly<{
  evidence: "early-terminal-result";
  transactionId: string;
  resultPath: string;
  helperPath: string;
}>;

export type NativeBinding = ObservedPlanBinding | EarlyTerminalResultBinding;

/** Durable embargo record. It is not released by closing the kernel guard. */
export interface UpdateTransactionLease {
  readonly schema_version: 1;
  readonly lease_id: string;
  readonly phase: JournalPhase;
  readonly created_at: string;
  readonly updated_at: string;
  readonly owner_pid: number;
  readonly app_bundle_path: string;
  readonly attempt_id: number | null;
  readonly candidate: TransactionCandidate | null;
  readonly expected_native: ExpectedNativePlan | null;
  readonly existing_native_ids: readonly string[];
  readonly binding: NativeBinding | null;
  readonly registered_group: RegisteredGroup | null;
  readonly worker_granted: boolean;
}

export type UpdateAttempt = Readonly<{
  id: number;
  candidate: Readonly<FrozenCandidate>;
  signal: AbortSignal;
}>;

export type JournalIdentity = Readonly<{
  nonce: string;
  attemptId: number;
}>;

export type PreparedHandoff = Readonly<{
  identity: JournalIdentity;
  expected: ExpectedNativePlan;
  existingNativeIds: readonly string[];
  candidate: TransactionCandidate;
}>;

export type UnarmedReason = "validation-refused" | "vetoed" | "cancelled" | "preapproval-error";

/**
 * Issued only after the current arming record and SDK invocation facts agree
 * that no helper was armed. The private registry prevents a structural literal
 * or boolean from bypassing the commitment check.
 */
export interface UnarmedEvidence {
  readonly kind: "unarmed";
  readonly reason: UnarmedReason;
  readonly nonce: string;
  readonly attemptId: number;
  readonly approvalOffered: boolean;
  readonly applyingObserved: false;
  readonly bindingObserved: false;
}

export interface ReconciledCompletionProof {
  readonly kind: "reconciled-completion";
  readonly nonce: string;
  readonly attemptId: number;
  readonly transactionId: string;
  readonly resultPath: string;
  readonly helperPath: string;
  readonly planPath: string;
  readonly success: boolean;
  readonly target: Readonly<{ appBundlePath: string; version: string; hash: string }>;
}

export interface RunningApplicationIdentity {
  readonly version: string;
  readonly hash: string;
  readonly appBundlePath: string;
}

export interface TransactionResult {
  readonly schema_version: 1;
  readonly transaction_id: string;
  readonly success: boolean;
  readonly phase: string;
  readonly message: string;
  readonly identifier: string;
  readonly channel: string;
  readonly version: string;
  readonly hash: string;
}

export type ReconciliationStatus =
  | "none"
  | "confirmed"
  | "failed"
  | "unconfirmed"
  | "recovery-required";

export interface TransactionReconciliation {
  status: ReconciliationStatus;
  recoveryPath?: string;
  version?: string;
  hash?: string;
  message?: string;
}

export interface ReconcileTransactionOptions {
  channelRoot: string;
  dataDirectory: string;
  running?: RunningApplicationIdentity;
  inspectRunning?: (signal?: AbortSignal) => Promise<RunningApplicationIdentity | undefined>;
  signal?: AbortSignal;
  inspectHelper?: typeof inspectExactHelper;
  inspectOwner?: (pid: number) => "alive" | "absent" | "unknown";
  inspectGroup?: typeof inspectRegisteredGroup;
}

const unarmedEvidence = new WeakSet<object>();
const reconciledProofs = new WeakSet<object>();

export class TransactionLeaseError extends Error {
  readonly code: "busy" | "state" | "candidate" | "cancelled" | "handoff";

  constructor(code: "busy" | "state" | "candidate" | "cancelled" | "handoff") {
    const messages = {
      busy: "Another update transaction is active.",
      state: "The update transaction state is unavailable or uncertain.",
      candidate: "The update transaction does not match the approved candidate.",
      cancelled: "The update transaction work was cancelled.",
      handoff: "The update handoff is still owned by an active transaction.",
    };
    super(messages[code]);
    this.name = "TransactionLeaseError";
    this.code = code;
  }
}

export function nativePlanPath(channelRoot: string, transactionId: string): string {
  if (!NATIVE_ID_PATTERN.test(transactionId)) throw new TransactionLeaseError("state");
  return join(channelRoot, `.electrobun-update-${transactionId}.json`);
}

export function nativeResultPath(channelRoot: string, transactionId: string): string {
  if (!NATIVE_ID_PATTERN.test(transactionId)) throw new TransactionLeaseError("state");
  return join(channelRoot, `.electrobun-update-${transactionId}.result.json`);
}

export function nativeHelperPath(temporaryDirectory: string, transactionId: string): string {
  if (!NATIVE_ID_PATTERN.test(transactionId)) throw new TransactionLeaseError("state");
  return resolve(join(temporaryDirectory, `electrobun-update-${transactionId}`));
}

function leaseDirectory(channelRoot: string): string {
  return join(channelRoot, LEASE_DIRECTORY);
}

function leasePath(channelRoot: string): string {
  return join(leaseDirectory(channelRoot), LEASE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH)
    throw new TransactionLeaseError("state");
  return value;
}

function canonicalPath(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH ||
    value.includes("\0") ||
    !isAbsolute(value) ||
    resolve(value) !== value
  )
    throw new TransactionLeaseError("state");
  return value;
}

function canonicalTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value)
    throw new TransactionLeaseError("state");
  return value;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record).sort();
  if (keys.length !== expected.length || !expected.every((key, index) => keys[index] === key))
    throw new TransactionLeaseError("state");
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new TransactionLeaseError("state");
  return value as number;
}

function freezeCandidate(candidate: TransactionCandidate): TransactionCandidate {
  return Object.freeze({ ...candidate });
}

function freezeExpectedPlan(plan: ExpectedNativePlan): ExpectedNativePlan {
  return Object.freeze({ ...plan });
}

function freezeBinding(binding: NativeBinding): NativeBinding {
  return binding.evidence === "observed-plan"
    ? Object.freeze({ ...binding, plan: freezeExpectedPlan(binding.plan) })
    : Object.freeze({ ...binding });
}

function freezeJournal(journal: UpdateTransactionLease): UpdateTransactionLease {
  return Object.freeze({
    ...journal,
    candidate: journal.candidate ? freezeCandidate(journal.candidate) : null,
    expected_native: journal.expected_native ? freezeExpectedPlan(journal.expected_native) : null,
    existing_native_ids: Object.freeze([...journal.existing_native_ids]),
    binding: journal.binding ? freezeBinding(journal.binding) : null,
    registered_group: journal.registered_group
      ? Object.freeze({ ...journal.registered_group })
      : null,
  });
}

function parseCandidate(document: unknown): TransactionCandidate {
  if (!isRecord(document)) throw new TransactionLeaseError("state");
  exactKeys(document, CANDIDATE_FIELDS);
  const version = requiredString(document, "version");
  const hash = requiredString(document, "hash");
  const preparedPath = canonicalPath(requiredString(document, "prepared_path"));
  const preparedSha = requiredString(document, "prepared_sha256");
  const retainedPath = canonicalPath(requiredString(document, "retained_tar_path"));
  const archiveSha = requiredString(document, "archive_sha256");
  const bytes = document.archive_bytes;
  const recovery = document.recovery_path;
  if (
    !UPDATER_STABLE_VERSION_PATTERN.test(version) ||
    !UPDATER_HASH_PATTERN.test(hash) ||
    !/^[a-f0-9]{64}$/.test(preparedSha) ||
    !/^[a-f0-9]{64}$/.test(archiveSha) ||
    !Number.isSafeInteger(bytes) ||
    (bytes as number) <= 0 ||
    (recovery !== null && (typeof recovery !== "string" || !recovery.endsWith(".app")))
  )
    throw new TransactionLeaseError("state");
  return {
    version,
    hash,
    prepared_path: preparedPath,
    prepared_sha256: preparedSha,
    retained_tar_path: retainedPath,
    archive_sha256: archiveSha,
    archive_bytes: bytes as number,
    recovery_path: recovery === null ? null : canonicalPath(recovery as string),
  };
}

function parseExpectedPlan(document: unknown): ExpectedNativePlan {
  if (!isRecord(document)) throw new TransactionLeaseError("state");
  exactKeys(document, EXPECTED_PLAN_FIELDS);
  const identifier = requiredString(document, "identifier");
  const channel = requiredString(document, "channel");
  const platform = requiredString(document, "platform");
  const arch = requiredString(document, "arch");
  const version = requiredString(document, "version");
  const hash = requiredString(document, "hash");
  const channelRoot = canonicalPath(requiredString(document, "channelRoot"));
  const appBundlePath = canonicalPath(requiredString(document, "appBundlePath"));
  const retainedTarPath = canonicalPath(requiredString(document, "retainedTarPath"));
  const parentPid = positiveInteger(document.parentPid);
  const physicalTemporaryDirectory = canonicalPath(
    requiredString(document, "physicalTemporaryDirectory"),
  );
  if (
    identifier !== UPDATER_IDENTIFIER ||
    channel !== UPDATER_CHANNEL ||
    platform !== UPDATER_PLATFORM ||
    arch !== UPDATER_ARCH ||
    !UPDATER_STABLE_VERSION_PATTERN.test(version) ||
    !UPDATER_HASH_PATTERN.test(hash)
  )
    throw new TransactionLeaseError("state");
  return {
    identifier,
    channel: UPDATER_CHANNEL,
    platform: UPDATER_PLATFORM,
    arch: UPDATER_ARCH,
    version,
    hash,
    channelRoot,
    appBundlePath,
    retainedTarPath,
    parentPid,
    physicalTemporaryDirectory,
  };
}

function parseBinding(document: unknown): NativeBinding {
  if (!isRecord(document)) throw new TransactionLeaseError("state");
  const evidence = document.evidence;
  if (evidence === "observed-plan") {
    exactKeys(document, OBSERVED_BINDING_FIELDS);
    return {
      evidence,
      transactionId: requiredString(document, "transactionId"),
      planPath: canonicalPath(requiredString(document, "planPath")),
      resultPath: canonicalPath(requiredString(document, "resultPath")),
      helperPath: canonicalPath(requiredString(document, "helperPath")),
      plan: parseExpectedPlan(document.plan),
    };
  }
  if (evidence === "early-terminal-result") {
    exactKeys(document, EARLY_BINDING_FIELDS);
    return {
      evidence,
      transactionId: requiredString(document, "transactionId"),
      resultPath: canonicalPath(requiredString(document, "resultPath")),
      helperPath: canonicalPath(requiredString(document, "helperPath")),
    };
  }
  throw new TransactionLeaseError("state");
}

function parseNativeIds(document: unknown): readonly string[] {
  if (!Array.isArray(document) || document.length > MAX_NATIVE_IDS)
    throw new TransactionLeaseError("state");
  const ids: string[] = [];
  for (const value of document) {
    if (typeof value !== "string" || !NATIVE_ID_PATTERN.test(value) || ids.includes(value))
      throw new TransactionLeaseError("state");
    ids.push(value);
  }
  ids.sort();
  return Object.freeze(ids);
}

const REGISTERED_GROUP_FIELDS = [
  "helper_path",
  "leader_pid",
  "leader_start",
  "pgid",
  "plan_path",
  "schema_version",
  "uid",
];

function parseRegisteredGroup(value: unknown): RegisteredGroup {
  if (!isRecord(value)) throw new TransactionLeaseError("state");
  exactKeys(value, REGISTERED_GROUP_FIELDS);
  if (!isRegisteredGroup(value)) throw new TransactionLeaseError("state");
  return Object.freeze({ ...value });
}

function assertJournalState(journal: UpdateTransactionLease): void {
  const hasAttempt = journal.attempt_id !== null;
  const hasExpected = journal.expected_native !== null;
  const hasCandidate = journal.candidate !== null;
  const hasBinding = journal.binding !== null;
  if (journal.worker_granted && journal.registered_group === null)
    throw new TransactionLeaseError("state");
  switch (journal.phase) {
    case "operation":
      if (hasAttempt || hasExpected || hasCandidate || hasBinding)
        throw new TransactionLeaseError("state");
      return;
    case "prepared":
      if (hasAttempt || hasExpected || !hasCandidate || hasBinding)
        throw new TransactionLeaseError("state");
      return;
    case "preflight":
      if (!hasAttempt || !hasExpected || !hasCandidate || hasBinding)
        throw new TransactionLeaseError("state");
      return;
    case "arming":
      if (
        !hasAttempt ||
        !hasExpected ||
        !hasCandidate ||
        hasBinding ||
        journal.registered_group !== null
      )
        throw new TransactionLeaseError("state");
      return;
    case "handed-off":
      if (
        !hasAttempt ||
        !hasExpected ||
        !hasCandidate ||
        !hasBinding ||
        journal.registered_group !== null
      )
        throw new TransactionLeaseError("state");
      return;
  }
}

function parseJournal(document: unknown): UpdateTransactionLease {
  if (!isRecord(document) || document.schema_version !== 1)
    throw new TransactionLeaseError("state");
  exactKeys(document, JOURNAL_FIELDS);
  const phase = requiredString(document, "phase");
  const leaseId = requiredString(document, "lease_id");
  const ownerPid = positiveInteger(document.owner_pid);
  const appBundlePath = canonicalPath(requiredString(document, "app_bundle_path"));
  const attemptId = document.attempt_id === null ? null : positiveInteger(document.attempt_id);
  if (
    !NATIVE_ID_PATTERN.test(leaseId) ||
    !["operation", "prepared", "preflight", "arming", "handed-off"].includes(phase)
  )
    throw new TransactionLeaseError("state");
  const parsedPhase = phase as JournalPhase;
  const candidateDocument = document.candidate;
  const candidate = candidateDocument === null ? null : parseCandidate(candidateDocument);
  const expectedDocument = document.expected_native;
  const expected = expectedDocument === null ? null : parseExpectedPlan(expectedDocument);
  const bindingDocument = document.binding;
  const binding = bindingDocument === null ? null : parseBinding(bindingDocument);
  const registeredGroupDocument = document.registered_group;
  const registeredGroup =
    registeredGroupDocument === null ? null : parseRegisteredGroup(registeredGroupDocument);
  if (typeof document.worker_granted !== "boolean") throw new TransactionLeaseError("state");
  const journal: UpdateTransactionLease = {
    schema_version: 1,
    lease_id: leaseId,
    phase: parsedPhase,
    created_at: canonicalTimestamp(requiredString(document, "created_at")),
    updated_at: canonicalTimestamp(requiredString(document, "updated_at")),
    owner_pid: ownerPid,
    app_bundle_path: appBundlePath,
    attempt_id: attemptId,
    candidate,
    expected_native: expected,
    existing_native_ids: parseNativeIds(document.existing_native_ids),
    binding,
    registered_group: registeredGroup,
    worker_granted: document.worker_granted,
  };
  assertJournalState(journal);
  return freezeJournal(journal);
}

async function assertLeaseDirectory(channelRoot: string): Promise<string | undefined> {
  const directory = leaseDirectory(channelRoot);
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new TransactionLeaseError("state");
  const entries = await readdir(directory).catch(() => {
    throw new TransactionLeaseError("state");
  });
  if (entries.length !== 1 || entries[0] !== LEASE_FILE) throw new TransactionLeaseError("state");
  const file = await lstat(leasePath(channelRoot)).catch(() => undefined);
  if (!file || file.isSymbolicLink() || !file.isFile()) throw new TransactionLeaseError("state");
  return directory;
}

function assertLeaseDirectorySync(channelRoot: string): string {
  const directory = leaseDirectory(channelRoot);
  const info = lstatSync(directory);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid())
  )
    throw new TransactionLeaseError("state");
  const entries = readdirSync(directory);
  if (entries.length !== 1 || entries[0] !== LEASE_FILE) throw new TransactionLeaseError("state");
  const file = lstatSync(leasePath(channelRoot));
  if (file.isSymbolicLink() || !file.isFile()) throw new TransactionLeaseError("state");
  return directory;
}

// Runtime readers remain strict. Only the stable kernel guard authorizes this inventory.
async function recoverTransactionResidue(
  options: ReconcileTransactionOptions,
  guard: KernelGuard,
): Promise<void> {
  if (
    !guard.isHeld() ||
    resolve(guard.path) !== resolve(join(options.channelRoot, KERNEL_GUARD_FILE))
  )
    throw new TransactionLeaseError("state");
  options.signal?.throwIfAborted();
  const directory = leaseDirectory(options.channelRoot);
  const info = lstatSync(directory, { throwIfNoEntry: false });
  if (!info) return;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  )
    throw new TransactionLeaseError("state");
  const names = readdirSync(directory).sort();
  if (names.length === 1 && names[0] === LEASE_FILE) return;
  // Without a canonical journal, native evidence cannot be attributed safely.
  // Empty residue occurs only before initial publication or after checked retirement.
  if (readdirSync(options.channelRoot).some((name) => name.startsWith(".electrobun-update-")))
    throw new TransactionLeaseError("state");
  if (names.length === 0) {
    rmdirSync(directory);
    syncDirectory(options.channelRoot);
    return;
  }
  if (
    !names.includes(LEASE_FILE) ||
    names.length > 17 ||
    names.some((name) => name !== LEASE_FILE && !/^lease\.json\.[a-f0-9]{16}\.partial$/.test(name))
  )
    throw new TransactionLeaseError("state");
  const journal = parseJournal(readPrivateJsonSync(leasePath(options.channelRoot)));
  if (
    !["operation", "prepared", "preflight"].includes(journal.phase) ||
    journal.binding ||
    (options.inspectOwner ?? inspectOwner)(journal.owner_pid) !== "absent"
  )
    throw new TransactionLeaseError("state");
  if (
    journal.registered_group &&
    (
      await (options.inspectGroup ?? inspectRegisteredGroup)(
        journal.registered_group,
        options.signal,
      )
    ).status !== "absent"
  )
    throw new TransactionLeaseError("state");
  options.signal?.throwIfAborted();
  const current = lstatSync(directory);
  if (
    current.dev !== info.dev ||
    current.ino !== info.ino ||
    current.mtimeMs !== info.mtimeMs ||
    current.ctimeMs !== info.ctimeMs ||
    !sameIds(readdirSync(directory).sort(), names)
  )
    throw new TransactionLeaseError("state");
  if (
    JSON.stringify(parseJournal(readPrivateJsonSync(leasePath(options.channelRoot)))) !==
    JSON.stringify(journal)
  )
    throw new TransactionLeaseError("state");
  for (const name of names) {
    const file = join(directory, name);
    if (lstatSync(file).nlink !== 1) throw new TransactionLeaseError("state");
    if (name === LEASE_FILE) continue;
    const partial = parseJournal(readPrivateJsonSync(file));
    if (
      partial.lease_id !== journal.lease_id ||
      partial.owner_pid !== journal.owner_pid ||
      partial.created_at !== journal.created_at ||
      partial.app_bundle_path !== journal.app_bundle_path ||
      !["operation", "prepared", "preflight"].includes(partial.phase) ||
      partial.binding ||
      partial.registered_group !== null ||
      partial.worker_granted
    )
      throw new TransactionLeaseError("state");
  }
  for (const name of names) if (name !== LEASE_FILE) unlinkSync(join(directory, name));
  syncDirectory(directory);
}

export async function readLease(channelRoot: string): Promise<UpdateTransactionLease | undefined> {
  try {
    if (!(await assertLeaseDirectory(channelRoot))) return undefined;
    return parseJournal(await readPrivateJson(leasePath(channelRoot)));
  } catch (error) {
    if (error instanceof TransactionLeaseError) throw error;
    throw new TransactionLeaseError("state");
  }
}

function readLeaseSync(channelRoot: string): UpdateTransactionLease | undefined {
  try {
    const directory = lstatSync(leaseDirectory(channelRoot), { throwIfNoEntry: false });
    if (!directory) return undefined;
    assertLeaseDirectorySync(channelRoot);
    return parseJournal(readPrivateJsonSync(leasePath(channelRoot)));
  } catch (error) {
    if (error instanceof TransactionLeaseError) throw error;
    throw new TransactionLeaseError("state");
  }
}

function journalWith(
  current: UpdateTransactionLease,
  patch: Partial<UpdateTransactionLease>,
): UpdateTransactionLease {
  return freezeJournal({
    ...current,
    ...patch,
    schema_version: 1,
    lease_id: current.lease_id,
    created_at: current.created_at,
    updated_at: new Date().toISOString(),
  });
}

function assertBindingIdentity(
  journal: UpdateTransactionLease,
  binding: NativeBinding,
  channelRoot: string,
): void {
  const expected = journal.expected_native;
  if (!expected) throw new TransactionLeaseError("state");
  const id = binding.transactionId;
  if (!NATIVE_ID_PATTERN.test(id) || journal.existing_native_ids.includes(id))
    throw new TransactionLeaseError("handoff");
  if (
    binding.resultPath !== nativeResultPath(channelRoot, id) ||
    binding.helperPath !== nativeHelperPath(expected.physicalTemporaryDirectory, id)
  )
    throw new TransactionLeaseError("state");
  if (binding.evidence === "observed-plan") {
    if (binding.planPath !== nativePlanPath(channelRoot, id))
      throw new TransactionLeaseError("state");
    if (!expectedPlanEquals(binding.plan, expected)) throw new TransactionLeaseError("candidate");
  }
}

function expectedPlanEquals(left: ExpectedNativePlan, right: ExpectedNativePlan): boolean {
  return (
    left.identifier === right.identifier &&
    left.channel === right.channel &&
    left.platform === right.platform &&
    left.arch === right.arch &&
    left.version === right.version &&
    left.hash === right.hash &&
    left.channelRoot === right.channelRoot &&
    left.appBundlePath === right.appBundlePath &&
    left.retainedTarPath === right.retainedTarPath &&
    left.parentPid === right.parentPid &&
    left.physicalTemporaryDirectory === right.physicalTemporaryDirectory
  );
}

function assertNoExistingNativeId(current: UpdateTransactionLease, transactionId: string): void {
  if (!NATIVE_ID_PATTERN.test(transactionId) || current.existing_native_ids.includes(transactionId))
    throw new TransactionLeaseError("handoff");
}

function requireIdentity(current: UpdateTransactionLease, identity: JournalIdentity): void {
  if (
    identity.nonce !== current.lease_id ||
    !Number.isSafeInteger(identity.attemptId) ||
    identity.attemptId <= 0 ||
    current.attempt_id !== identity.attemptId
  )
    throw new TransactionLeaseError("state");
}

function assertGuardError(error: unknown): never {
  if (error instanceof UpdaterStateError && error.code === "guardBusy")
    throw new TransactionLeaseError("busy");
  throw new TransactionLeaseError("state");
}

function readResultDocument(path: string): unknown {
  try {
    return readNativeJsonSync(path);
  } catch {
    throw new TransactionLeaseError("state");
  }
}

function validateResult(
  document: unknown,
  candidate: TransactionCandidate,
  transactionId: string,
): TransactionResult {
  if (!isRecord(document) || document.schema_version !== 1)
    throw new TransactionLeaseError("state");
  exactKeys(document, RESULT_FIELDS);
  const text = (key: string) => requiredString(document, key);
  if (typeof document.success !== "boolean") throw new TransactionLeaseError("state");
  const result: TransactionResult = {
    schema_version: 1,
    transaction_id: text("transaction_id"),
    success: document.success,
    phase: text("phase"),
    message: text("message"),
    identifier: text("identifier"),
    channel: text("channel"),
    version: text("version"),
    hash: text("hash"),
  };
  if (
    result.transaction_id !== transactionId ||
    ![
      "validating",
      "waiting_for_parent",
      "extracting",
      "validating_payload",
      "swapping",
      "integrating",
      "launching",
      "complete",
    ].includes(result.phase) ||
    result.identifier !== UPDATER_IDENTIFIER ||
    result.channel !== UPDATER_CHANNEL ||
    candidate.version !== result.version ||
    candidate.hash !== result.hash ||
    result.success !== (result.phase === "complete")
  )
    throw new TransactionLeaseError("state");
  return Object.freeze(result);
}

export class TransactionLease {
  private value: UpdateTransactionLease;
  private guard: KernelGuard | undefined;
  private guardReleased = false;
  private readonly ownedWork = new Set<Promise<unknown>>();

  constructor(
    readonly channelRoot: string,
    readonly dataDirectory: string,
    journal: UpdateTransactionLease,
    guard?: KernelGuard,
  ) {
    this.value = freezeJournal(journal);
    this.guard = guard;
  }

  snapshot(): UpdateTransactionLease {
    return this.value;
  }

  get committed(): boolean {
    return this.value.phase === "arming" || this.value.phase === "handed-off";
  }

  static async acquire(options: {
    channelRoot: string;
    dataDirectory: string;
    appBundlePath: string;
  }): Promise<TransactionLease> {
    const directory = leaseDirectory(options.channelRoot);
    const guard = await acquireKernelGuard(options.channelRoot).catch(assertGuardError);
    try {
      await recoverTransactionResidue(options, guard);
      await mkdir(options.channelRoot, { recursive: true, mode: 0o700 });
      await mkdir(directory, { recursive: false, mode: 0o700 });
      syncDirectory(options.channelRoot);
    } catch (error) {
      guard.releaseSync();
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new TransactionLeaseError("busy");
      throw new TransactionLeaseError("state");
    }
    const now = new Date().toISOString();
    const journal = freezeJournal({
      schema_version: 1,
      lease_id: randomBytes(16).toString("hex"),
      phase: "operation",
      created_at: now,
      updated_at: now,
      owner_pid: process.pid,
      app_bundle_path: canonicalPath(options.appBundlePath),
      attempt_id: null,
      candidate: null,
      expected_native: null,
      existing_native_ids: [],
      binding: null,
      registered_group: null,
      worker_granted: false,
    });
    try {
      await atomicWritePrivateJson(leasePath(options.channelRoot), journal);
    } catch {
      // A failed sync can follow a successful rename. Preserve its recovery evidence.
      guard.releaseSync();
      throw new TransactionLeaseError("state");
    }
    return new TransactionLease(options.channelRoot, options.dataDirectory, journal, guard);
  }

  async ensureGuard(): Promise<void> {
    if (this.guard?.isHeld() && !this.guardReleased) return;
    const guard = await acquireKernelGuard(this.channelRoot);
    this.guard = guard;
    this.guardReleased = false;
    try {
      this.readCurrentSync();
    } catch (error) {
      this.releaseGuard();
      throw error;
    }
  }

  private readReconciliationJournal(): UpdateTransactionLease {
    this.assertGuardHeld();
    const current = readLeaseSync(this.channelRoot);
    if (!current || JSON.stringify(current) !== JSON.stringify(this.value))
      throw new TransactionLeaseError("state");
    return current;
  }

  private assertGuardHeld(): void {
    if (
      !this.guard ||
      this.guardReleased ||
      !this.guard.isHeld() ||
      resolve(this.guard.path) !== resolve(join(this.channelRoot, KERNEL_GUARD_FILE))
    )
      throw new TransactionLeaseError("state");
  }

  private assertOwnedJournal(current: UpdateTransactionLease): void {
    if (
      current.lease_id !== this.value.lease_id ||
      current.owner_pid !== process.pid ||
      current.app_bundle_path !== this.value.app_bundle_path
    )
      throw new TransactionLeaseError("state");
  }

  private async readCurrent(): Promise<UpdateTransactionLease> {
    this.assertGuardHeld();
    const current = await readLease(this.channelRoot);
    if (!current) throw new TransactionLeaseError("state");
    this.assertOwnedJournal(current);
    return current;
  }

  /** Under the held guard: fresh nonce/state read plus owner/attempt validation. */
  private readCurrentSync(): UpdateTransactionLease {
    this.assertGuardHeld();
    const current = readLeaseSync(this.channelRoot);
    if (!current) throw new TransactionLeaseError("state");
    this.assertOwnedJournal(current);
    return current;
  }

  /** Track every writer/cleanup task that must settle before retirement. */
  trackOwnedWork<T>(work: Promise<T>): Promise<T> {
    const tracked: Promise<T> = work.then(
      (value) => {
        this.ownedWork.delete(tracked);
        return value;
      },
      (error) => {
        this.ownedWork.delete(tracked);
        throw error;
      },
    );
    this.ownedWork.add(tracked);
    return tracked;
  }

  async settleOwnedWork(): Promise<void> {
    const failures: unknown[] = [];
    while (this.ownedWork.size > 0) {
      const pending = [...this.ownedWork];
      this.ownedWork.clear();
      const settled = await Promise.allSettled(pending);
      for (const outcome of settled) {
        if (outcome.status === "rejected") failures.push(outcome.reason);
      }
    }
    if (failures.length > 0) throw new TransactionLeaseError("state");
  }

  registerWorkerGroupSync(group: RegisteredGroup): void {
    const current = this.readCurrentSync();
    if (
      (current.phase !== "operation" &&
        current.phase !== "prepared" &&
        current.phase !== "preflight") ||
      current.registered_group !== null ||
      current.worker_granted ||
      !isRegisteredGroup(group)
    )
      throw new TransactionLeaseError("state");
    this.persistSync(
      journalWith(current, {
        registered_group: Object.freeze({ ...group }),
        worker_granted: false,
      }),
    );
  }

  markWorkerGrantedSync(): void {
    const current = this.readCurrentSync();
    if (!current.registered_group || current.worker_granted)
      throw new TransactionLeaseError("state");
    this.persistSync(journalWith(current, { worker_granted: true }));
  }

  clearWorkerGroupSync(): void {
    const current = this.readCurrentSync();
    if (!current.registered_group) throw new TransactionLeaseError("state");
    this.persistSync(journalWith(current, { registered_group: null, worker_granted: false }));
  }

  async assertWorkerSettled(): Promise<void> {
    const current = await this.readCurrent();
    if (!current.registered_group) return;
    const state = await inspectRegisteredGroup(current.registered_group);
    if (state.status !== "absent") throw new TransactionLeaseError("state");
    this.clearWorkerGroupSync();
  }

  private async persist(next: UpdateTransactionLease): Promise<void> {
    this.assertGuardHeld();
    try {
      await atomicWritePrivateJson(leasePath(this.channelRoot), next);
    } catch {
      throw new TransactionLeaseError("state");
    }
    this.value = next;
  }

  private persistSync(next: UpdateTransactionLease): void {
    this.assertGuardHeld();
    try {
      atomicWritePrivateJsonSync(leasePath(this.channelRoot), next);
    } catch {
      throw new TransactionLeaseError("state");
    }
    this.value = next;
  }

  async markPrepared(
    candidate: Readonly<FrozenCandidate>,
    recoveryPath: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new TransactionLeaseError("cancelled");
    await this.assertWorkerSettled();
    const current = await this.readCurrent();
    if (signal?.aborted) throw new TransactionLeaseError("cancelled");
    if (current.phase !== "operation" || current.candidate !== null)
      throw new TransactionLeaseError("state");
    if (recoveryPath !== null) {
      if (!recoveryPath.endsWith(".app")) throw new TransactionLeaseError("state");
      canonicalPath(recoveryPath);
    }
    const next = journalWith(current, {
      phase: "prepared",
      candidate: {
        version: candidate.version,
        hash: candidate.hash,
        prepared_path: candidate.prepared_path,
        prepared_sha256: candidate.prepared_sha256,
        retained_tar_path: candidate.retained_tar_path,
        archive_sha256: candidate.archive_sha256,
        archive_bytes: candidate.archive_bytes,
        recovery_path: recoveryPath,
      },
    });
    if (signal?.aborted) throw new TransactionLeaseError("cancelled");
    this.persistSync(next);
  }

  assertCandidate(candidate: Readonly<FrozenCandidate>): void {
    const current = this.value.candidate;
    if (
      !current ||
      current.version !== candidate.version ||
      current.hash !== candidate.hash ||
      current.prepared_path !== candidate.prepared_path ||
      current.prepared_sha256 !== candidate.prepared_sha256 ||
      current.retained_tar_path !== candidate.retained_tar_path ||
      current.archive_sha256 !== candidate.archive_sha256 ||
      current.archive_bytes !== candidate.archive_bytes
    )
      throw new TransactionLeaseError("candidate");
  }

  private validatePreparedRequest(
    attempt: UpdateAttempt,
    expected: ExpectedNativePlan,
    existingNativeIds: readonly string[],
  ): { expected: ExpectedNativePlan; ids: readonly string[] } {
    if (!Number.isSafeInteger(attempt.id) || attempt.id <= 0)
      throw new TransactionLeaseError("state");
    if (attempt.signal.aborted) throw new TransactionLeaseError("cancelled");
    if (this.value.registered_group !== null || this.value.worker_granted)
      throw new TransactionLeaseError("state");
    this.assertCandidate(attempt.candidate);
    const parsedExpected = parseExpectedPlan(expected);
    const candidate = this.value.candidate;
    if (!candidate) throw new TransactionLeaseError("state");
    if (
      parsedExpected.channelRoot !== this.channelRoot ||
      parsedExpected.appBundlePath !== this.value.app_bundle_path ||
      parsedExpected.version !== candidate.version ||
      parsedExpected.hash !== candidate.hash ||
      parsedExpected.retainedTarPath !== candidate.retained_tar_path
    )
      throw new TransactionLeaseError("candidate");
    const ids = parseNativeIds(existingNativeIds);
    return { expected: parsedExpected, ids };
  }

  /**
   * Bind the approved candidate and prepare the bounded before-call native ID
   * set. The signal is rechecked after the durable transition.
   */
  async prepareHandoff(
    attempt: UpdateAttempt,
    expected: ExpectedNativePlan,
    existingNativeIds: readonly string[],
  ): Promise<PreparedHandoff> {
    const request = this.validatePreparedRequest(attempt, expected, existingNativeIds);
    const current = await this.readCurrent();
    if (current.phase === "preflight") {
      if (
        current.attempt_id !== attempt.id ||
        !current.expected_native ||
        !expectedPlanEquals(current.expected_native, request.expected) ||
        !sameIds(current.existing_native_ids, request.ids)
      )
        throw new TransactionLeaseError("handoff");
      return this.preparedHandoff(current);
    }
    if (current.phase !== "prepared") throw new TransactionLeaseError("state");
    if (current.attempt_id !== null) throw new TransactionLeaseError("state");
    const next = journalWith(current, {
      phase: "preflight",
      attempt_id: attempt.id,
      expected_native: request.expected,
      existing_native_ids: request.ids,
      binding: null,
    });
    await this.persist(next);
    if (attempt.signal.aborted) throw new TransactionLeaseError("cancelled");
    return this.preparedHandoff(next);
  }

  private preparedHandoff(journal: UpdateTransactionLease): PreparedHandoff {
    if (!journal.attempt_id || !journal.expected_native || !journal.candidate)
      throw new TransactionLeaseError("state");
    return Object.freeze({
      identity: Object.freeze({
        nonce: journal.lease_id,
        attemptId: journal.attempt_id,
      }),
      expected: journal.expected_native,
      existingNativeIds: journal.existing_native_ids,
      candidate: journal.candidate,
    });
  }

  /**
   * Persist conservative arming state immediately before the SDK quit approval
   * is offered. This is a synchronous critical section under the held guard.
   */
  armHandoffSync(identity: JournalIdentity): void {
    const current = this.readCurrentSync();
    requireIdentity(current, identity);
    if (
      current.phase !== "preflight" ||
      !current.attempt_id ||
      !current.expected_native ||
      current.registered_group !== null ||
      current.worker_granted
    )
      throw new TransactionLeaseError("state");
    this.persistSync(journalWith(current, { phase: "arming" }));
  }

  /**
   * Persist the exact SDK transaction binding before the status callback
   * returns. A failure here leaves the already-durable arming record intact.
   */
  bindNativeSync(identity: JournalIdentity, binding: NativeBinding): void {
    const current = this.readCurrentSync();
    requireIdentity(current, identity);
    if (
      current.phase !== "arming" ||
      current.binding !== null ||
      !current.expected_native ||
      !current.candidate
    )
      throw new TransactionLeaseError("state");
    const parsed = parseBinding(binding);
    assertNoExistingNativeId(current, parsed.transactionId);
    assertBindingIdentity(current, parsed, this.channelRoot);
    if (parsed.evidence === "early-terminal-result") {
      const result = validateResult(
        readResultDocument(parsed.resultPath),
        current.candidate,
        parsed.transactionId,
      );
      if (result.success) throw new TransactionLeaseError("state");
    }
    this.persistSync(
      journalWith(current, {
        phase: "handed-off",
        binding: parsed,
      }),
    );
  }

  /**
   * Issue an unarmed proof only for the current arming record with no binding
   * and no observed SDK applying/binding callback. The session layer remains
   * responsible for deriving these booleans from the tagged invocation.
   */
  proveUnarmed(
    identity: JournalIdentity,
    input: {
      reason: UnarmedReason;
      approvalOffered: boolean;
      applyingObserved: boolean;
      bindingObserved: boolean;
    },
  ): UnarmedEvidence {
    const current = this.readCurrentSync();
    requireIdentity(current, identity);
    if (
      current.phase !== "arming" ||
      current.binding !== null ||
      !current.attempt_id ||
      typeof input.approvalOffered !== "boolean" ||
      input.applyingObserved !== false ||
      input.bindingObserved !== false ||
      !["validation-refused", "vetoed", "cancelled", "preapproval-error"].includes(input.reason)
    )
      throw new TransactionLeaseError("state");
    const evidence = Object.freeze({
      kind: "unarmed" as const,
      reason: input.reason,
      nonce: current.lease_id,
      attemptId: current.attempt_id,
      approvalOffered: input.approvalOffered,
      applyingObserved: false as const,
      bindingObserved: false as const,
    });
    unarmedEvidence.add(evidence);
    return evidence;
  }

  private assertNoUnboundNativeFiles(current: UpdateTransactionLease): void {
    for (const name of readdirSync(this.channelRoot)) {
      const match = NATIVE_FILE_PATTERN.exec(name);
      if (!match?.[1]) continue;
      if (!current.existing_native_ids.includes(match[1]))
        throw new TransactionLeaseError("handoff");
    }
  }

  private removeJournalSync(): void {
    const directory = assertLeaseDirectorySync(this.channelRoot);
    unlinkSync(leasePath(this.channelRoot));
    syncDirectory(directory);
    rmdirSync(directory);
    syncDirectory(this.channelRoot);
  }

  /** Legal only after an issued unarmed proof and settled owned work. */
  async retireUnarmed(identity: JournalIdentity, evidence: UnarmedEvidence): Promise<void> {
    if (!unarmedEvidence.has(evidence)) throw new TransactionLeaseError("state");
    try {
      await this.settleOwnedWork();
      await this.assertWorkerSettled();
      const current = this.readCurrentSync();
      requireIdentity(current, identity);
      if (
        evidence.kind !== "unarmed" ||
        evidence.nonce !== current.lease_id ||
        evidence.attemptId !== current.attempt_id ||
        evidence.applyingObserved !== false ||
        evidence.bindingObserved !== false ||
        current.phase !== "arming" ||
        current.binding !== null
      )
        throw new TransactionLeaseError("state");
      this.assertNoUnboundNativeFiles(current);
      this.removeJournalSync();
    } finally {
      this.releaseGuard();
    }
  }

  async restorePrepared(identity: JournalIdentity, evidence?: UnarmedEvidence): Promise<void> {
    await this.settleOwnedWork();
    await this.assertWorkerSettled();
    const current = this.readCurrentSync();
    requireIdentity(current, identity);
    if (
      !current.candidate ||
      current.binding ||
      (current.phase !== "preflight" && current.phase !== "arming")
    )
      throw new TransactionLeaseError("state");
    if (
      current.phase === "arming" &&
      (!evidence ||
        !unarmedEvidence.has(evidence) ||
        evidence.nonce !== current.lease_id ||
        evidence.attemptId !== current.attempt_id)
    )
      throw new TransactionLeaseError("state");
    this.assertNoUnboundNativeFiles(current);
    this.persistSync(
      journalWith(current, {
        phase: "prepared",
        attempt_id: null,
        expected_native: null,
        existing_native_ids: [],
        binding: null,
      }),
    );
  }

  async recoverAbandoned(
    options: Pick<ReconcileTransactionOptions, "inspectOwner" | "inspectGroup" | "signal">,
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const current = this.readReconciliationJournal();
    if (!["operation", "prepared", "preflight"].includes(current.phase) || current.binding)
      throw new TransactionLeaseError("state");
    if ((options.inspectOwner ?? inspectOwner)(current.owner_pid) !== "absent")
      throw new TransactionLeaseError("state");
    if (
      current.registered_group &&
      (
        await (options.inspectGroup ?? inspectRegisteredGroup)(
          current.registered_group,
          options.signal,
        )
      ).status !== "absent"
    )
      throw new TransactionLeaseError("state");
    options.signal?.throwIfAborted();
    this.readReconciliationJournal();
    await cleanupInterruptedStaging({
      channelRoot: this.channelRoot,
      dataDirectory: this.dataDirectory,
    });
    options.signal?.throwIfAborted();
    if (current.candidate)
      await discardFrozenCandidate(this.channelRoot, this.dataDirectory, current.candidate);
    options.signal?.throwIfAborted();
    this.readReconciliationJournal();
    this.removeJournalSync();
  }

  /** Retire a reconciled committed transaction using the reconciler proof. */
  async retireReconciled(proof: ReconciledCompletionProof, signal?: AbortSignal): Promise<void> {
    if (!reconciledProofs.has(proof)) throw new TransactionLeaseError("state");
    try {
      await this.settleOwnedWork();
      signal?.throwIfAborted();
      const recorded = this.readReconciliationJournal();
      if (
        recorded.registered_group &&
        (await inspectRegisteredGroup(recorded.registered_group, signal)).status !== "absent"
      )
        throw new TransactionLeaseError("state");
      signal?.throwIfAborted();
      const current = this.readReconciliationJournal();
      const binding = current.binding;
      const candidate = current.candidate;
      if (
        current.phase !== "handed-off" ||
        !binding ||
        !candidate ||
        !current.attempt_id ||
        proof.nonce !== current.lease_id ||
        proof.attemptId !== current.attempt_id ||
        proof.transactionId !== binding.transactionId ||
        proof.resultPath !== binding.resultPath ||
        proof.helperPath !== binding.helperPath ||
        proof.planPath !==
          (binding.evidence === "observed-plan"
            ? binding.planPath
            : nativePlanPath(this.channelRoot, binding.transactionId)) ||
        proof.target.appBundlePath !== current.app_bundle_path
      )
        throw new TransactionLeaseError("state");
      const result = validateResult(
        readResultDocument(proof.resultPath),
        candidate,
        proof.transactionId,
      );
      if (
        result.success !== proof.success ||
        proof.target.version !== result.version ||
        proof.target.hash !== result.hash ||
        candidate.version !== result.version ||
        candidate.hash !== result.hash
      )
        throw new TransactionLeaseError("state");
      this.removeJournalSync();
    } finally {
      this.releaseGuard();
    }
  }

  /**
   * Remove an uncommitted operation/prepared/preflight journal only after every
   * tracked writer and cleanup task settles. Committed embargoes are refused.
   */
  async releaseUncommitted(): Promise<void> {
    try {
      await this.settleOwnedWork();
      await this.assertWorkerSettled();
      const current = this.readCurrentSync();
      if (
        (current.phase !== "operation" &&
          current.phase !== "prepared" &&
          current.phase !== "preflight") ||
        current.binding !== null
      )
        throw new TransactionLeaseError("handoff");
      this.removeJournalSync();
    } finally {
      this.releaseGuard();
    }
  }

  /** Close only the transient kernel descriptor; the durable journal remains. */
  releaseGuard(): void {
    if (this.guardReleased) return;
    this.guardReleased = true;
    const guard = this.guard;
    this.guard = undefined;
    guard?.releaseSync();
  }

  async discardPrepared(): Promise<void> {
    const candidate = this.value.candidate;
    if (candidate) {
      await discardFrozenCandidate(this.channelRoot, this.dataDirectory, {
        version: candidate.version,
        hash: candidate.hash,
      });
    }
  }
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function issueReconciledProof(input: ReconciledCompletionProof): ReconciledCompletionProof {
  const proof = Object.freeze({
    ...input,
    target: Object.freeze({ ...input.target }),
  });
  reconciledProofs.add(proof);
  return proof;
}

async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}

function recoveryRequired(
  journal: UpdateTransactionLease | undefined,
  message: string,
): TransactionReconciliation {
  return Object.freeze({
    status: "recovery-required",
    ...(journal?.candidate?.recovery_path ? { recoveryPath: journal.candidate.recovery_path } : {}),
    message,
  });
}

function inspectOwner(pid: number): "alive" | "absent" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
  }
}

/**
 * Reconcile only the exact bound native transaction. Parent death, timestamps,
 * and unrelated same-version results are never completion evidence.
 */
export async function reconcileTransaction(
  options: ReconcileTransactionOptions,
): Promise<TransactionReconciliation> {
  options.signal?.throwIfAborted();
  let guard: KernelGuard;
  try {
    guard = await acquireKernelGuard(options.channelRoot);
  } catch (error) {
    const busy = error instanceof UpdaterStateError && error.code === "guardBusy";
    return Object.freeze({
      status: "recovery-required",
      message: busy
        ? "An update transaction is still owned by an active process."
        : "The update transaction guard is unavailable.",
    });
  }
  try {
    options.signal?.throwIfAborted();
    const running = options.inspectRunning
      ? await options.inspectRunning(options.signal)
      : options.running;
    options.signal?.throwIfAborted();
    let journal: UpdateTransactionLease | undefined;
    try {
      await recoverTransactionResidue(options, guard);
      journal = await readLease(options.channelRoot);
    } catch {
      options.signal?.throwIfAborted();
      return recoveryRequired(
        undefined,
        "An update transaction record is malformed or unsafe. No update work will start.",
      );
    }
    options.signal?.throwIfAborted();
    if (!journal) return Object.freeze({ status: "none" });
    if (["operation", "prepared", "preflight"].includes(journal.phase)) {
      const lease = new TransactionLease(
        options.channelRoot,
        options.dataDirectory,
        journal,
        guard,
      );
      try {
        await lease.recoverAbandoned(options);
        options.signal?.throwIfAborted();
        return Object.freeze({ status: "none" });
      } catch {
        options.signal?.throwIfAborted();
        return recoveryRequired(journal, "Abandoned update cleanup could not be completed safely.");
      }
    }
    if (journal.phase !== "handed-off") {
      return recoveryRequired(
        journal,
        "An update transaction still owns prepare or arming state. No new update work will start.",
      );
    }
    const binding = journal.binding;
    const candidate = journal.candidate;
    if (!binding || !candidate || !journal.attempt_id) {
      return recoveryRequired(
        journal,
        "An update transaction has no trustworthy completion record. No new update work will start.",
      );
    }
    try {
      assertBindingIdentity(journal, binding, options.channelRoot);
    } catch {
      return recoveryRequired(
        journal,
        "An update transaction is not bound to its recorded native identity.",
      );
    }
    let result: TransactionResult;
    try {
      result = validateResult(
        readResultDocument(binding.resultPath),
        candidate,
        binding.transactionId,
      );
    } catch {
      return recoveryRequired(
        journal,
        "An update transaction has no trustworthy completion record. No new update work will start.",
      );
    }
    if (binding.resultPath !== nativeResultPath(options.channelRoot, binding.transactionId)) {
      return recoveryRequired(
        journal,
        "An update transaction result is not bound to its recorded native identity.",
      );
    }
    const planPath =
      binding.evidence === "observed-plan"
        ? binding.planPath
        : nativePlanPath(options.channelRoot, binding.transactionId);
    if ((await pathPresent(planPath)) || (await pathPresent(binding.helperPath))) {
      return recoveryRequired(
        journal,
        "The previous update helper or plan may still be writing shared update state.",
      );
    }
    const inspect = options.inspectHelper ?? inspectExactHelper;
    const inspection: ExactHelperInspection = await inspect(
      binding.helperPath,
      planPath,
      process.getuid?.(),
      {},
      options.signal,
    ).catch(() => ({ status: "unknown" as const, pids: [] }));
    options.signal?.throwIfAborted();
    if (inspection.status !== "absent") {
      return recoveryRequired(
        journal,
        "The previous update helper has not been proven to have finished.",
      );
    }
    if (!running || running.appBundlePath !== journal.app_bundle_path) {
      return Object.freeze({
        status: "unconfirmed",
        ...(candidate.recovery_path ? { recoveryPath: candidate.recovery_path } : {}),
        version: result.version,
        hash: result.hash,
        message:
          "The update result was not confirmed by this application bundle. A verified previous app copy is retained for manual recovery.",
      });
    }
    if (result.success && (running.version !== result.version || running.hash !== result.hash)) {
      return Object.freeze({
        status: "unconfirmed",
        ...(candidate.recovery_path ? { recoveryPath: candidate.recovery_path } : {}),
        version: result.version,
        hash: result.hash,
        message:
          "The update success was not confirmed by the initialized running version and hash. A verified previous app copy is retained for manual recovery.",
      });
    }
    const proof = issueReconciledProof({
      kind: "reconciled-completion",
      nonce: journal.lease_id,
      attemptId: journal.attempt_id,
      transactionId: binding.transactionId,
      resultPath: binding.resultPath,
      helperPath: binding.helperPath,
      planPath,
      success: result.success,
      target: {
        appBundlePath: journal.app_bundle_path,
        version: result.version,
        hash: result.hash,
      },
    });
    const lease = new TransactionLease(options.channelRoot, options.dataDirectory, journal, guard);
    try {
      await lease.retireReconciled(proof, options.signal);
      options.signal?.throwIfAborted();
    } catch {
      options.signal?.throwIfAborted();
      return recoveryRequired(
        journal,
        "The completed update transaction could not be retired safely.",
      );
    }
    if (!result.success) {
      return Object.freeze({
        status: "failed",
        ...(candidate.recovery_path ? { recoveryPath: candidate.recovery_path } : {}),
        version: result.version,
        hash: result.hash,
        message:
          "The previous update did not complete. A verified previous app copy is retained for manual recovery.",
      });
    }
    return Object.freeze({
      status: "confirmed",
      version: result.version,
      hash: result.hash,
    });
  } finally {
    guard.releaseSync();
  }
}
