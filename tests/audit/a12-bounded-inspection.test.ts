import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand } from "../../src/main/updater/verify";

const nativeTest = test.skipIf(process.platform !== "darwin" || process.arch !== "arm64");
const fixture = resolve(import.meta.dir, "../fixtures/a12-boundary-inspection.ts");

for (const mode of ["control", "baseline", "cancel"] as const) {
  nativeTest(
    `A12 ${mode}: inspection joins its worker lifecycle before cleanup`,
    async () => {
      await mkdir(resolve(".cache"), { recursive: true });
      const root = await mkdtemp(resolve(".cache/a12-isolated-"));
      const result = await runCommand(process.execPath, [fixture, mode, root], 20_000);
      // A failing fixture retains its state, rather than deleting uncertain ownership.
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const report: unknown = JSON.parse(result.stdout);
      expect(report).toMatchObject({ mode, cleaned: true, intercepted: true });
      expect(await readdir(root)).toEqual([]);
      await rmdir(root);

      // These observations were captured before the fixture's finally cleanup.
      expect(report).toEqual({
        mode,
        cleaned: true,
        intercepted: true,
        before: {
          workerAbsent: true,
          inspectionClosed: true,
          operationSettled: true,
          granted: mode === "control",
          terminal:
            mode === "control"
              ? {
                  kind: "success",
                  value: { available: false, version: null, hash: null, currentVersion: "0.3.0" },
                }
              : { kind: "error", code: mode === "cancel" ? "cancelled" : "workerTimeout" },
        },
      });
    },
    30_000,
  );
}
