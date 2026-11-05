import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCommandRunner, runCommand } from "../../src/core/command";
import { inspectExactHelper } from "../../src/main/updater/process-inspector";
import { alive, eventually } from "../core/helpers";

async function tempRoot(): Promise<string> {
  await mkdir(resolve(".cache"), { recursive: true });
  return mkdtemp(resolve(".cache/a12-command-"));
}

test.each([false, true])(
  "termination refusal=%s retains ownership until actual close",
  async (refused) => {
    const events = new EventEmitter();
    const output = new EventEmitter();
    let kills = 0;
    const run = createCommandRunner({
      maxOutputBytes: 1,
      start: () => ({
        pid: 123,
        stdout: output,
        stderr: null,
        on: events.on.bind(events),
        kill: () => {
          kills++;
          if (refused) throw new Error("Synthetic termination refusal");
          return true;
        },
      }),
    });
    let settled = false;
    const pending = run("synthetic", [], 5000).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      output.emit("data", Buffer.from("xx"));
      await Promise.resolve();
      expect(kills).toBe(1);
      expect(settled).toBe(false);
      events.emit("close", null);
      expect(await pending).toBeInstanceOf(Error);
      expect(settled).toBe(true);
    } finally {
      events.emit("close", null);
      await pending;
    }
  },
);

test("cancels before spawn and never creates a child", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 60_000, controller.signal),
  ).rejects.toThrow(/cancelled/);
});

test("cancels a hanging command and reaps the child before returning", async () => {
  const root = await tempRoot();
  const pidFile = join(root, "pid");
  try {
    const controller = new AbortController();
    const pending = runCommand(
      process.execPath,
      [
        "-e",
        `require("node:fs").writeFileSync("${pidFile}", String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      60_000,
      controller.signal,
    );
    await eventually(async () => {
      try {
        return Number(await Bun.file(pidFile).text()) > 0;
      } catch {
        return false;
      }
    });
    const pid = Number(await Bun.file(pidFile).text());
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    await eventually(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("times out a hanging command and reaps the child before returning", async () => {
  const root = await tempRoot();
  const pidFile = join(root, "pid");
  try {
    const pending = runCommand(
      process.execPath,
      [
        "-e",
        `require("node:fs").writeFileSync("${pidFile}", String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      100,
    );
    await eventually(async () => {
      try {
        return Number(await Bun.file(pidFile).text()) > 0;
      } catch {
        return false;
      }
    });
    const pid = Number(await Bun.file(pidFile).text());
    await expect(pending).rejects.toThrow(/timed out/);
    await eventually(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  { state: "exiting", bytes: 128 * 1024, limit: undefined, timeoutMs: 60_000 },
  { state: "running", bytes: 64, limit: 16, timeoutMs: 500 },
])(
  "output overflow rejects and reaps the $state child before its deadline",
  async ({ state, bytes, limit, timeoutMs }) => {
    const root = await tempRoot();
    const pidFile = join(root, "pid");
    const controller = new AbortController();
    const run = limit === undefined ? runCommand : createCommandRunner({ maxOutputBytes: limit });
    const pending = run(
      process.execPath,
      [
        "-e",
        'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); process.stdout.write("x".repeat(Number(process.argv[2]))); if (process.argv[3] === "running") setInterval(() => {}, 1000)',
        pidFile,
        String(bytes),
        state,
      ],
      timeoutMs,
      controller.signal,
    );
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      expect(await outcome).toMatchObject({ message: "Command output exceeded the limit" });
      const pid = Number(await Bun.file(pidFile).text());
      expect(alive(pid)).toBe(false);
    } finally {
      controller.abort();
      await outcome;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("process inspector returns absent for confirmed empty output", async () => {
  const root = await tempRoot();
  try {
    const empty = join(root, "empty-inspector");
    await writeFile(empty, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const result = await inspectExactHelper(
      join(root, "helper"),
      join(root, "plan.json"),
      process.getuid?.(),
      {
        command: empty,
      },
    );
    expect(result).toEqual({ status: "absent", pids: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process inspector treats stderr, malformed, and oversized output as unknown", async () => {
  const root = await tempRoot();
  try {
    const stderr = join(root, "stderr-inspector");
    const malformed = join(root, "malformed-inspector");
    const oversized = join(root, "oversized-inspector");
    await writeFile(stderr, "#!/bin/sh\necho error >&2; exit 0\n", { mode: 0o700 });
    await writeFile(malformed, "#!/bin/sh\necho not-a-pid\n", { mode: 0o700 });
    await writeFile(
      oversized,
      "#!/bin/sh\npython3 -c 'print(\"1\" * (16 * 1024))' 2>/dev/null || perl -e 'print \"1\" x (16 * 1024)'\n",
      { mode: 0o700 },
    );
    expect(
      await inspectExactHelper(join(root, "helper"), join(root, "plan.json"), process.getuid?.(), {
        command: stderr,
      }),
    ).toEqual({ status: "unknown", pids: [] });
    expect(
      await inspectExactHelper(join(root, "helper"), join(root, "plan.json"), process.getuid?.(), {
        command: malformed,
      }),
    ).toEqual({ status: "unknown", pids: [] });
    expect(
      await inspectExactHelper(join(root, "helper"), join(root, "plan.json"), process.getuid?.(), {
        command: oversized,
      }),
    ).toEqual({ status: "unknown", pids: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process inspector returns unknown and reaps an aborted probe", async () => {
  const root = await tempRoot();
  const pidFile = join(root, "pid");
  const hanging = join(root, "hanging-inspector");
  try {
    await writeFile(
      hanging,
      `#!/bin/sh\nexec "${process.execPath}" -e 'require("node:fs").writeFileSync("${pidFile}", String(process.pid)); setInterval(() => {}, 1000);'\n`,
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const pending = inspectExactHelper(
      join(root, "helper"),
      join(root, "plan.json"),
      process.getuid?.(),
      { command: hanging },
      controller.signal,
    );
    await eventually(async () => {
      try {
        return Number(await Bun.file(pidFile).text()) > 0;
      } catch {
        return false;
      }
    });
    const pid = Number(await Bun.file(pidFile).text());
    controller.abort();
    expect(await pending).toEqual({ status: "unknown", pids: [] });
    await eventually(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
