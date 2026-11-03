import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectExactHelper } from "../../src/main/updater/process-inspector";
import { eventually } from "../core/helpers";

const SOURCE = resolve("tests/fixtures/unlinked-helper.c");

async function buildHelper(root: string): Promise<string> {
  const helper = join(root, "exact-helper");
  const child = Bun.spawn(
    ["/usr/bin/xcrun", "clang", "-mmacosx-version-min=13.0", SOURCE, "-o", helper],
    { stdout: "ignore", stderr: "pipe" },
  );
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
  await chmod(helper, 0o700);
  return helper;
}

test("detects an unlinked exact helper until the owned child is reaped", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-inspector-"));
  try {
    const helper = await buildHelper(root);
    const plan = join(root, "plan.json");
    const ready = join(root, "ready");
    await writeFile(plan, "{}\n", { mode: 0o600 });
    const child = Bun.spawn([helper, "--apply-update", plan, "--quiet"], {
      env: { PATH: "/usr/bin:/bin", HELPER_READY: ready },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await eventually(async () => (await readFile(ready, "utf8").catch(() => "")).trim() !== "");
    expect(await inspectExactHelper(helper, plan)).toEqual({
      status: "alive",
      pids: [child.pid],
    });
    child.kill("SIGKILL");
    await child.exited;
    await eventually(async () => (await inspectExactHelper(helper, plan)).status === "absent");
    expect(await inspectExactHelper(helper, plan)).toEqual({ status: "absent", pids: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns unknown for failed or malformed inspection", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-inspector-fail-"));
  try {
    const plan = join(root, "plan.json");
    const failed = join(root, "failed-inspector");
    await writeFile(plan, "{}\n", { mode: 0o600 });
    await writeFile(failed, "#!/bin/sh\nexit 2\n", { mode: 0o700 });
    expect(
      await inspectExactHelper(join(root, "helper"), plan, process.getuid?.(), {
        command: failed,
      }),
    ).toEqual({ status: "unknown", pids: [] });
    expect(await inspectExactHelper(join(root, "helper"), plan, -1)).toEqual({
      status: "unknown",
      pids: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
