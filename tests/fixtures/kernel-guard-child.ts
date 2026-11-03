import { writeFileSync } from "node:fs";
import { acquireKernelGuard } from "../../src/main/updater/kernel-guard";

const root = process.argv[2];
const ready = process.argv[3];
if (!root || !ready) process.exit(2);
try {
  const guard = await acquireKernelGuard(root);
  writeFileSync(ready, "locked\n", { mode: 0o600 });
  const keep = setInterval(() => {}, 1_000);
  process.on("SIGTERM", () => {
    clearInterval(keep);
    void guard.release().finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    clearInterval(keep);
    void guard.release().finally(() => process.exit(0));
  });
} catch (error) {
  const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
  console.error(code);
  process.exit(3);
}
