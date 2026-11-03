import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { writeBundleFixture } from "./updater";

let kills = 0;
let child = Object.assign(new EventEmitter(), {
  pid: 12345 as number | undefined,
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  kill: () => {
    kills++;
    return true;
  },
});
const { createCommandRunner } = await import("../../src/main/updater/verify");
const runCommand = createCommandRunner(() => child);
const { UpdaterSafetyBoundary } = await import("../../src/main/updater/boundary");
const { TransactionLease, readLease } = await import("../../src/main/updater/transaction");
const root = await mkdtemp(resolve(".cache/updater-command-close-"));
const home = join(root, "home");
const channel = join(home, "Library/Application Support/dev.srvr.mcpgateway/stable");
const data = join(root, "data");
const owned: Promise<unknown>[] = [];
let boundary: InstanceType<typeof UpdaterSafetyBoundary> | undefined;
try {
  await mkdir(data, { recursive: true, mode: 0o700 });
  const app = writeBundleFixture(join(root, "apps"), { version: "0.3.0", hash: "current1234" });
  boundary = new UpdaterSafetyBoundary({
    home,
    channelRoot: channel,
    appDataDirectory: join(home, "Library/Application Support"),
    appBundlePath: app,
    dataDirectory: data,
    runner: runCommand,
  });
  let checked = false;
  let abandoned = false;
  const checking = boundary.checkForUpdate().catch((error) => {
    checked = true;
    assert.equal(error.code, "cancelled");
  });
  owned.push(checking);
  void Promise.allSettled([checking]);
  const deadline = Date.now() + 2000;
  while (!child.listenerCount("error")) {
    if (Date.now() > deadline) throw new Error(`No command child; operation settled=${checked}`);
    await Bun.sleep(1);
  }
  boundary.cancel();
  const abandonment = boundary.abandonPrepared().then(() => {
    abandoned = true;
  });
  owned.push(abandonment);
  void Promise.allSettled([abandonment]);
  child.emit("error", new Error("started child error"));
  await Bun.sleep(2100);
  assert.equal(kills, 1);
  assert.equal(checked, false);
  assert.equal(abandoned, false);
  assert.ok(await readLease(channel));
  await assert.rejects(
    TransactionLease.acquire({
      channelRoot: channel,
      dataDirectory: data,
      appBundlePath: join(root, "App.app"),
    }),
  );
  child.emit("close", null);
  await Promise.all([checking, abandonment]);
  assert.equal(checked, true);
  assert.equal(abandoned, true);
  assert.equal(await readLease(channel), undefined);
  const next = await TransactionLease.acquire({
    channelRoot: channel,
    dataDirectory: data,
    appBundlePath: join(root, "App.app"),
  });
  await next.releaseUncommitted();
  child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {
      throw new Error("must not kill unstarted process");
    },
  });
  const spawnFailure = runCommand("not-started", [], 10000);
  owned.push(spawnFailure);
  child.emit("error", new Error("definite spawn failure"));
  await assert.rejects(spawnFailure, /definite spawn failure/);
  child.emit("close", -1);
  console.log("delayed-close-ownership-and-definite-spawn-failure=passed");
} finally {
  boundary?.cancel();
  child.emit("close", null);
  await Promise.allSettled(owned);
  await boundary?.abandonPrepared();
  await rm(root, { recursive: true, force: true });
}
