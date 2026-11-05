import { afterAll, beforeAll, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { nativeEnvironment, ownFixture, spawnOwned } from "../../scripts/native-process";
import { runCommand } from "../../src/core/command";
import { alive, configFor, connect, fixture, pids, stdio } from "../core/helpers";
import { nativeQuitSource } from "../fixtures/native-quit-hooks";

const supplied = process.env.MCP_GATEWAY_NATIVE_BUNDLE;
const native = test;
let root = "";
let bundle = "";
beforeAll(async () => {
  if (process.platform !== "darwin" || !supplied)
    throw new Error("Native Quit acceptance requires macOS and MCP_GATEWAY_NATIVE_BUNDLE.");
  const source = await realpath(supplied);
  if (!source.endsWith("/MCP Gateway-dev.app") || relative(resolve(), source).startsWith(".."))
    throw new Error("An explicit project-local development bundle is required.");
  root = await mkdtemp(resolve(".cache/native-quit-"));
  bundle = join(root, "MCP Gateway-dev.app");
  await cp(source, bundle, { recursive: true });
  const result = await Bun.build({
    entrypoints: [resolve("src/main/index.ts")],
    outdir: join(bundle, "Contents/Resources/app/bun"),
    naming: "index.js",
    target: "bun",
    external: ["supergateway", "supergateway/*", "jsonc-parser"],
    plugins: [
      {
        name: "private-native-quit-acceptance",
        setup(build) {
          build.onLoad({ filter: /src\/main\/index\.ts$/ }, async (args) => ({
            contents: nativeQuitSource(
              await readFile(args.path, "utf8"),
              process.env.MCP_GATEWAY_TEST_IGNORE_SIGNAL === "1",
            ),
            loader: "ts",
          }));
        },
      },
    ],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));
});
afterAll(() => {
  if (root) console.log(`Native Quit evidence: ${root}`);
});

interface Event {
  phase: string;
  pid: number;
  signal: boolean;
  rendererRequests: number;
  lifecycle: { phase: string };
}
async function events(path: string): Promise<Event[]> {
  try {
    return (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

for (const mode of ["dirty", "unresponsive"] as const) {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    native(
      `${signal} cleans up with a ${mode} native window, without renderer consent`,
      async () => {
        const directory = join(root, `${mode}-${signal}`);
        const env = nativeEnvironment(directory, "macos", process.env);
        delete env.MCP_GATEWAY_SMOKE;
        env.MCP_GATEWAY_NATIVE_QUIT_MODE = mode;
        for (const path of [directory, env.HOME, env.TMPDIR])
          await mkdir(path, { recursive: true, mode: 0o700 });
        const pidFile = join(directory, "pids");
        const backend = stdio({ PID_FILE: pidFile });
        backend.args = [fixture, directory];
        const config = await configFor({ echo: backend });
        config.gateway.autoStart = true;
        const configBytes = JSON.stringify(config);
        await writeFile(join(directory, "mcp.json"), configBytes, { mode: 0o600 });
        const cwd = join(bundle, "Contents/MacOS");
        const owned = spawnOwned([join(cwd, "launcher")], cwd, env);
        const output = Promise.all([
          new Response(owned.child.stdout).text(),
          new Response(owned.child.stderr).text(),
        ]);
        let client: Awaited<ReturnType<typeof connect>> | undefined;
        const eventFile = join(directory, "quit-events.jsonl");
        try {
          const deadline = Date.now() + 15_000;
          let before: Event[] = [];
          while (Date.now() < deadline) {
            before = await events(eventFile);
            if (
              before.some(
                (event) => event.phase === "signal-ready" || event.phase === "fixture-failed",
              )
            )
              break;
            if (owned.child.exitCode !== null) break;
            await Bun.sleep(50);
          }
          const ready = before.find((event) => event.phase === "signal-ready");
          expect(before.map((event) => event.phase)).toEqual([
            "draft-ready",
            "renderer-request",
            "draft-confirmation",
            ...(mode === "unresponsive" ? ["renderer-blocked"] : []),
            "signal-ready",
          ]);
          if (!ready) throw new Error("Native fixture did not become signal-ready.");
          expect(ready.signal).toBe(false);
          expect(ready.lifecycle.phase).toBe("idle");
          client = await connect(`http://127.0.0.1:${config.gateway.port}`);
          // An ask call retains its backend child so it is alive and observable
          // until the native signal cleans the gateway up.
          const result = await client.client.callTool({
            name: "ask",
            arguments: { value: "native-signal" },
          });
          expect(result.isError).not.toBe(true);
          expect((await pids(pidFile)).some(alive)).toBe(true);
          // Check the recorded runtime is still in this test's owned launcher group.
          expect(Number.isSafeInteger(ready.pid) && ready.pid > 1).toBe(true);
          const identity = await runCommand(
            "/bin/ps",
            ["-p", String(ready.pid), "-o", "pgid=,uid=,command="],
            2_000,
          );
          expect(identity.exitCode).toBe(0);
          const [group, uid] = identity.stdout.trim().split(/\s+/);
          expect(group).toBe(String(owned.child.pid));
          expect(uid).toBe(String(process.getuid?.()));
          expect(identity.stdout).toContain(join(cwd, "bun"));
          // Signal the actual app runtime, not JS listeners or a mock callback.
          process.kill(ready.pid, signal);
          const exit = await Promise.race([
            owned.child.exited,
            Bun.sleep(8_000).then(() => "timeout"),
          ]);
          expect(exit).not.toBe("timeout");
          const after = await events(eventFile);
          expect(after.filter((event) => event.phase === "cleanup-start")).toHaveLength(1);
          const complete = after.filter((event) => event.phase === "cleanup-complete");
          expect(complete).toHaveLength(1);
          expect(complete[0]).toMatchObject({
            signal: true,
            rendererRequests: 1,
            lifecycle: { phase: "pending" },
          });
          expect((await pids(pidFile)).some(alive)).toBe(false);
          expect(await readFile(join(directory, "mcp.json"), "utf8")).toBe(configBytes);
        } finally {
          const fixtures: Array<Awaited<ReturnType<typeof ownFixture>>> = [];
          try {
            for (const pid of await pids(pidFile))
              fixtures.push(await ownFixture(pid, fixture, directory));
          } finally {
            try {
              await owned.stop();
            } finally {
              await Promise.all(fixtures.map((entry) => entry?.stop()));
              await client?.client.close();
              const [stdout, stderr] = await output;
              await writeFile(join(directory, "process.log"), `${stdout}\n${stderr}`, {
                mode: 0o600,
              });
            }
          }
        }
      },
      45_000,
    );
  }
}
