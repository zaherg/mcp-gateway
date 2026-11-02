import { describe, expect, test } from "bun:test";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { MAX_BACKEND_CALLS } from "../../src/core/backend-work";
import { GatewayIngress, MAX_BODY_BYTES, MAX_SESSIONS } from "../../src/core/ingress";
import { httpFixture } from "../fixtures/http-mcp";
import {
  alive,
  configFor,
  connect,
  eventually,
  pids,
  setup,
  stdio,
  TOKEN,
  testDirectory,
} from "./helpers";

function textValue(result: Record<string, unknown>): {
  value: string;
  count: number;
  pid: number;
  argv?: string[];
  env?: string;
  sessionMarker?: string;
} {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}
async function raw(
  address: string,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    chunked?: boolean;
    omitHost?: boolean;
  } = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const url = new URL(address);
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: options.method ?? "POST",
        setHost: !options.omitHost,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...options.headers,
        },
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.setTimeout(5_000, () => req.destroy(new Error("test request timeout")));
    req.once("error", reject);
    if (options.chunked && options.body) {
      req.write(options.body.slice(0, options.body.length / 2));
      req.end(options.body.slice(options.body.length / 2));
    } else req.end(options.body);
  });
}

describe("shared MCP ingress", () => {
  test("modern per-request protocol calls, continuation isolation and cleanup remain upstream-owned", async () => {
    const directory = await testDirectory();
    const pidFile = join(directory, "modern-pids");
    const context = await setup(
      await configFor({ echo: stdio({ PID_FILE: pidFile }), other: stdio() }),
    );
    try {
      const { address } = await context.controller.start();
      let id = 0;
      const modern = async (name: string, method: string, params: Record<string, unknown> = {}) => {
        const response = await fetch(`${address}/mcp/${name}`, {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method,
            params: {
              ...params,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        });
        const text = await response.text();
        const data = response.headers.get("content-type")?.includes("text/event-stream")
          ? text
              .split("\n")
              .filter((line) => line.startsWith("data: "))
              .at(-1)
              ?.slice(6)
          : text;
        return {
          status: response.status,
          message: JSON.parse(data ?? "null") as {
            result?: Record<string, unknown>;
            error?: unknown;
          },
        };
      };
      const listed = await modern("echo", "tools/list");
      expect(listed.status).toBe(200);
      expect(listed.message.result?.tools).toBeArray();
      const echoed = await modern("echo", "tools/call", {
        name: "echo",
        arguments: { value: "modern-value" },
      });
      expect(echoed.status).toBe(200);
      expect(textValue(echoed.message.result ?? {}).value).toBe("modern-value");
      const asking = await modern("echo", "tools/call", { name: "ask", arguments: {} });
      const handle = asking.message.result?.requestState;
      expect(handle).toMatch(/^sgw:/);
      const crossEndpoint = await modern("other", "tools/call", {
        name: "ask",
        requestState: handle,
        arguments: {},
      });
      expect(crossEndpoint.status).toBe(400);
      expect(
        context.controller.snapshot().servers.find((server) => server.name === "other")?.status,
      ).toBe("mounted");
      const resumed = await modern("echo", "tools/call", {
        name: "ask",
        requestState: handle,
        arguments: { value: "resumed" },
      });
      expect(resumed.status).toBe(200);
      expect(textValue(resumed.message.result ?? {}).value).toBe("resumed");
      await context.controller.stop();
      await eventually(async () => (await pids(pidFile)).every((pid) => !alive(pid)));
    } finally {
      await context.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("real stdio initialize/list/call/write and concurrent isolated sessions; argument arrays are not shell strings", async () => {
    const directory = await testDirectory();
    const pidFile = join(directory, "pids");
    const output = join(directory, "synthetic-output");
    const never = join(directory, "must-not-exist");
    const server = stdio({
      PID_FILE: pidFile,
      SYNTHETIC_OUTPUT: output,
      SYNTHETIC_ENV: "synthetic-env",
      PRIVATE_DIAGNOSTIC: "SECRET-fixture-note-and-token",
    });
    server.args?.push(`literal;touch ${never}`);
    const context = await setup(await configFor({ echo: server, other: stdio() }));
    const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
    try {
      const started = await context.controller.start();
      expect(started.servers.map((entry) => entry.status)).toEqual(["mounted", "mounted"]);
      const address = started.address as string;
      clients.push(
        ...(await Promise.all([connect(address), connect(address), connect(address, "other")])),
      );
      expect((await clients[0].client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "echo",
        "write",
        "delay",
        "ask",
      ]);
      const answers = await Promise.all(
        clients.map(({ client }, index) =>
          client.callTool({ name: "echo", arguments: { value: `client-${index}` } }),
        ),
      );
      expect(answers.map((answer) => textValue(answer).value)).toEqual([
        "client-0",
        "client-1",
        "client-2",
      ]);
      expect(answers.map((answer) => textValue(answer).count)).toEqual([1, 1, 1]);
      expect(new Set(answers.map((answer) => textValue(answer).pid)).size).toBe(3);
      expect(textValue(answers[0]).argv).toEqual([`literal;touch ${never}`]);
      expect(textValue(answers[0]).env).toBe("synthetic-env");
      await expect(access(never)).rejects.toThrow();
      await clients[0].client.callTool({
        name: "write",
        arguments: { value: "synthetic write only" },
      });
      expect(await readFile(output, "utf8")).toBe("synthetic write only");
      const snapshot = context.controller.snapshot();
      expect(
        JSON.stringify({ events: snapshot.events, errors: snapshot.operationalError }),
      ).not.toContain("SECRET-fixture");
      const sessionId = clients[0].transport.sessionId as string;
      expect(
        await raw(address, "/mcp/other", {
          headers: { "Mcp-Session-Id": sessionId },
          body: '{"jsonrpc":"2.0","id":7,"method":"tools/list"}',
        }),
      ).toBe(404);
      for (const client of clients.splice(0)) await client.close();
      await eventually(async () => (await pids(pidFile)).every((pid) => !alive(pid)));
    } finally {
      for (const client of clients) await client.close().catch(() => {});
      await context.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("real HTTP upstream handshake/list/call isolates upstream sessions and never forwards the gateway token", async () => {
    const upstream = await httpFixture();
    const context = await setup(
      await configFor({
        remote: { url: upstream.url, headers: { Authorization: `Bearer ${upstream.token}` } },
      }),
    );
    const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
    try {
      const { address } = await context.controller.start();
      clients.push(
        ...(await Promise.all([
          connect(address as string, "remote"),
          connect(address as string, "remote"),
        ])),
      );
      expect((await clients[0].client.listTools()).tools[0].name).toBe("echo");
      const results = await Promise.all(
        clients.map(({ client }, index) =>
          client.callTool({ name: "echo", arguments: { value: `remote-${index}` } }),
        ),
      );
      expect(results.map((result) => textValue(result).value)).toEqual(["remote-0", "remote-1"]);
      expect(results.map((result) => textValue(result).count)).toEqual([1, 1]);
      expect(textValue(results[0]).sessionMarker).not.toBe(textValue(results[1]).sessionMarker);
      expect(upstream.receivedAuthorization.length).toBeGreaterThan(0);
      expect(
        upstream.receivedAuthorization.every((header) => header === `Bearer ${upstream.token}`),
      ).toBe(true);
      for (const client of clients.splice(0)) await client.close();
      await eventually(() => upstream.sessionCount() === 0);
    } finally {
      for (const client of clients) await client.close().catch(() => {});
      await context.cleanup();
      await upstream.close();
    }
  }, 20_000);

  for (const [contentType, modernDiscovery] of [
    ["Content-Type", "json"],
    ["content-type", "json"],
    ["Content-Type", "sse"],
    ["content-type", "sse"],
  ] as const) {
    test(`HTTP ${contentType}/${modernDiscovery} sends one transport-owned value for discovery, modern calls and legacy sessions`, async () => {
      const upstream = await httpFixture({ modernDiscovery });
      const config = await configFor({
        remote: {
          url: upstream.url,
          headers: {
            Authorization: `Bearer ${upstream.token}`,
            [contentType]: "application/json",
          },
        },
      });
      const source = `// Preserve configured header spelling.\n${JSON.stringify(config, null, 2)}\n`;
      const context = await setup(config, "jsonc", source);
      let legacy: Awaited<ReturnType<typeof connect>> | undefined;
      try {
        const { address } = await context.controller.start();
        const response = await fetch(`${address}/mcp/remote`, {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            "Mcp-Protocol-Version": "2026-07-28",
            "Mcp-Method": "tools/call",
            "Mcp-Name": "echo",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "echo",
              arguments: { value: "synthetic-modern-value" },
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        });
        const text = await response.text();
        expect(upstream.receivedHeaders[0]["content-type"]).toBe("application/json");
        expect(response.status).toBe(200);
        const data = response.headers.get("content-type")?.includes("text/event-stream")
          ? text
              .split("\n")
              .find((line) => line.startsWith("data: "))
              ?.slice(6)
          : text;
        expect(JSON.parse(data ?? "null")).toEqual({
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "synthetic-modern-value" }] },
        });
        legacy = await connect(address as string, "remote");
        expect(
          textValue(
            await legacy.client.callTool({
              name: "echo",
              arguments: { value: "synthetic-legacy-value" },
            }),
          ).value,
        ).toBe("synthetic-legacy-value");
        await legacy.close();
        legacy = undefined;
        await eventually(() => upstream.sessionCount() === 0);
        expect(
          upstream.receivedHeaders
            .filter((headers) => headers["content-type"])
            .every((headers) => headers["content-type"] === "application/json"),
        ).toBe(true);
        expect(
          upstream.receivedAuthorization.every((value) => value === `Bearer ${upstream.token}`),
        ).toBe(true);
        const snapshot = context.controller.snapshot();
        expect(snapshot.configText).toBe(source);
        await context.controller.saveConfig(snapshot.configText, snapshot.revision);
        expect(await readFile(context.path, "utf8")).toBe(source);
        expect(context.controller.snapshot().revision).toBe(snapshot.revision);
      } finally {
        await legacy?.close();
        await context.cleanup();
        await upstream.close();
      }
    }, 15_000);
  }

  test("port 80 accepts only canonical and explicit default-port Host authorities", async () => {
    const config = await configFor();
    const errors: unknown[] = [];
    const ingress = await GatewayIngress.open(config, (error) => errors.push(error));
    const address = ingress.address;
    try {
      // Exercise the real dispatch policy on an ephemeral socket, never the occupied port 80.
      await ingress.reconcile({ ...config, gateway: { ...config.gateway, port: 80 } });
      for (const host of ["127.0.0.1", "127.0.0.1:80"]) {
        expect(
          await raw(address, "/mcp/echo", {
            headers: { Host: host, Origin: "http://127.0.0.1" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-03-26",
                capabilities: {},
                clientInfo: { name: "default-port-test", version: "1" },
              },
            }),
          }),
        ).toBe(200);
        for (const authorization of ["", "Bearer incorrect"])
          expect(
            await raw(address, "/mcp/echo", {
              headers: { Host: host, Authorization: authorization },
            }),
          ).toBe(401);
        for (const origin of [
          "null",
          "http://evil.example",
          "https://127.0.0.1",
          "http://127.0.0.1:81",
        ])
          expect(await raw(address, "/mcp/echo", { headers: { Host: host, Origin: origin } })).toBe(
            403,
          );
        expect(await raw(address, "/mcp/echo/", { headers: { Host: host } })).toBe(404);
      }
      for (const host of [
        "",
        "localhost",
        "127.0.0.2",
        "127.0.0.1:81",
        "127.0.0.1:080",
        "127.0.0.1:",
        "127.0.0.1.",
        "127.0.0.1:80:80",
        "http://127.0.0.1",
        "user@127.0.0.1",
        "127.0.0.1/",
        "127.0.0.1,evil.example",
        "[::ffff:127.0.0.1]",
      ])
        expect(await raw(address, "/mcp/echo", { headers: { Host: host } })).toBe(403);
      // The HTTP parser rejects a missing Host before application dispatch.
      expect(await raw(address, "/mcp/echo", { omitHost: true })).toBe(400);
      expect(errors).toEqual([]);
    } finally {
      await ingress.close();
    }
  }, 15_000);

  test("authenticates every HTTP method before dispatch and rejects Host, Origin, routes, methods and size", async () => {
    const context = await setup();
    try {
      const { address } = await context.controller.start();
      for (const method of ["POST", "GET", "DELETE", "OPTIONS", "PUT", "HEAD"]) {
        expect(
          await raw(address as string, "/mcp/echo", { method, headers: { Authorization: "" } }),
        ).toBe(401);
        expect(
          await raw(address as string, "/mcp/echo", {
            method,
            headers: { Authorization: "Bearer incorrect" },
          }),
        ).toBe(401);
      }
      for (const host of [
        "evil.example",
        "localhost",
        "127.0.0.1",
        "127.0.0.1:80",
        `127.0.0.1:${context.config.gateway.port + 1}`,
      ])
        expect(await raw(address as string, "/mcp/echo", { headers: { Host: host } })).toBe(403);
      for (const origin of ["null", "https://evil.example", "http://localhost", `${address}/wrong`])
        expect(await raw(address as string, "/mcp/echo", { headers: { Origin: origin } })).toBe(
          403,
        );
      expect(
        await raw(address as string, "/mcp/echo", {
          method: "OPTIONS",
          headers: { Origin: address as string },
        }),
      ).toBe(405);
      expect(await raw(address as string, "/mcp/echo", { method: "PUT" })).toBe(405);
      for (const path of [
        "/",
        "/health",
        "/admin",
        "/mcp/echo/",
        "/mcp/%65cho",
        "/mcp/echo?x=1",
        "/mcp/unknown",
        "/mcp/../echo",
      ])
        expect(await raw(address as string, path)).toBe(404);
      expect(
        await raw(address as string, "/mcp/echo", {
          headers: { "Content-Length": `${MAX_BODY_BYTES + 1}` },
        }),
      ).toBe(413);
      expect(
        await raw(address as string, "/mcp/echo", { headers: { "Content-Encoding": "gzip" } }),
      ).toBe(415);
      const allowed = await connect(address as string);
      await allowed.close();
    } finally {
      await context.cleanup();
    }
  }, 15_000);

  test("abandoned initialization and endpoint stop clean children without false backend failures", async () => {
    const context = await setup(await configFor({}));
    const pidFile = join(context.directory, "pids");
    const abort = new AbortController();
    let sibling: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await context.controller.saveConfig(
        JSON.stringify(
          await configFor({
            echo: stdio({ PID_FILE: pidFile, HANG_INITIALIZE_CLIENT: "abandoned" }),
          }),
        ),
        context.controller.snapshot().revision,
      );
      const { address } = await context.controller.start();
      sibling = await connect(address as string);
      const abandoned = fetch(`${address}/mcp/echo`, {
        method: "POST",
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "abandoned", version: "1" },
          },
        }),
      })
        .then(async (response) => {
          await response.text();
          return null;
        })
        .catch((error: unknown) => error);
      await eventually(async () => (await pids(pidFile)).length === 2);
      const owned = await pids(pidFile);
      abort.abort();
      expect(await abandoned).toMatchObject({ name: "AbortError" });
      await eventually(
        () =>
          !alive(owned[1]) &&
          context.controller.readLogs({ after: 0, text: "Child exited:" }).entries.length === 1,
      );
      expect(context.controller.snapshot().operationalError).toBeNull();
      expect(context.controller.snapshot().servers[0].error).toBeNull();
      expect((await sibling.client.listTools()).tools[0].name).toBe("echo");
      await context.controller.stop();
      await eventually(() => owned.every((pid) => !alive(pid)));
      expect(context.controller.snapshot().operationalError).toBeNull();
      expect(context.controller.snapshot().running).toBe(false);
    } finally {
      abort.abort();
      await sibling?.client.close();
      const owned = await pids(pidFile);
      await context.cleanup();
      await eventually(() => owned.every((pid) => !alive(pid)));
    }
  }, 15_000);

  test("chunked oversized and malformed bodies never open unbounded children", async () => {
    const context = await setup();
    try {
      const { address } = await context.controller.start();
      expect(
        await raw(address as string, "/mcp/echo", {
          body: `{"padding":"${"x".repeat(MAX_BODY_BYTES)}"}`,
          chunked: true,
        }),
      ).toBe(413);
      await context.controller.restartServer("echo");
      expect(await raw(address as string, "/mcp/echo", { body: '{"jsonrpc":' })).toBe(400);
      expect(context.controller.snapshot().servers[0].status).toBe("mounted");
      await context.controller.restartServer("echo");
      const client = await connect(address as string);
      await client.close();
    } finally {
      await context.cleanup();
    }
  }, 15_000);

  test("32 open HTTP requests are bounded independently of the backend-work cap", async () => {
    const context = await setup();
    const pending: ReturnType<typeof request>[] = [];
    const streams: ReturnType<typeof request>[] = [];
    const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
    let listening = 0;
    try {
      const { address } = await context.controller.start();
      // Sixteen sessions each keep one call and one listening stream open:
      // the backend-work cap limits calls, not the independent HTTP limit.
      for (let index = 0; index < MAX_BACKEND_CALLS; index++)
        clients.push(await connect(address as string));
      for (const [index, client] of clients.entries()) {
        const session = client.transport.sessionId as string;
        const req = request(
          `${address}/mcp/echo`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${TOKEN}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "Mcp-Session-Id": session,
            },
          },
          (response) => response.resume(),
        );
        req.on("error", () => {});
        req.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 100 + index,
            method: "tools/call",
            params: { name: "delay", arguments: { delay: 10_000 } },
          }),
        );
        pending.push(req);
        const stream = request(`${address}/mcp/echo`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            Accept: "text/event-stream",
            "Mcp-Session-Id": session,
          },
        });
        stream.on("error", () => {});
        stream.on("response", (response) => {
          listening++;
          response.resume();
        });
        stream.end();
        streams.push(stream);
      }
      await eventually(
        () => listening === MAX_BACKEND_CALLS && pending.length === MAX_BACKEND_CALLS,
      );
      await Bun.sleep(300);
      expect(
        await raw(address as string, "/mcp/echo", {
          headers: { "Mcp-Session-Id": clients[0].transport.sessionId as string },
          body: '{"jsonrpc":"2.0","id":999,"method":"tools/list"}',
        }),
      ).toBe(429);
    } finally {
      for (const req of pending) req.destroy();
      for (const stream of streams) stream.destroy();
      for (const client of clients) await client.client.close();
      await context.cleanup();
    }
  }, 20_000);

  test("global live session admission holds DELETE's slot until actual process cleanup", async () => {
    const context = await setup(await configFor({}));
    const gate = join(context.directory, "cleanup-gate");
    const signalFile = join(context.directory, "cleanup-signals");
    const pidFile = join(context.directory, "pids");
    const config = await configFor({
      echo: stdio({ PID_FILE: pidFile, CLEANUP_GATE_FILE: gate, CLEANUP_SIGNAL_FILE: signalFile }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
    const initialize =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"bounded","version":"1"}}}';
    try {
      const { address } = await context.controller.start();
      for (let index = 0; index < MAX_SESSIONS; index++)
        clients.push(await connect(address as string));
      expect(
        await raw(address as string, "/mcp/echo", {
          body: initialize,
        }),
      ).toBe(429);
      await clients.pop()?.close();
      await eventually(async () => (await pids(signalFile)).length > 0);
      const [stoppingPid] = await pids(signalFile);
      expect(alive(stoppingPid)).toBe(true);
      expect(await raw(address as string, "/mcp/echo", { body: initialize })).toBe(429);
      expect((await pids(pidFile)).filter(alive)).toHaveLength(MAX_SESSIONS);
      // Rejection validation does not open resources, even at full capacity.
      expect(
        await raw(address as string, "/mcp/echo", {
          body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
        }),
      ).toBe(400);
      await writeFile(gate, "release");
      await eventually(() => !alive(stoppingPid));
      await eventually(async () => {
        try {
          clients.push(await connect(address as string));
          return true;
        } catch {
          return false;
        }
      });
      expect(clients).toHaveLength(MAX_SESSIONS);
      expect((await pids(pidFile)).filter(alive)).toHaveLength(MAX_SESSIONS);
    } finally {
      await writeFile(gate, "release");
      for (const client of clients) await client.close().catch(() => {});
      const ownedPids = await pids(pidFile);
      await context.cleanup();
      await eventually(() => ownedPids.every((pid) => !alive(pid)));
    }
  }, 30_000);
});
