import { spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandRunner } from "../../src/main/updater/verify";
import { writeBundleFixture } from "./updater";

const [mode, parent] = process.argv.slice(2);
if (!parent || !["control", "baseline", "cancel"].includes(mode ?? "")) {
  throw new Error("Expected control/baseline/cancel and a private fixture root");
}
const root = await mkdtemp(join(parent, "boundary-"));
const home = join(root, "home");
const data = join(root, "data");
const ready = join(root, "ready");
const gate = join(root, "gate");
const workerFile = resolve(import.meta.dir, "updater-boundary-worker.ts");
const relayFile = resolve(import.meta.dir, "a12-ps-relay.ts");
const originalNodeSpawn = childProcess.spawn;
const originalBunSpawn = Bun.spawn;
let worker: childProcess.ChildProcess | undefined;
let workerClosed = false;
let workerClose: Promise<void> | undefined;
let inspectionClosed = false;
let inspectionClose: Promise<void> | undefined;
let selected = false;
let granted = false;

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((part) => typeof part === "string");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function registration(command: unknown, args: unknown): args is string[] {
  return (
    !selected &&
    command === "/bin/ps" &&
    strings(args) &&
    worker?.pid !== undefined &&
    args[args.indexOf("-p") + 1] === String(worker.pid)
  );
}
function groupAbsent(): boolean {
  if (!worker?.pid || !workerClosed) return false;
  try {
    process.kill(-worker.pid, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true;
    throw error;
  }
}
function observeNodeInspection(child: childProcess.ChildProcess): void {
  inspectionClose = new Promise((resolveClose) =>
    child.once("close", () => {
      inspectionClosed = true;
      resolveClose();
    }),
  );
}

// Proxies preserve overloaded argument lists and native return/stream types.
// Only this worker's first registration command is delayed; cleanup probes are real.
const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(
  new Proxy(originalNodeSpawn, {
    apply(target, receiver, argv: unknown[]) {
      const [command, args, options] = argv;
      if (registration(command, args)) {
        selected = true;
        const probe = originalNodeSpawn(
          process.execPath,
          [relayFile, ready, gate, "/bin/ps", ...args],
          record(options) ? options : {},
        );
        observeNodeInspection(probe);
        return probe;
      }
      const result: unknown = Reflect.apply(target, receiver, argv);
      if (!(result instanceof childProcess.ChildProcess))
        throw new Error("Unexpected spawn result");
      if (
        strings(args) &&
        args.includes(workerFile) &&
        record(options) &&
        record(options.env) &&
        options.env.MCP_GATEWAY_UPDATE_GRANT === "1" &&
        typeof options.env.MCP_GATEWAY_UPDATE_RESULT === "string" &&
        options.env.MCP_GATEWAY_UPDATE_RESULT.startsWith(`${data}/`)
      ) {
        if (worker) throw new Error("Unexpected second fixture worker");
        worker = result;
        workerClose = new Promise((resolveClose) =>
          result.once("close", () => {
            workerClosed = true;
            resolveClose();
          }),
        );
        if (result.stdin)
          result.stdin.write = new Proxy(result.stdin.write, {
            apply(write, stream, values: unknown[]) {
              const chunk = values[0];
              if (
                (typeof chunk === "string" && chunk.includes("grant\n")) ||
                (Buffer.isBuffer(chunk) && chunk.toString("utf8").includes("grant\n"))
              )
                granted = true;
              return Reflect.apply(write, stream, values);
            },
          });
      }
      return result;
    },
  }),
);
Bun.spawn = new Proxy(originalBunSpawn, {
  apply(target, receiver, argv: unknown[]) {
    const [command, options] = argv;
    if (strings(command) && registration(command[0], command.slice(1))) {
      selected = true;
      // This production call uses ignore/pipe/pipe; forwarding its options preserves it.
      const probe = originalBunSpawn(
        [process.execPath, relayFile, ready, gate, ...command],
        record(options) ? options : {},
      );
      inspectionClose = probe.exited.then(() => {
        inspectionClosed = true;
      });
      return probe;
    }
    return Reflect.apply(target, receiver, argv);
  },
});

const runner: CommandRunner = async (command, args) => {
  const success = (stdout = "", stderr = "") => ({ stdout, stderr, exitCode: 0 });
  if (command.endsWith("plutil")) {
    if (args.includes("CFBundleIdentifier")) return success("dev.srvr.mcpgateway\n");
    if (args.includes("CFBundleVersion")) {
      const bundle = dirname(dirname(args.at(-1) ?? ""));
      const value = JSON.parse(
        await readFile(join(bundle, "Contents/Resources/version.json"), "utf8"),
      );
      return success(`${value.version}\n`);
    }
    return success("launcher\n");
  }
  if (command.endsWith("lipo")) return success("arm64\n");
  if (command.endsWith("codesign"))
    return args.includes("--display")
      ? success(
          "",
          "Identifier=dev.srvr.mcpgateway\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Example\n",
        )
      : success();
  throw new Error(`Unexpected synthetic verifier command: ${command}`);
};
async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) return true;
    await delay(20);
  } while (Date.now() < deadline);
  return false;
}
async function readyExists(): Promise<boolean> {
  try {
    await access(ready);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

const { UpdaterSafetyBoundary, UpdateBoundaryError } = await import(
  "../../src/main/updater/boundary"
);
const { ApplicationVerifier } = await import("../../src/main/updater/verify");
await mkdir(home, { recursive: true, mode: 0o700 });
await mkdir(data, { recursive: true, mode: 0o700 });
const boundary = new UpdaterSafetyBoundary({
  appBundlePath: writeBundleFixture(join(root, "Applications"), {
    version: "0.3.0",
    hash: "current1234",
  }),
  home,
  dataDirectory: data,
  channelRoot: join(home, "Library/Application Support/dev.srvr.mcpgateway/stable"),
  appDataDirectory: join(home, "Library/Application Support"),
  deadlineMs: 1_000,
  preparation: {
    command: process.execPath,
    args: [workerFile],
    cwd: resolve("."),
    env: { WORKER_SCENARIO: "no-update" },
  },
  verifier: new ApplicationVerifier(runner),
});
let settled = false;
const operation = boundary.checkForUpdate().then(
  (value) => {
    settled = true;
    return { kind: "success" as const, value };
  },
  (error: unknown) => {
    settled = true;
    return { kind: "error" as const, error };
  },
);
let before: unknown;
let fixtureError: Error | undefined;
try {
  if (!(await waitFor(readyExists, 3_000)))
    throw new Error("Registration relay did not become ready");
  if (mode === "control") {
    await writeFile(gate, "release\n", { mode: 0o600 });
    await operation;
    await inspectionClose;
    await workerClose;
  } else {
    if (mode === "cancel") boundary.cancel();
    if (!(await waitFor(() => workerClosed, 3_000))) throw new Error("Owned worker did not close");
    await waitFor(() => settled && inspectionClosed, 1_500);
  }
  const result = settled ? await operation : undefined;
  if (result?.kind === "error" && !(result.error instanceof UpdateBoundaryError))
    throw result.error;
  before = {
    workerAbsent: groupAbsent(),
    inspectionClosed,
    operationSettled: settled,
    granted,
    terminal:
      result?.kind === "success"
        ? result
        : result?.kind === "error" && result.error instanceof UpdateBoundaryError
          ? { kind: "error", code: result.error.code }
          : null,
  };
} catch (error) {
  fixtureError = error instanceof Error ? error : new Error(String(error));
} finally {
  // No deadline race authorizes deleting a live transaction. Unexpected cleanup
  // failure leaves the root available for inspection instead of concealing it.
  let cleanupError: Error | undefined;
  try {
    await writeFile(gate, "cleanup\n", { mode: 0o600 });
    boundary.cancel();
    await operation;
    await inspectionClose;
    await workerClose;
    await boundary.abandonPrepared();
    if (!groupAbsent() || !inspectionClosed)
      cleanupError = new Error(
        `Fixture cleanup remains unconfirmed: ${JSON.stringify({ workerPid: worker?.pid, workerClosed, selected, inspectionClosed, settled, outcome: await operation })}`,
      );
    else await rm(root, { recursive: true });
  } finally {
    spawnSpy.mockRestore();
    Bun.spawn = originalBunSpawn;
  }
  if (cleanupError && !fixtureError) fixtureError = cleanupError;
}
if (fixtureError) throw fixtureError;
console.log(JSON.stringify({ mode, before, cleaned: true, intercepted: selected }));
