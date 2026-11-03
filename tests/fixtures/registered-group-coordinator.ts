import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  captureRegisteredGroup,
  persistRegisteredGroup,
} from "../../src/main/updater/registered-group";

const [root, mode, ready] = process.argv.slice(2);
if (!root || !mode || !ready) process.exit(2);
const worker = Bun.spawn([process.execPath, resolve("tests/fixtures/registered-group-worker.ts")], {
  cwd: resolve("."),
  env: { PATH: "/usr/bin:/bin", GROUP_READY: ready },
  stdin: "pipe",
  stdout: "ignore",
  stderr: "ignore",
  detached: true,
});
let registrationPath: string | null = null;
if (mode !== "before") {
  const record = await captureRegisteredGroup({
    leaderPid: worker.pid,
    helperPath: join(root, "helper"),
    planPath: join(root, "plan.json"),
  });
  registrationPath = await persistRegisteredGroup(root, record);
}
if (mode === "after") {
  worker.stdin?.write("grant\n");
  await worker.stdin?.end();
  while (true) {
    const contents = await Bun.file(ready)
      .text()
      .catch(() => "");
    if (contents.trim()) break;
    await Bun.sleep(50);
  }
} else {
  await worker.stdin?.end();
  await worker.exited;
}
writeFileSync(
  join(root, "coordinator-result.json"),
  JSON.stringify({ mode, leaderPid: worker.pid, pgid: worker.pid, registrationPath }),
  { mode: 0o600 },
);
process.exit(0);
