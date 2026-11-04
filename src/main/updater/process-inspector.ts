import { resolve } from "node:path";
import { createCommandRunner } from "../../core/command";

const INSPECTION_TIMEOUT_MS = 3_000;
const MAX_INSPECTION_OUTPUT = 8192;

const runInspection = createCommandRunner({ maxOutputBytes: MAX_INSPECTION_OUTPUT });

export type ExactHelperInspection =
  | { status: "alive"; pids: number[] }
  | { status: "absent"; pids: [] }
  | { status: "unknown"; pids: [] };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match only the exact helper invocation. The helper may be unlinked, so its
 * argv[0] is intentionally the identity source; file existence is not liveness.
 * Any timeout, non-bounded output, or unparsable result is uncertainty, never
 * absence.
 */
export async function inspectExactHelper(
  helperPath: string,
  planPath: string,
  uid = process.getuid?.(),
  options: { command?: string } = {},
  signal?: AbortSignal,
): Promise<ExactHelperInspection> {
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) return { status: "unknown", pids: [] };
  const expected = `${resolve(helperPath)} --apply-update ${resolve(planPath)} --quiet`;
  const pattern = `^${escapeRegExp(expected)}$`;
  const command = options.command ?? "/usr/bin/pgrep";
  try {
    const result = await runInspection(
      command,
      ["-U", String(uid), "-f", pattern],
      INSPECTION_TIMEOUT_MS,
      signal,
    );
    if (result.stderr.trim() !== "") return { status: "unknown", pids: [] };
    if (result.exitCode === 1 && result.stdout.trim() === "") return { status: "absent", pids: [] };
    if (result.exitCode !== 0) return { status: "unknown", pids: [] };
    const values = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (values.length === 0) return { status: "absent", pids: [] };
    if (
      values.length > 64 ||
      values.some((value) => !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
    )
      return { status: "unknown", pids: [] };
    return { status: "alive", pids: values.map(Number) };
  } catch {
    return { status: "unknown", pids: [] };
  }
}
