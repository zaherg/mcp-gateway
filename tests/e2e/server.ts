import { randomBytes } from "node:crypto";
import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { QuitCoordinator } from "../../src/main/lifecycle";
import { MacLoginManager, openLoginManager } from "../../src/main/login";
import { AppService } from "../../src/main/service";
import { editConfigDocument, parseConfigDocument } from "../../src/shared/config-document";
import {
  alive,
  configFor,
  connect,
  eventually,
  freePort,
  pids,
  setup,
  stdio,
} from "../core/helpers";
import { jsoncFixture } from "../fixtures/config-document";
import { httpFixture } from "../fixtures/http-mcp";

// Test-only HTTP replacement for Electrobun RPC. Never included by the production entrypoint.
const upstream = await httpFixture();
const scenario = process.env.MCP_E2E_CONFIG ?? "json";
const initialConfig = await configFor(
  scenario === "jsonc"
    ? {
        remote: {
          url: "https://synthetic.example/mcp",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Preserve a source environment reference, not an expanded secret.
          headers: { "X-Reference": "${MCP_E2E_TOKEN}" },
        },
      }
    : {},
);
process.env.MCP_E2E_TOKEN = "synthetic-reference-source";
const context = await setup(
  initialConfig,
  scenario === "jsonc" ? "jsonc" : "json",
  scenario === "jsonc"
    ? jsoncFixture(initialConfig)
    : scenario === "strict-comments"
      ? `// strict refusal\n${JSON.stringify(initialConfig)}`
      : undefined,
);
await chmod(context.directory, 0o700);
const pidFile = resolve(context.directory, "pids");
const bundle = resolve(context.directory, "bundle");
const secret = randomBytes(32).toString("hex");
let nativeState = 0;
let refuseLoginChanges = false;
const loginCalls: boolean[] = [];
const copied: string[] = [];
const login = new MacLoginManager({
  status: () => nativeState,
  set: (enabled) => {
    loginCalls.push(enabled);
    if (refuseLoginChanges) return 1;
    nativeState = enabled ? 1 : 0;
    return 0;
  },
});
let failQuitOnce = false;
const quit = new QuitCoordinator(
  async () => {
    await closeController();
    if (failQuitOnce) {
      failQuitOnce = false;
      await Bun.sleep(250);
      throw new Error("synthetic-private-quit-cleanup");
    }
  },
  () => {},
  (error) => context.controller.recordLocalError(error),
);
const service = new AppService(
  context.controller,
  scenario === "linux" ? openLoginManager("linux", "/not-loaded.dylib", false).manager : login,
  (text) => copied.push(text),
  {
    platform: scenario === "linux" ? "linux" : "macos",
    requestQuit: () => {
      quit.handle(() => {});
      return quit.status();
    },
    quitStatus: () => quit.status(),
  },
);
const heldClients: Array<Awaited<ReturnType<typeof connect>>> = [];
let closed = false;
async function closeController() {
  if (!closed) {
    closed = true;
    await context.controller.close();
  }
  for (const held of heldClients.splice(0)) await held.client.close();
  await eventually(
    async () => (await pids(pidFile)).every((pid) => !alive(pid)) && upstream.sessionCount() === 0,
  );
}
try {
  await build({
    configFile: resolve("vite.config.ts"),
    root: resolve("tests/e2e"),
    base: "/",
    build: { outDir: bundle, emptyOutDir: true },
    logLevel: "silent",
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("host") !== `127.0.0.1:${server.port}`)
        return new Response(null, { status: 403 });
      if (req.method === "POST") {
        if (
          req.headers.get("authorization") !== `Bearer ${secret}` ||
          (req.headers.get("origin") && req.headers.get("origin") !== url.origin)
        )
          return new Response(null, { status: 403 });
        if (Number(req.headers.get("content-length")) > 1_100_000)
          return new Response(null, { status: 413 });
        const { params } = await req.json();
        const name = url.pathname.slice(5);
        if (url.pathname.startsWith("/rpc/") && Object.hasOwn(service.handlers, name)) {
          const handler = service.handlers[name as keyof typeof service.handlers];
          return Response.json(await handler(params));
        }
        if (url.pathname === "/control") {
          if (params === "occupied-port")
            return Response.json({ port: Number(new URL(upstream.url).port) });
          if (params === "inspect")
            return Response.json({
              snapshot: context.controller.snapshot(),
              loginCalls,
              copied,
              diskText: await readFile(context.path, "utf8"),
            });
          if (params === "login-pending") {
            nativeState = 2;
            refuseLoginChanges = true;
          } else if (params === "login-approved") {
            nativeState = 1;
          } else if (params === "login-allow") {
            refuseLoginChanges = false;
          } else if (params === "quit-fail-once") {
            failQuitOnce = true;
          } else if (params === "logs-benign") {
            const before = context.controller.snapshot();
            const next = JSON.parse(before.configText);
            next.mcpServers = {
              echo: stdio({ PRIVATE_DIAGNOSTIC: "synthetic-local-password=fixture-only\n" }),
            };
            await context.controller.saveConfig(JSON.stringify(next), before.revision);
            const started = await context.controller.start();
            const held = await connect(started.address as string);
            heldClients.push(held);
            await held.client.callTool({
              name: "echo",
              arguments: { value: "<script>synthetic-note</script>" },
            });
          } else if (params === "logs-failure") {
            const before = context.controller.snapshot();
            const next = JSON.parse(before.configText);
            next.mcpServers = { echo: { command: "/synthetic-missing/fixture-only" } };
            await context.controller.saveConfig(JSON.stringify(next), before.revision);
            await context.controller.restartServer("echo");
            try {
              await connect(context.controller.snapshot().address as string);
            } catch {
              /* Expected synthetic ENOENT. */
            }
          } else if (params === "invalid-again") {
            await writeFile(context.path, '{"unknown":false}');
          } else if (params === "external") {
            const text = await readFile(context.path, "utf8");
            const format = context.controller.snapshot().configFormat;
            const next = parseConfigDocument(text, format) as typeof initialConfig;
            next.gateway.autoStart = !next.gateway.autoStart;
            await writeFile(context.path, editConfigDocument(text, next, format));
          } else if (params === "ambiguous") {
            await writeFile(
              context.path.endsWith(".jsonc") ? context.path.slice(0, -1) : `${context.path}c`,
              JSON.stringify(initialConfig),
              { mode: 0o600 },
            );
          } else if (params === "invalid") await writeFile(context.path, '{"unknown":true}');
          else if (params === "probe") {
            const address = context.controller.snapshot().address;
            if (!address) throw new Error("Gateway not running");
            const results = [];
            for (const name of ["local", "remote"]) {
              const client = await connect(address, name);
              try {
                const tools = await client.client.listTools();
                const result = await client.client.callTool({
                  name: "echo",
                  arguments: { value: `e2e-${name}` },
                });
                results.push({ name, tools: tools.tools.map((tool) => tool.name), result });
              } finally {
                await client.close();
              }
            }
            return Response.json(results);
          } else if (params === "hold") {
            const address = context.controller.snapshot().address;
            if (!address) throw new Error("Gateway not running");
            heldClients.push(await connect(address, "local"));
            return Response.json({ livePids: (await pids(pidFile)).filter(alive).length });
          } else if (params === "close") {
            await closeController();
            return Response.json({
              closed: true,
              livePids: (await pids(pidFile)).filter(alive),
              upstreamSessions: upstream.sessionCount(),
            });
          } else if (
            params !== "external" &&
            params !== "invalid" &&
            params !== "ambiguous" &&
            ![
              "logs-benign",
              "logs-failure",
              "invalid-again",
              "login-pending",
              "login-approved",
              "login-allow",
              "quit-fail-once",
            ].includes(params)
          )
            return new Response(null, { status: 400 });
          return Response.json({ ok: true });
        }
        return new Response(null, { status: 404 });
      }
      if (req.method !== "GET") return new Response(null, { status: 405 });
      const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (path !== "index.html" && !/^assets\/[a-zA-Z0-9_.-]+$/.test(path))
        return new Response(null, { status: 404 });
      return new Response(Bun.file(resolve(bundle, path)));
    },
  });
  console.log(
    JSON.stringify({
      url: `http://127.0.0.1:${server.port}`,
      secret,
      stdio: stdio({ PID_FILE: pidFile }),
      upstream: { url: upstream.url, token: upstream.token },
      port: await freePort(),
    }),
  );
  await new Promise<void>((done) => {
    process.once("SIGTERM", done);
    process.once("SIGINT", done);
  });
  await server.stop(true);
} finally {
  await closeController();
  await upstream.close();
  await context.cleanup();
  await rm(bundle, { recursive: true, force: true });
}
