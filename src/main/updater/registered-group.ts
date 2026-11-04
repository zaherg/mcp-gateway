import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCommandRunner } from "../../core/command";

const INSPECTION_TIMEOUT_MS = 5_000;
const MAX_PROCESS_OUTPUT = 8192;
const MAX_GROUP_PIDS = 128;

const runInspection = createCommandRunner({ maxOutputBytes: MAX_PROCESS_OUTPUT });

export interface RegisteredGroup {
  schema_version: 1;
  leader_pid: number;
  leader_start: string;
  pgid: number;
  uid: number;
  helper_path: string;
  plan_path: string;
}

export type RegisteredGroupState =
  | { status: "alive"; pids: number[] }
  | { status: "absent"; pids: [] }
  | { status: "unknown"; pids: number[] };

export function isRegisteredGroup(record: unknown): record is RegisteredGroup {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return false;
  const { leader_pid, pgid, uid, leader_start, helper_path, plan_path, schema_version } =
    record as Partial<RegisteredGroup>;
  return (
    schema_version === 1 &&
    typeof leader_pid === "number" &&
    Number.isSafeInteger(leader_pid) &&
    leader_pid > 0 &&
    typeof pgid === "number" &&
    Number.isSafeInteger(pgid) &&
    pgid > 0 &&
    typeof uid === "number" &&
    Number.isSafeInteger(uid) &&
    uid >= 0 &&
    typeof leader_start === "string" &&
    leader_start.length > 0 &&
    typeof helper_path === "string" &&
    typeof plan_path === "string" &&
    resolve(helper_path) === helper_path &&
    resolve(plan_path) === plan_path
  );
}

async function inspectLeader(
  pid: number,
  signal?: AbortSignal,
): Promise<{ start: string; uid: number; pgid: number } | null | "unknown"> {
  try {
    const result = await runInspection(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "uid=", "-o", "pgid="],
      INSPECTION_TIMEOUT_MS,
      signal,
    );
    if (result.exitCode === 1 && result.stdout.trim() === "" && result.stderr.trim() === "")
      return null;
    if (result.exitCode !== 0 || result.stderr.trim() !== "") return "unknown";
    const line = result.stdout.trim();
    if (!line) return null;
    // lstart is fixed-width prose; the final two whitespace-separated fields are
    // uid and pgid. Do not split the lstart text itself.
    const match = /^(.*?)\s+(\d+)\s+(\d+)$/.exec(line);
    if (
      !match?.[1] ||
      !Number.isSafeInteger(Number(match[2])) ||
      !Number.isSafeInteger(Number(match[3])) ||
      Number(match[3]) <= 0
    )
      return "unknown";
    return { start: match[1], uid: Number(match[2]), pgid: Number(match[3]) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return "unknown";
  }
}

export async function captureRegisteredGroup(input: {
  leaderPid: number;
  helperPath: string;
  planPath: string;
  uid?: number;
  signal?: AbortSignal;
}): Promise<RegisteredGroup> {
  const uid = input.uid ?? process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error("Invalid process UID");
  const leader = await inspectLeader(input.leaderPid, input.signal);
  if (!leader || leader === "unknown" || leader.uid !== uid)
    throw new Error("Cannot establish exact process-group identity");
  return {
    schema_version: 1,
    leader_pid: input.leaderPid,
    leader_start: leader.start,
    pgid: leader.pgid,
    uid,
    helper_path: resolve(input.helperPath),
    plan_path: resolve(input.planPath),
  };
}

export async function persistRegisteredGroup(
  root: string,
  record: RegisteredGroup,
): Promise<string> {
  if (!isRegisteredGroup(record)) throw new Error("Invalid registered process group");
  const path = join(root, "registered-group.json");
  await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

export function recoveryMayReleaseGroup(state: RegisteredGroupState): boolean {
  return state.status === "absent";
}

/** Any live member keeps recovery blocked; uncertainty never authorizes cleanup. */
export async function inspectRegisteredGroup(
  record: RegisteredGroup,
  signal?: AbortSignal,
): Promise<RegisteredGroupState> {
  if (!isRegisteredGroup(record) || record.uid !== process.getuid?.())
    return { status: "unknown", pids: [] };
  let leader: Awaited<ReturnType<typeof inspectLeader>>;
  try {
    leader = await inspectLeader(record.leader_pid, signal);
  } catch {
    return { status: "unknown", pids: [] };
  }
  if (leader === "unknown") return { status: "unknown", pids: [] };
  if (
    leader &&
    (leader.start !== record.leader_start ||
      leader.uid !== record.uid ||
      leader.pgid !== record.pgid)
  )
    return { status: "unknown", pids: [] };
  try {
    const result = await runInspection(
      "/usr/bin/pgrep",
      ["-U", String(record.uid), "-g", String(record.pgid)],
      INSPECTION_TIMEOUT_MS,
      signal,
    );
    if (result.stderr.trim() !== "") return { status: "unknown", pids: [] };
    if (result.exitCode === 1 && result.stdout.trim() === "") return { status: "absent", pids: [] };
    if (result.exitCode !== 0) return { status: "unknown", pids: [] };
    const identifiers = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (identifiers.some((value) => !/^[1-9]\d*$/.test(value)))
      return { status: "unknown", pids: [] };
    const values = identifiers.map(Number);
    if (values.length === 0) return { status: "absent", pids: [] };
    if (
      values.length > MAX_GROUP_PIDS ||
      values.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
    )
      return { status: "unknown", pids: [] };
    // Once the registered leader is gone, the remaining group identity is not
    // proven by this record; keep recovery blocked as uncertainty rather than
    // treating a recycled group ID as the original worker.
    if (!leader) return { status: "unknown", pids: values };
    return { status: "alive", pids: values };
  } catch {
    return { status: "unknown", pids: [] };
  }
}
