import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectExactHelper } from "../../src/main/updater/process-inspector";
import { eventually } from "../core/helpers";

const SOURCE = resolve("tests/fixtures/unlinked-result-helper.c");

test("result publication before cleanup never authorizes cleanup; arming survives a failed binding write", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-helper-lifecycle-"));
  try {
    const helper = join(root, "exact-helper");
    const plan = join(root, "plan.json");
    const result = join(root, "result.json");
    const ready = join(root, "ready");
    const statePath = join(root, "state.json");
    const build = Bun.spawn(
      ["/usr/bin/xcrun", "clang", "-mmacosx-version-min=13.0", SOURCE, "-o", helper],
      { stdout: "ignore", stderr: "pipe" },
    );
    if ((await build.exited) !== 0) throw new Error(await new Response(build.stderr).text());
    await chmod(helper, 0o700);
    await writeFile(plan, "{}\n", { mode: 0o600 });
    await writeFile(
      statePath,
      JSON.stringify({ phase: "arming", helper_path: helper, plan_path: plan }),
      {
        mode: 0o600,
      },
    );
    const child = Bun.spawn([helper, "--apply-update", plan, "--quiet"], {
      env: { PATH: "/usr/bin:/bin", HELPER_RESULT: result, HELPER_READY: ready },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await eventually(async () => (await readFile(ready, "utf8").catch(() => "")).trim() !== "");
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({
      schema_version: 1,
      phase: "waiting_for_parent",
    });
    expect(await readFile(plan, "utf8")).toBe("{}\n");
    expect((await inspectExactHelper(helper, plan)).status).toBe("alive");
    await expect(
      writeFile(join(root, "binding.json"), "binding\n", { flag: "wx" }),
    ).resolves.toBeUndefined();
    await expect(
      writeFile(join(root, "binding.json"), "again", { flag: "wx" }),
    ).rejects.toBeInstanceOf(Error);
    expect(JSON.parse(await readFile(statePath, "utf8")).phase).toBe("arming");
    expect((await inspectExactHelper(helper, plan)).status).toBe("alive");
    child.kill("SIGKILL");
    await child.exited;
    await eventually(async () => (await inspectExactHelper(helper, plan)).status === "absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
