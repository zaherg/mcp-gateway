import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const mode = process.env.WORKER_MODE;
const result = process.env.WORKER_RESULT_PATH;
const pidFile = process.env.WORKER_CHILD_PID_FILE;
if (!result) throw new Error("missing result path");

if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  if (pidFile) writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  await new Promise(() => {});
}

if (mode === "malformed") {
  writeFileSync(result, "not json", { mode: 0o600 });
  process.exit(0);
}

writeFileSync(
  result,
  JSON.stringify({
    status: "ready",
    selected: { version: "0.3.1", hash: "target123456" },
    channelRoot: process.env.WORKER_CHANNEL_ROOT,
  }),
  { mode: 0o600 },
);
