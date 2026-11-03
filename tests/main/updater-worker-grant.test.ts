import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eventually } from "../core/helpers";

const WORKER = resolve("tests/fixtures/updater-grant-worker.ts");

async function fixture(): Promise<{ root: string; marker: string }> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-grant-"));
  return { root, marker: join(root, "granted") };
}

test("a registered but ungranted worker performs no work and exits on parent-pipe closure", async () => {
  const file = await fixture();
  try {
    const child = Bun.spawn([process.execPath, WORKER], {
      cwd: resolve("."),
      env: { PATH: "/usr/bin:/bin", HOME: file.root, GRANT_MARKER: file.marker },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    expect(child.pid).toBeNumber();
    await child.stdin?.end();
    expect(await child.exited).toBe(0);
    expect(await readFile(file.marker).catch(() => null)).toBeNull();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("a worker writes only after the parent persists the grant", async () => {
  const file = await fixture();
  try {
    const child = Bun.spawn([process.execPath, WORKER], {
      cwd: resolve("."),
      env: { PATH: "/usr/bin:/bin", HOME: file.root, GRANT_MARKER: file.marker },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    await writeFile(join(file.root, "registered.json"), JSON.stringify({ pid: child.pid }), {
      mode: 0o600,
    });
    expect(await readFile(file.marker).catch(() => null)).toBeNull();
    child.stdin?.write("grant\n");
    await child.stdin?.end();
    await eventually(async () => {
      try {
        return Number(await readFile(file.marker, "utf8")) === child.pid;
      } catch {
        return false;
      }
    });
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});

test("production worker does not import or use the SDK before a grant", async () => {
  const file = await fixture();
  try {
    const workerModule = resolve("src/main/updater/worker.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { runUpdaterWorker } from ${JSON.stringify(workerModule)}; process.exit(await runUpdaterWorker("check"));`,
      ],
      {
        cwd: resolve("."),
        env: {
          PATH: "/usr/bin:/bin",
          HOME: file.root,
          MCP_GATEWAY_UPDATE_GRANT: "1",
          MCP_GATEWAY_UPDATE_RESULT: join(file.root, "result.json"),
        },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    await child.stdin?.end();
    expect(await child.exited).toBe(2);
    expect(await readFile(join(file.root, "result.json")).catch(() => null)).toBeNull();
  } finally {
    await rm(file.root, { recursive: true, force: true });
  }
});
