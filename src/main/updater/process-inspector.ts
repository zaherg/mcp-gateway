import { resolve } from "node:path";

const MAX_INSPECTION_OUTPUT = 8192;
const INSPECTION_TIMEOUT_MS = 3_000;

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
): Promise<ExactHelperInspection> {
  if (!Number.isSafeInteger(uid) || (uid as number) < 0) return { status: "unknown", pids: [] };
  const expected = `${resolve(helperPath)} --apply-update ${resolve(planPath)} --quiet`;
  const pattern = `^${escapeRegExp(expected)}$`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const timer = setTimeout(() => {
    child?.kill("SIGKILL");
  }, INSPECTION_TIMEOUT_MS);
  try {
    const spawned = Bun.spawn(
      [options.command ?? "/usr/bin/pgrep", "-U", String(uid), "-f", pattern],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child = spawned;
    const [stdout, stderr, code] = await Promise.all([
      new Response(spawned.stdout as ReadableStream<Uint8Array>).text(),
      new Response(spawned.stderr as ReadableStream<Uint8Array>).text(),
      spawned.exited,
    ]);
    if (
      Buffer.byteLength(stdout) > MAX_INSPECTION_OUTPUT ||
      Buffer.byteLength(stderr) > MAX_INSPECTION_OUTPUT
    )
      return { status: "unknown", pids: [] };
    if (stderr.trim() !== "") return { status: "unknown", pids: [] };
    if (code === 1 && stdout.trim() === "") return { status: "absent", pids: [] };
    if (code !== 0) return { status: "unknown", pids: [] };
    const values = stdout.trim().split(/\s+/).filter(Boolean);
    if (values.length === 0) return { status: "absent", pids: [] };
    if (values.length > 64 || values.some((value) => !/^[1-9][0-9]*$/.test(value)))
      return { status: "unknown", pids: [] };
    return { status: "alive", pids: values.map(Number) };
  } catch {
    return { status: "unknown", pids: [] };
  } finally {
    clearTimeout(timer);
  }
}
