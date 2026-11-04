import { spyOn } from "bun:test";
import * as fs from "node:fs";
import * as files from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWritePrivateJson } from "../../src/main/updater/storage";
import { TransactionLease } from "../../src/main/updater/transaction";

const [root, point] = process.argv.slice(2);
if (!root || !point || !resolve(root).startsWith(`${resolve(".cache")}/`))
  throw new Error("Invalid crash fixture root");
const channelRoot = join(root, "channel");
const dataDirectory = join(root, "data");
const directory = join(channelRoot, ".mcp-gateway-update-transaction");
const journal = join(directory, "lease.json");
await files.mkdir(dataDirectory, { recursive: true, mode: 0o700 });
let lease: TransactionLease | undefined;
if (!point.startsWith("initial-"))
  lease = await TransactionLease.acquire({
    channelRoot,
    dataDirectory,
    appBundlePath: join(root, "App.app"),
  });
const prefix = point.startsWith("initial-") ? "initial-" : "update-";
const crash = () => process.exit(42);
let partialFd: number | undefined;
const open = fs.openSync;
spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof open>) => {
  const fd = open(...args);
  if (String(args[0]).startsWith(`${journal}.`) && String(args[0]).endsWith(".partial")) {
    partialFd = fd;
    if (point === `${prefix}partial-created`) crash();
  }
  return fd;
});
const write = fs.writeSync;
spyOn(fs, "writeSync").mockImplementation(
  new Proxy(write, {
    apply(target, receiver, args) {
      const result = Reflect.apply(target, receiver, args);
      if (args[0] === partialFd && point === `${prefix}partial-written`) crash();
      return result;
    },
  }),
);
const sync = fs.fsyncSync;
spyOn(fs, "fsyncSync").mockImplementation((fd) => {
  sync(fd);
  if (fd === partialFd && point === `${prefix}partial-synced`) crash();
  if (
    point === "retirement-synced" &&
    fs.existsSync(directory) &&
    !fs.existsSync(journal) &&
    fs.fstatSync(fd).ino === fs.lstatSync(directory).ino
  )
    crash();
});
const mkdir = files.mkdir;
spyOn(files, "mkdir").mockImplementation(
  new Proxy(mkdir, {
    async apply(target, receiver, args) {
      const result = await Reflect.apply(target, receiver, args);
      if (String(args[0]) === directory && point === "initial-directory") crash();
      return result;
    },
  }),
);
const rename = files.rename;
spyOn(files, "rename").mockImplementation(async (from, to) => {
  await rename(from, to);
  if (String(to) === journal && point === `${prefix}renamed`) crash();
});
const unlink = fs.unlinkSync;
spyOn(fs, "unlinkSync").mockImplementation((path) => {
  unlink(path);
  if (String(path) === journal && point === "retirement-unlinked") crash();
});
const rmdir = fs.rmdirSync;
spyOn(fs, "rmdirSync").mockImplementation((path) => {
  rmdir(path);
  if (String(path) === directory && point === "retirement-removed") crash();
});
if (point.startsWith("initial-"))
  await TransactionLease.acquire({
    channelRoot,
    dataDirectory,
    appBundlePath: join(root, "App.app"),
  });
else if (point.startsWith("retirement-")) await lease?.releaseUncommitted();
else if (lease) await atomicWritePrivateJson(journal, lease.snapshot());
throw new Error("Requested crash point was not reached");
