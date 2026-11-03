import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertStagingCapacity,
  cleanupInterruptedStaging,
  runOwnedWorker,
} from "../../src/main/updater/process";
import { UpdaterStateError } from "../../src/main/updater/storage";
import { eventually } from "../core/helpers";

const WORKER = resolve("tests/fixtures/updater-owned-worker.ts");

async function setup(): Promise<{ root: string; data: string; channel: string; result: string }> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-process-"));
  const data = join(root, "data");
  const channel = join(root, "home/Library/Application Support/dev.srvr.mcpgateway/stable");
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(join(channel, "self-extraction"), { recursive: true, mode: 0o700 });
  return { root, data, channel, result: join(root, "worker-result.json") };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const managed of ["staging", "recovery", "temporary", "ancestor"] as const) {
  test(`cleanup rejects a symlinked ${managed} root before deleting any files`, async () => {
    const fixture = await setup();
    try {
      const staging = join(fixture.channel, "self-extraction");
      const target = join(fixture.root, "unrelated");
      await mkdir(target, { mode: 0o700 });
      const names = ["notes.tar", ".target123456.0123456789abcdef0123456789abcdef.frozen"];
      for (const name of names) await writeFile(join(target, name), "keep bytes\n");
      for (const name of [".previous-safe.partial.app", "run-abcdef"]) {
        await mkdir(join(target, name));
        await writeFile(join(target, name, "notes"), "keep nested bytes\n");
      }
      const ownStaging = join(staging, names[1]);
      await writeFile(ownStaging, "retain until all roots admitted\n");
      const link =
        managed === "staging"
          ? staging
          : join(
              fixture.data,
              managed === "ancestor"
                ? "updates"
                : `updates/${managed === "recovery" ? "recovery" : "tmp"}`,
            );
      await mkdir(join(fixture.data, "updates"), { recursive: true, mode: 0o700 });
      if (managed === "staging") await rm(staging, { recursive: true });
      if (managed === "ancestor") await rm(link, { recursive: true });
      await symlink(target, link);
      await expect(
        cleanupInterruptedStaging({ channelRoot: fixture.channel, dataDirectory: fixture.data }),
      ).rejects.toThrow();
      expect((await readdir(target)).sort()).toEqual(
        [...names, ".previous-safe.partial.app", "run-abcdef"].sort(),
      );
      for (const name of names)
        expect(await readFile(join(target, name), "utf8")).toBe("keep bytes\n");
      for (const name of [".previous-safe.partial.app", "run-abcdef"])
        expect(await readFile(join(target, name, "notes"), "utf8")).toBe("keep nested bytes\n");
      if (managed !== "staging")
        expect(await readFile(ownStaging, "utf8")).toBe("retain until all roots admitted\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("owned worker settlement persistence errors are not reported as successful completion", async () => {
  const fixture = await setup();
  const failure = new Error("synthetic registration persistence failure");
  try {
    await expect(
      runOwnedWorker({
        command: process.execPath,
        args: [WORKER],
        cwd: resolve("."),
        env: {
          PATH: "/usr/bin:/bin",
          HOME: fixture.root,
          WORKER_MODE: "complete",
          WORKER_RESULT_PATH: fixture.result,
          WORKER_CHANNEL_ROOT: fixture.channel,
        },
        deadlineMs: 5_000,
        resultPath: fixture.result,
        requireGrant: true,
        onSettled: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runs the unchanged worker protocol in an owned process and validates its result", async () => {
  const fixture = await setup();
  try {
    const outcome = await runOwnedWorker({
      command: process.execPath,
      args: [WORKER],
      cwd: resolve("."),
      env: {
        PATH: "/usr/bin:/bin",
        HOME: fixture.root,
        WORKER_MODE: "complete",
        WORKER_RESULT_PATH: fixture.result,
        WORKER_CHANNEL_ROOT: fixture.channel,
      },
      deadlineMs: 5_000,
      resultPath: fixture.result,
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toEqual({
      status: "ready",
      selected: { version: "0.3.1", hash: "target123456" },
      channelRoot: fixture.channel,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects malformed worker output without exposing it", async () => {
  const fixture = await setup();
  try {
    const outcome = await runOwnedWorker({
      command: process.execPath,
      args: [WORKER],
      cwd: resolve("."),
      env: {
        PATH: "/usr/bin:/bin",
        HOME: fixture.root,
        WORKER_MODE: "malformed",
        WORKER_RESULT_PATH: fixture.result,
      },
      deadlineMs: 5_000,
      resultPath: fixture.result,
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.result).toBeUndefined();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("kills the complete owned worker tree at the deadline and reports timeout", async () => {
  const fixture = await setup();
  const pidFile = join(fixture.root, "child.pid");
  try {
    const started = Date.now();
    const outcome = await runOwnedWorker({
      command: process.execPath,
      args: [WORKER],
      cwd: resolve("."),
      env: {
        PATH: "/usr/bin:/bin",
        HOME: fixture.root,
        WORKER_MODE: "hang",
        WORKER_RESULT_PATH: fixture.result,
        WORKER_CHILD_PID_FILE: pidFile,
      },
      deadlineMs: 250,
      resultPath: fixture.result,
    });
    expect(outcome.status).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    const childPid = Number(await readFile(pidFile, "utf8"));
    await eventually(() => !alive(childPid), 3_000);
    expect(alive(childPid)).toBe(false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancels an owned worker and its descendants without waiting for the network deadline", async () => {
  const fixture = await setup();
  const pidFile = join(fixture.root, "child.pid");
  const controller = new AbortController();
  try {
    const pending = runOwnedWorker({
      command: process.execPath,
      args: [WORKER],
      cwd: resolve("."),
      env: {
        PATH: "/usr/bin:/bin",
        HOME: fixture.root,
        WORKER_MODE: "hang",
        WORKER_RESULT_PATH: fixture.result,
        WORKER_CHILD_PID_FILE: pidFile,
      },
      deadlineMs: 60_000,
      resultPath: fixture.result,
      signal: controller.signal,
    });
    await eventually(async () => {
      try {
        return Number(await readFile(pidFile, "utf8")) > 0;
      } catch {
        return false;
      }
    }, 3_000);
    const childPid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    await eventually(() => !alive(childPid), 3_000);
    expect(alive(childPid)).toBe(false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cleans only known interrupted staging files and stale owned run directories", async () => {
  const fixture = await setup();
  try {
    const staging = join(fixture.channel, "self-extraction");
    const known = [
      ".target123456.0123456789abcdef0123456789abcdef.tar.zst.partial",
      "target123456.tar.0123456789abcdef0123456789abcdef.partial",
      ".0123456789abcdef0123456789abcdef.1.current1234.patch.partial",
      ".target123456.0123456789abcdef0123456789abcdef.frozen",
    ];
    const preserved = ["target123456.tar", ".electrobun-prepared-update.json", "unrelated.txt"];
    for (const name of [...known, ...preserved])
      await writeFile(join(staging, name), "fixture", { mode: 0o600 });
    const runs = join(fixture.data, "updates/tmp");
    const stale = join(runs, "run-abcdef");
    await mkdir(stale, { recursive: true, mode: 0o700 });
    await writeFile(join(stale, "worker-result.json"), "{}", { mode: 0o600 });
    const active = join(runs, "run-active1");
    await mkdir(active, { recursive: true, mode: 0o700 });
    const removed = await cleanupInterruptedStaging({
      channelRoot: fixture.channel,
      dataDirectory: fixture.data,
      activeRunDirectory: active,
    });
    expect(removed).toBe(5);
    for (const name of known) await expect(readFile(join(staging, name))).rejects.toThrow();
    for (const name of preserved)
      expect(await readFile(join(staging, name), "utf8")).toBe("fixture");
    expect(await readdir(runs)).toEqual(["run-active1"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an already-cancelled owned worker does not create a child", async () => {
  const fixture = await setup();
  const marker = join(fixture.root, "started");
  const controller = new AbortController();
  controller.abort();
  try {
    const outcome = await runOwnedWorker({
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)},"started")`],
      cwd: resolve("."),
      env: { PATH: "/usr/bin:/bin", HOME: fixture.root },
      deadlineMs: 5_000,
      resultPath: fixture.result,
      signal: controller.signal,
    });
    expect(outcome.status).toBe("cancelled");
    await expect(readFile(marker)).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("enforces an inherited file-size limit before and during owned worker writes", async () => {
  const fixture = await setup();
  const output = join(fixture.root, "large.bin");
  try {
    const outcome = await runOwnedWorker({
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(output)}, Buffer.alloc(1025, 65))`,
      ],
      cwd: resolve("."),
      env: { PATH: "/usr/bin:/bin", HOME: fixture.root },
      deadlineMs: 5_000,
      resultPath: fixture.result,
      fileSizeLimitBytes: 1024,
    });
    expect(outcome.status).not.toBe("completed");
    const size = await stat(output)
      .then((info) => info.size)
      .catch(() => 0);
    expect(size).toBe(1024);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses preparation when the free-space reserve cannot be satisfied", async () => {
  const fixture = await setup();
  try {
    await expect(
      assertStagingCapacity(fixture.channel, Number.MAX_SAFE_INTEGER),
    ).rejects.toBeInstanceOf(UpdaterStateError);
    await expect(assertStagingCapacity(fixture.channel, 1)).resolves.toBeUndefined();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("reclaims abandoned recovery partial directories only", async () => {
  const fixture = await setup();
  try {
    const recovery = join(fixture.data, "updates/recovery");
    const partial = join(recovery, ".previous-0.3.0-current1234-deadbeef.partial.app");
    const productionPartial = join(recovery, ".0.3.0-current1234-0123456789abcdef.partial.app");
    const retained = join(recovery, "previous-0.3.0-current1234-deadbeef.app");
    await mkdir(partial, { recursive: true, mode: 0o700 });
    await mkdir(productionPartial, { recursive: true, mode: 0o700 });
    await mkdir(retained, { recursive: true, mode: 0o700 });
    expect(
      await cleanupInterruptedStaging({
        channelRoot: fixture.channel,
        dataDirectory: fixture.data,
      }),
    ).toBe(2);
    expect(await readdir(recovery)).toEqual(["previous-0.3.0-current1234-deadbeef.app"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("abort raised during owned-worker setup cannot launch a detached child", async () => {
  const fixture = await setup();
  const marker = join(fixture.root, "started-during-setup");
  const controller = new AbortController();
  try {
    const pending = runOwnedWorker({
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)},"started")`],
      cwd: resolve("."),
      env: { PATH: "/usr/bin:/bin", HOME: fixture.root },
      deadlineMs: 5_000,
      resultPath: fixture.result,
      signal: controller.signal,
    });
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    await expect(readFile(marker)).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fail-closed limiter setup rejects an invalid byte limit before spawning", async () => {
  const fixture = await setup();
  const marker = join(fixture.root, "limit-invalid-started");
  try {
    await expect(
      runOwnedWorker({
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)},"started")`],
        cwd: resolve("."),
        env: { PATH: "/usr/bin:/bin", HOME: fixture.root },
        deadlineMs: 5_000,
        resultPath: fixture.result,
        fileSizeLimitBytes: 0,
      }),
    ).rejects.toBeInstanceOf(UpdaterStateError);
    expect(await readFile(marker).catch(() => null)).toBeNull();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("requires a persisted registration callback before granting the owned worker", async () => {
  const fixture = await setup();
  let registered = false;
  let granted = false;
  try {
    const outcome = await runOwnedWorker({
      command: process.execPath,
      args: [WORKER],
      cwd: resolve("."),
      env: {
        PATH: "/usr/bin:/bin",
        HOME: fixture.root,
        WORKER_MODE: "complete",
        WORKER_RESULT_PATH: fixture.result,
        WORKER_CHANNEL_ROOT: fixture.channel,
      },
      deadlineMs: 5_000,
      resultPath: fixture.result,
      requireGrant: true,
      onRegistered: async () => {
        expect(granted).toBe(false);
        registered = true;
      },
      onGranted: () => {
        expect(registered).toBe(true);
        granted = true;
      },
    });
    expect(outcome.status).toBe("completed");
    expect(granted).toBe(true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
