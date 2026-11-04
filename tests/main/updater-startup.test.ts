import { test as bunTest, expect } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCommandRunner } from "../../src/core/command";
import { UpdaterSafetyBoundary } from "../../src/main/updater/boundary";
import { TransactionLease } from "../../src/main/updater/transaction";
import { ApplicationVerifier } from "../../src/main/updater/verify";
import { alive, eventually } from "../core/helpers";
import { writeBundleFixture } from "../fixtures/updater";

const test = bunTest.skipIf(process.platform !== "darwin");
test("startup cancellation joins the verification child and holds cross-process writer exclusion", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-startup-"));
  const home = join(root, "home");
  const dataDirectory = join(root, "data");
  const channelRoot = join(home, "Library/Application Support/dev.srvr.mcpgateway/stable");
  const pidPath = join(root, "pid");
  await mkdir(dataDirectory, { mode: 0o700 });
  const appBundlePath = writeBundleFixture(root);
  let release = () => {};
  const closeGate = new Promise<void>((done) => {
    release = done;
  });
  let childClosed = false;
  let signalSeen: AbortSignal | undefined;
  const run = createCommandRunner({
    start: () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)',
          pidPath,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const events = new EventEmitter();
      child.once("error", (error) => events.emit("error", error));
      child.once("close", (code) => {
        childClosed = true;
        void closeGate.then(() => events.emit("close", code));
      });
      return {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        kill: () => child.kill("SIGKILL"),
        on: events.on.bind(events),
      };
    },
  });
  const boundary = new UpdaterSafetyBoundary({
    appBundlePath,
    dataDirectory,
    channelRoot,
    home,
    appDataDirectory: join(home, "Library/Application Support"),
    verifier: new ApplicationVerifier((command, args, timeout, signal) => {
      signalSeen = signal;
      return run(command, args, timeout, signal);
    }),
  });
  const pending = boundary.reconcile();
  const outcome = pending.then(
    (value) => value,
    (error: unknown) => error,
  );
  let competing: TransactionLease | undefined;
  let abandonment: Promise<void> | undefined;
  let abandoned = false;
  try {
    expect(boundary.reconcile()).toBe(pending);
    await eventually(async () => Number(await readFile(pidPath, "utf8").catch(() => "0")) > 0);
    const pid = Number(await readFile(pidPath, "utf8"));
    await expect(
      TransactionLease.acquire({ channelRoot, dataDirectory, appBundlePath }).then((lease) => {
        competing = lease;
        return lease;
      }),
    ).rejects.toMatchObject({ code: "busy" });
    await expect(boundary.checkForUpdate()).rejects.toMatchObject({ code: "busy" });
    abandonment = boundary.abandonPrepared().then(() => {
      abandoned = true;
    });
    expect(boundary.abandonPrepared()).toBeDefined();
    await eventually(() => childClosed);
    expect(signalSeen?.aborted).toBe(true);
    expect(alive(pid)).toBe(false);
    expect(abandoned).toBe(false);
    await expect(
      TransactionLease.acquire({ channelRoot, dataDirectory, appBundlePath }),
    ).rejects.toMatchObject({ code: "busy" });
    release();
    await abandonment;
    expect(await outcome).toMatchObject({ code: "cancelled" });
    const next = await TransactionLease.acquire({ channelRoot, dataDirectory, appBundlePath });
    await next.releaseUncommitted();
  } finally {
    boundary.cancel();
    release();
    await outcome;
    await abandonment;
    await competing?.releaseUncommitted();
    await boundary.abandonPrepared();
    await rm(root, { recursive: true, force: true });
  }
});
