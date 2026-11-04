import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runCommand } from "../../../src/main/updater/verify";

const nativeTest = test.skipIf(process.platform !== "darwin");
for (const action of ["native", "menu", "signal", "unready", "lost", "ack", "approved"] as const) {
  nativeTest(
    `A8: ${action} Quit honors the interactive decision boundary`,
    async () => {
      const result = await runCommand(
        process.execPath,
        [resolve("tests/fixtures/audit-native-quit.ts"), action],
        10_000,
      );
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const evidence: unknown = JSON.parse(result.stdout);
      expect(evidence).toEqual({
        action,
        cleanupStarted: action === "signal" || action === "approved" ? 1 : 0,
        rendererDecisions: action === "signal" || action === "unready" ? 0 : 1,
      });
    },
    15_000,
  );
}
