import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const MAX_PROCESS_OUTPUT = 8192;
const MAX_GROUP_PIDS = 128;

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
): Promise<{ start: string; uid: number; pgid: number } | null | "unknown"> {
  const child = Bun.spawn(
    ["/bin/ps", "-p", String(pid), "-o", "lstart=", "-o", "uid=", "-o", "pgid="],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  if (Buffer.byteLength(out) > MAX_PROCESS_OUTPUT || Buffer.byteLength(err) > MAX_PROCESS_OUTPUT)
    return "unknown";
  if (code === 1 && out.trim() === "" && err.trim() === "") return null;
  if (code !== 0 || err.trim() !== "") return "unknown";
  const line = out.trim();
  if (!line) return null;
  // lstart is fixed-width prose; the final two whitespace-separated fields are
  // uid and pgid. Do not split the lstart text itself.
  const match = /^(.*?)\s+(\d+)\s+(\d+)$/.exec(line);
  if (!match || match[1] === undefined) return "unknown";
  return { start: match[1], uid: Number(match[2]), pgid: Number(match[3]) };
}

export async function captureRegisteredGroup(input: {
  leaderPid: number;
  helperPath: string;
  planPath: string;
  uid?: number;
}): Promise<RegisteredGroup> {
  const uid = input.uid ?? process.getuid?.();
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error("Invalid process UID");
  const leader = await inspectLeader(input.leaderPid);
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
): Promise<RegisteredGroupState> {
  if (!isRegisteredGroup(record) || record.uid !== process.getuid?.())
    return { status: "unknown", pids: [] };
  const leader = await inspectLeader(record.leader_pid);
  if (leader === "unknown") return { status: "unknown", pids: [] };
  if (
    leader &&
    (leader.start !== record.leader_start ||
      leader.uid !== record.uid ||
      leader.pgid !== record.pgid)
  )
    return { status: "unknown", pids: [] };
  const child = Bun.spawn(["/usr/bin/pgrep", "-U", String(record.uid), "-g", String(record.pgid)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  if (Buffer.byteLength(out) > MAX_PROCESS_OUTPUT || Buffer.byteLength(err) > MAX_PROCESS_OUTPUT)
    return { status: "unknown", pids: [] };
  if (err.trim() !== "") return { status: "unknown", pids: [] };
  if (code === 1 && out.trim() === "") return { status: "absent", pids: [] };
  if (code !== 0) return { status: "unknown", pids: [] };
  const values = out.trim().split(/\s+/).filter(Boolean).map(Number);
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
}
