import { spawnSync } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const [readyFile, gateFile, command, ...args] = process.argv.slice(2);
if (!readyFile || !gateFile || command !== "/bin/ps") {
  throw new Error("Expected private handshake paths and /bin/ps arguments");
}

// The relay changes only delivery time, not the inspected process identity or bytes.
// spawnSync joins its child, including the timeout/output-limit failure paths.
const inspected = spawnSync(command, args, {
  encoding: "buffer",
  timeout: 2_000,
  killSignal: "SIGKILL",
  maxBuffer: 8192,
  stdio: ["ignore", "pipe", "pipe"],
});
if (inspected.error) throw inspected.error;
if (inspected.status === null) throw new Error("Inspection terminated without an exit code");
await writeFile(readyFile, `${process.pid}\n`, { flag: "wx", mode: 0o600 });

const deadline = Date.now() + 8_000;
for (;;) {
  try {
    await access(gateFile);
    break;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (Date.now() >= deadline) throw new Error("Inspection relay gate was not released");
  await delay(20);
}
process.stdout.write(inspected.stdout);
process.stderr.write(inspected.stderr);
process.exitCode = inspected.status;
