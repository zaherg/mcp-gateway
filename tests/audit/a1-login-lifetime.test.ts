import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { command } from "../../scripts/toolchain";

/**
 * A1 reproduction: the native login-library owner must own its closed state.
 *
 * The wrapper returned by `openLoginManager` has a `close()` method, but after
 * it releases the native library the public status-code and shortcut wrappers
 * can still invoke native symbols. The intended contract is:
 *
 *   - close() is idempotent and releases the native library exactly once.
 *   - After closure, read-only `manager.status()` returns the retained status
 *     without FFI.
 *   - `statusCode()` and shortcut wrappers refuse closed calls with an explicit
 *     error instead of invoking an unloaded native seam.
 *   - `setEnabled()` refuses closed mutations with an explicit error.
 *
 * Platform prerequisite: macOS arm64 with a working `xcrun clang` toolchain.
 * The synthetic dylib uses Bun FFI; on unsupported platforms the test is skipped
 * and reports the native gap.
 */

const sourceDylib = join(import.meta.dir, "../fixtures/login-counter.c");
const fixture = join(import.meta.dir, "../fixtures/login-after-close.ts");
const buildDir = resolve(
  import.meta.dir,
  "../../.cache/src-audit-remediation/20261103T205907Z/a1-fixtures",
);
const dylibPath = join(buildDir, "login-counter.dylib");

let prerequisite = false;

async function counterLines(path: string): Promise<string[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  await mkdir(buildDir, { recursive: true, mode: 0o700 });
  await command([
    "/usr/bin/xcrun",
    "clang",
    "-dynamiclib",
    "-fobjc-arc",
    "-mmacosx-version-min=13.0",
    sourceDylib,
    "-o",
    dylibPath,
  ]);
  prerequisite = true;
});

afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true });
});

async function runFixture(
  mode: "control" | "after-close" | "repeated-close",
  counterPath: string,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null | number;
}> {
  const child = Bun.spawn([process.execPath, fixture, dylibPath, counterPath, mode], {
    env: { ...process.env, MCP_LOGIN_COUNTER_PATH: counterPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("fixture did not finish within deadline")), 5_000);
    });
    const [stdout, stderr, exit] = await Promise.race([
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      deadline,
    ]);
    clearTimeout(timer);
    return { stdout, stderr, exitCode: exit, signal: child.signalCode };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

async function makeCounter(): Promise<string> {
  const path = join(buildDir, `counter-${crypto.randomUUID()}.txt`);
  await writeFile(path, "", { mode: 0o600 });
  return path;
}

function lines(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const [key, ...rest] = line.trim().split(" ");
    if (key) result[key] = rest.join(" ");
  }
  return result;
}

const testIfNative = test.skipIf(process.platform !== "darwin" || process.arch !== "arm64");

testIfNative(
  "A1 control: exact native-call inventory while the library is open",
  async () => {
    if (!prerequisite) throw new Error("macOS arm64 clang prerequisite unavailable");
    const counterPath = await makeCounter();
    const result = await runFixture("control", counterPath);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
    const out = lines(result.stdout);
    expect(out["status-enabled"]).toBe("true");
    expect(out["set-enabled"]).toBe("true");
    expect(out.code).toBe("1");
    expect(out.completed).toBe("");

    const calls = await counterLines(counterPath);
    // The control exercises exactly: load, status, status, set, status, status,
    // status, close-shortcut, quit-shortcut, unload.
    expect(calls).toEqual([
      "load",
      "status",
      "status",
      "set",
      "status",
      "status",
      "status",
      "close-shortcut",
      "quit-shortcut",
      "unload",
    ]);
  },
  15_000,
);

testIfNative(
  "A1 reproduction: public wrappers invoke native symbols after close and crash",
  async () => {
    if (!prerequisite) throw new Error("macOS arm64 clang prerequisite unavailable");
    const counterPath = await makeCounter();
    const result = await runFixture("after-close", counterPath);

    // Intended contract: the child exits cleanly with explicit closed errors, the
    // retained manager.status() value, exactly one unload, and zero post-close
    // native symbol calls. On the unchanged baseline the first closed native
    // symbol access crashes the process.
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
    const out = lines(result.stdout);
    expect(out["retained-enabled"]).toBe("true");
    expect(out["statusCode-error"]).toBe("closed");
    expect(out["closeShortcut-error"]).toBe("closed");
    expect(out["quitShortcut-error"]).toBe("closed");
    expect(out["setEnabled-error"]).toBe("closed");
    expect(out["retained-after"]).toBe("true");
    expect(out.completed).toBe("");

    const calls = await counterLines(counterPath);
    // After the fix: load, pre-close status, unload, then no further native calls.
    expect(calls).toEqual(["load", "status", "unload"]);
  },
  15_000,
);

testIfNative(
  "A1: repeated close is idempotent and releases exactly once",
  async () => {
    if (!prerequisite) throw new Error("macOS arm64 clang prerequisite unavailable");
    const counterPath = await makeCounter();
    const result = await runFixture("repeated-close", counterPath);

    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(0);
    const out = lines(result.stdout);
    expect(out["statusCode-error"]).toBe("closed");
    expect(out.completed).toBe("");

    const calls = await counterLines(counterPath);
    // Three close() calls must produce exactly one unload. Pre-close status is
    // legitimate; no native symbol may be called after unload.
    expect(calls.filter((c) => c === "unload")).toHaveLength(1);
    const afterUnload = calls.slice(calls.lastIndexOf("unload") + 1);
    expect(afterUnload).toEqual([]);
  },
  15_000,
);
