import { expect, test } from "bun:test";
import { ChildProcess } from "node:child_process";
import {
  type BackendGroup,
  BackendProcesses,
  inspectBackendGroup,
} from "../../src/core/backend-processes";
import { eventually } from "./helpers";

function fixture(
  initial: BackendGroup = { status: "present", members: [{ pid: 54321, start: "original" }] },
) {
  const child = new ChildProcess();
  let exited = false;
  Object.defineProperties(child, {
    pid: { value: 54321 },
    exitCode: { get: () => (exited ? 0 : null) },
    signalCode: { value: null },
  });
  let state = initial;
  let refused = false;
  const signals: string[] = [];
  const errors: unknown[][] = [];
  const owner = new BackendProcesses(
    {
      info() {},
      debug() {},
      warn() {},
      error: (...args) => {
        errors.push(args);
      },
    },
    {
      inspect: async () => state,
      signal: (_pgid, signal) => {
        signals.push(signal);
        if (refused)
          throw Object.assign(new Error("Synthetic permission refusal"), { code: "EPERM" });
      },
      pollMs: 2,
      graceMs: 0,
    },
  );
  const stop = owner.own(child);
  return {
    child,
    owner,
    stop,
    signals,
    errors,
    state(value: BackendGroup) {
      state = value;
    },
    refuse(value: boolean) {
      refused = value;
    },
    exit() {
      exited = true;
      child.emit("exit", 0, null);
    },
    async cleanup() {
      state = { status: "absent" };
      exited = true;
      child.emit("exit", 0, null);
      await owner.close();
    },
  };
}

const posixTest = test.skipIf(process.platform === "win32");
for (const refused of [false, true]) {
  posixTest(
    `SIGKILL delivery/refusal=${refused} does not release ownership without absence`,
    async () => {
      const f = fixture();
      let done = false;
      f.refuse(refused);
      const pending = f.owner.close().then(() => {
        done = true;
      });
      try {
        await eventually(() => f.signals.length > 1);
        expect(done).toBe(false);
        expect(f.stop()).toBe(f.stop());
        expect(f.signals.every((signal) => signal === "SIGKILL")).toBe(true);
        f.refuse(false);
        f.state({ status: "absent" });
        await Bun.sleep(10);
        expect(done).toBe(false);
        f.exit();
        await pending;
        expect(done).toBe(true);
      } finally {
        await f.cleanup();
        await pending;
      }
    },
  );
}

posixTest("a known surviving descendant remains owned after leader exit", async () => {
  const f = fixture({
    status: "present",
    members: [
      { pid: 54321, start: "original" },
      { pid: 54322, start: "descendant" },
    ],
  });
  try {
    await Promise.resolve();
    f.state({ status: "present", members: [{ pid: 54322, start: "descendant" }] });
    f.exit();
    await eventually(() => f.signals.length > 0);
    expect(f.signals).toContain("SIGKILL");
  } finally {
    await f.cleanup();
  }
});

for (const state of [
  { status: "unknown" },
  { status: "present", members: [{ pid: 54322, start: "recycled" }] },
] satisfies BackendGroup[]) {
  posixTest(`unproven or recycled group (${state.status}) is never signalled`, async () => {
    const f = fixture({
      status: "present",
      members: [
        { pid: 54321, start: "original" },
        { pid: 54322, start: "descendant" },
      ],
    });
    let done = false;
    try {
      await Promise.resolve();
      f.state(state);
      f.exit();
      const pending = f.stop().then(() => {
        done = true;
      });
      await eventually(() => f.errors.length === 1);
      expect(f.signals).toEqual([]);
      expect(done).toBe(false);
      f.state({ status: "absent" });
      await pending;
    } finally {
      await f.cleanup();
    }
  });
}

posixTest("spawn failure owns no group and waits for close", async () => {
  const child = new ChildProcess();
  const f = fixture();
  let done = false;
  const stop = f.owner.own(child);
  const pending = stop().then(() => {
    done = true;
  });
  try {
    await Promise.resolve();
    expect(done).toBe(false);
    child.emit("close", -1, null);
    await pending;
  } finally {
    child.emit("close", -1, null);
    await f.cleanup();
  }
});

posixTest("failed non-process cleanup stays refused on repeated close", async () => {
  const f = fixture();
  const fail = f.owner.track(async () => {
    throw new Error("Synthetic cleanup failure");
  });
  await expect(fail()).rejects.toThrow("Synthetic cleanup failure");
  f.state({ status: "absent" });
  f.exit();
  await expect(f.owner.close()).rejects.toThrow("Synthetic cleanup failure");
  await expect(f.owner.close()).rejects.toThrow("Synthetic cleanup failure");
});

test("group inspection distinguishes absent, permission-refused and malformed output", async () => {
  for (const result of [
    { stdout: "", stderr: "", exitCode: 1, status: "absent" },
    { stdout: "", stderr: "refused", exitCode: 1, status: "unknown" },
    { stdout: "1e3", stderr: "", exitCode: 0, status: "unknown" },
    { stdout: "9007199254740993", stderr: "", exitCode: 0, status: "unknown" },
  ] as const) {
    expect(await inspectBackendGroup(54321, async () => result)).toEqual({ status: result.status });
  }
});
