import { expect, test } from "bun:test";
import { ok } from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { MAX_SESSIONS } from "../../src/core/ingress";
import { alive, configFor, eventually, mcpCall, pids, setup, stdio } from "../core/helpers";
import { httpFixture } from "../fixtures/http-mcp";

// Ordinary regression tests: protocol or admission regressions must fail the unit command.
async function modern(
  address: string,
  endpoint: string,
  requestState?: string,
  name = "ask",
  value = "resumed",
  signal = AbortSignal.timeout(5000),
) {
  return mcpCall(
    address,
    endpoint,
    "tools/call",
    { name, arguments: { value }, ...(requestState ? { requestState } : {}) },
    1,
    signal,
  );
}

test.each([
  ["json", false],
  ["cr", false],
  ["crlf", true],
  ["cr", true],
] as const)(
  "regression: modern HTTP %s replies preserve exact results (split bytes/open stream: %s)",
  async (encoding, splitBytes) => {
    const upstream = await httpFixture({
      modernDiscovery: "sse",
      modernStream:
        encoding === "json"
          ? undefined
          : {
              newline: encoding === "crlf" ? "\r\n" : "\r",
              splitBytes,
              holdOpen: splitBytes,
            },
    });
    const context = await setup(
      await configFor({
        remote: { url: upstream.url, headers: { Authorization: `Bearer ${upstream.token}` } },
      }),
    );
    try {
      const { address } = await context.controller.start();
      const result = await modern(
        address as string,
        "remote",
        undefined,
        "echo",
        "snowman ☃ café 🐻 replacement \uFFFD\nsecond line",
      );
      expect(result).toEqual({
        status: 200,
        message: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: "snowman ☃ café 🐻 replacement \uFFFD\nsecond line" }],
          },
        },
      });
      await eventually(() => upstream.activeReplyCount() === 0);
      // biome-ignore lint/complexity/useLiteralKeys: Verify private cleanup accounting without adding a production API.
      await eventually(() => context.controller["ingress"]?.["admission"]["used"] === 0);
      expect(
        upstream.receivedAuthorization.every((value) => value === `Bearer ${upstream.token}`),
      ).toBe(true);
      expect(context.controller.snapshot().operationalError).toBeNull();
    } finally {
      await context.cleanup();
      await upstream.close();
    }
  },
  15_000,
);

test.each([
  "invalid-json",
  "invalid-message",
  "unterminated",
  "invalid-utf8",
  "invalid-utf8-continuation",
  "truncated-utf8",
] as const)(
  "regression: %s streamed replies fail safely and release upstream resources",
  async (fault) => {
    const upstream = await httpFixture({
      modernDiscovery: "json",
      modernStream: {
        newline: "\r",
        fault,
        splitBytes: fault === "invalid-utf8-continuation" || fault === "truncated-utf8",
      },
    });
    const context = await setup(
      await configFor({
        remote: { url: upstream.url, headers: { Authorization: `Bearer ${upstream.token}` } },
      }),
    );
    try {
      const { address } = await context.controller.start();
      // Check refusal and retry; exact zero accounting catches a leak after either call.
      for (let call = 0; call < 2; call++) {
        const result = await modern(
          address as string,
          "remote",
          undefined,
          "echo",
          "synthetic-private-stream-value",
        );
        expect(result).toEqual({
          status: 200,
          message: {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32603, message: "MCP server process failed" },
          },
        });
        // biome-ignore lint/complexity/useLiteralKeys: Verify private cleanup accounting without adding a production API.
        await eventually(() => context.controller["ingress"]?.["admission"]["used"] === 0);
      }
      await eventually(() => upstream.activeReplyCount() === 0);
      const { servers, events, operationalError } = context.controller.snapshot();
      expect(JSON.stringify({ servers, events, operationalError })).not.toContain(
        "synthetic-private-stream-value",
      );
      expect(
        upstream.receivedAuthorization.every((value) => value === `Bearer ${upstream.token}`),
      ).toBe(true);
    } finally {
      await context.cleanup();
      await upstream.close();
    }
  },
  15_000,
);

test.each(["disconnect", "shutdown"] as const)(
  "regression: %s cancels an unfinished upstream event stream and releases resources",
  async (action) => {
    const upstream = await httpFixture({
      modernDiscovery: "json",
      modernStream: {
        newline: "\r",
        fault: "unterminated",
        holdOpen: true,
      },
    });
    const context = await setup(
      await configFor({
        remote: { url: upstream.url, headers: { Authorization: `Bearer ${upstream.token}` } },
      }),
    );
    const abort = new AbortController();
    try {
      const { address } = await context.controller.start();
      // biome-ignore lint/complexity/useLiteralKeys: Retain test access to cleanup accounting after controller.stop().
      const ingress = context.controller["ingress"];
      const pending = modern(
        address as string,
        "remote",
        undefined,
        "echo",
        "cancelled",
        abort.signal,
      ).then(
        () => "replied",
        () => "cancelled",
      );
      await eventually(
        () =>
          upstream.receivedHeaders.some((headers) => headers["mcp-method"] === "tools/call") &&
          upstream.activeReplyCount() > 0,
      );
      if (action === "disconnect") abort.abort();
      else await context.controller.stop();
      expect(await pending).toBe("cancelled");
      await eventually(
        // biome-ignore lint/complexity/useLiteralKeys: Verify the retired listener has released every resource.
        () => upstream.activeReplyCount() === 0 && ingress?.["admission"]["used"] === 0,
      );
    } finally {
      abort.abort();
      await context.cleanup();
      await upstream.close();
    }
  },
  10_000,
);

test(`regression: global ${MAX_SESSIONS}-resource cap includes retained modern children across two endpoints`, async () => {
  const context = await setup(await configFor({}));
  const pidFile = join(context.directory, "pids");
  try {
    const config = await configFor({
      echo: stdio({ PID_FILE: pidFile }),
      other: stdio({ PID_FILE: pidFile }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    const handles: Array<{ endpoint: string; state: string }> = [];
    for (let i = 0; i < MAX_SESSIONS; i++) {
      const endpoint = i % 2 ? "other" : "echo";
      const result = await modern(address as string, endpoint);
      ok(result.message);
      expect(result.status).toBe(200);
      expect(result.message.result.requestState).toMatch(/^sgw:/);
      handles.push({ endpoint, state: result.message.result.requestState });
    }
    await eventually(async () => (await pids(pidFile)).filter(alive).length === MAX_SESSIONS);
    expect((await modern(address as string, "other")).status).toBe(429);
    expect((await pids(pidFile)).filter(alive).length).toBeLessThanOrEqual(MAX_SESSIONS);
    const retainedPid = (await pids(pidFile))[0];
    const resumed = await modern(address as string, handles[0].endpoint, handles[0].state);
    ok(resumed.message);
    expect(resumed.status).toBe(200);
    expect(resumed.message.error).toBeUndefined();
    expect(resumed.message.result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ value: "resumed", count: 1, pid: retainedPid, argv: [] }),
      },
    ]);
    await context.controller.stop();
    await eventually(async () => (await pids(pidFile)).every((pid) => !alive(pid)));
    await context.controller.start();
    const afterCleanup = await modern(
      context.controller.snapshot().address as string,
      "echo",
      undefined,
      "echo",
    );
    expect(afterCleanup.status).toBe(200);
  } finally {
    const ownedPids = await pids(pidFile);
    await context.cleanup();
    await eventually(() => ownedPids.every((pid) => !alive(pid)));
  }
}, 30_000);

test("regression: completed modern requests release resources without continuation throttling", async () => {
  const context = await setup(await configFor({}));
  const pidFile = join(context.directory, "pids");
  try {
    const config = await configFor({ echo: stdio({ PID_FILE: pidFile }) });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    for (let i = 0; i < MAX_SESSIONS + 4; i++) {
      const result = await modern(address as string, "echo", undefined, "echo");
      ok(result.message);
      expect(result.status).toBe(200);
      expect(result.message.error).toBeUndefined();
      expect(JSON.parse(result.message.result.content[0].text).value).toBe("resumed");
      expect((await pids(pidFile)).filter(alive).length).toBeLessThanOrEqual(MAX_SESSIONS);
    }
    await eventually(async () => (await pids(pidFile)).every((pid) => !alive(pid)));
    expect(context.controller.snapshot().servers[0].status).toBe("mounted");
    expect(context.controller.snapshot().servers[0].error).toBeNull();
    expect(context.controller.snapshot().operationalError).toBeNull();
  } finally {
    const ownedPids = await pids(pidFile);
    await context.cleanup();
    await eventually(() => ownedPids.every((pid) => !alive(pid)));
  }
}, 15_000);

test.each(["json", "sse"])(
  "regression: modern HTTP %s continuations share admission with stdio and isolate configured upstream credentials",
  async (encoding) => {
    const received: IncomingHttpHeaders[] = [];
    const sockets = new Set<Socket>();
    const upstreamToken = "synthetic-upstream-only-token";
    const upstream = createServer(async (req, res) => {
      received.push(req.headers);
      if (req.headers.authorization !== `Bearer ${upstreamToken}`) {
        res.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString());
      let result: unknown;
      if (message.method === "server/discover") result = { supportedVersions: ["2026-07-28"] };
      else if (message.method === "tools/list")
        result = {
          tools: [{ name: "ask", inputSchema: { type: "object", additionalProperties: true } }],
        };
      else if (!message.params.requestState)
        result = {
          resultType: "input_required",
          requestState: "opaque-upstream-state",
          content: [],
        };
      else
        result = {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                value: message.params.arguments.value,
                restoredState: message.params.requestState,
              }),
            },
          ],
        };
      const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
      if (encoding === "sse" && message.method !== "server/discover") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${reply}\r\r`);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(reply);
      }
    });
    upstream.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const bound = upstream.address();
    if (!bound || typeof bound === "string") throw new Error("No upstream port");
    const context = await setup(await configFor({}));
    try {
      const config = await configFor({
        echo: stdio(),
        remote: {
          url: `http://127.0.0.1:${bound.port}/mcp`,
          headers: { Authorization: `Bearer ${upstreamToken}` },
        },
      });
      await context.controller.saveConfig(
        JSON.stringify(config),
        context.controller.snapshot().revision,
      );
      const { address } = await context.controller.start();
      // A retained stdio child holds one shared admission slot.
      const local = await modern(address as string, "echo");
      ok(local.message);
      expect(local.message.result.requestState).toMatch(/^sgw:/);
      let state = "";
      for (let i = 1; i < MAX_SESSIONS; i++) {
        const result = await modern(address as string, "remote");
        ok(result.message);
        expect(result.status).toBe(200);
        expect(result.message.error).toBeUndefined();
        expect(result.message.result.requestState).toMatch(/^sgw:/);
        state = result.message.result.requestState;
      }
      const beforeExcess = received.length;
      expect((await modern(address as string, "remote")).status).toBe(429);
      expect(received).toHaveLength(beforeExcess);
      const resumed = await modern(address as string, "remote", state);
      ok(resumed.message);
      expect(resumed.status).toBe(200);
      expect(resumed.message.error).toBeUndefined();
      expect(resumed.message.result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ value: "resumed", restoredState: "opaque-upstream-state" }),
        },
      ]);
      expect(received.every((headers) => headers.authorization === `Bearer ${upstreamToken}`)).toBe(
        true,
      );
      expect(
        (await modern(address as string, "echo", local.message.result.requestState)).status,
      ).toBe(200);
      await context.controller.stop();
      await context.controller.start();
      const afterCleanup = await modern(context.controller.snapshot().address as string, "remote");
      ok(afterCleanup.message);
      expect(afterCleanup.status).toBe(200);
      expect(afterCleanup.message.result.requestState).toMatch(/^sgw:/);
    } finally {
      await context.cleanup();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  20_000,
);

test("regression: a completed modern response keeps its slot until child cleanup settles", async () => {
  const context = await setup(await configFor({}));
  const gate = join(context.directory, "cleanup-gate");
  const signalFile = join(context.directory, "cleanup-signals");
  const pidFile = join(context.directory, "pids");
  try {
    const config = await configFor({
      echo: stdio({ PID_FILE: pidFile }),
      modern: stdio({
        PID_FILE: pidFile,
        CLEANUP_GATE_FILE: gate,
        CLEANUP_SIGNAL_FILE: signalFile,
      }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    // Retained children fill every slot but one.
    for (let i = 1; i < MAX_SESSIONS; i++)
      expect((await modern(address as string, "echo")).message?.result.requestState).toMatch(
        /^sgw:/,
      );
    const completed = await modern(address as string, "modern", undefined, "echo");
    ok(completed.message);
    expect(completed.status).toBe(200);
    expect(completed.message.error).toBeUndefined();
    expect(JSON.parse(completed.message.result.content[0].text).value).toBe("resumed");
    await eventually(async () => (await pids(signalFile)).length > 0);
    const [stoppingPid] = await pids(signalFile);
    expect(alive(stoppingPid)).toBe(true);
    expect((await modern(address as string, "modern", undefined, "echo")).status).toBe(429);
    expect((await pids(pidFile)).filter(alive)).toHaveLength(MAX_SESSIONS);
    await Bun.write(gate, "release");
    await eventually(() => !alive(stoppingPid));
    await eventually(
      async () => (await modern(address as string, "modern", undefined, "echo")).status === 200,
    );
    expect((await pids(pidFile)).filter(alive).length).toBeLessThanOrEqual(MAX_SESSIONS);
    expect(context.controller.snapshot().servers.every((server) => server.error === null)).toBe(
      true,
    );
    expect(context.controller.snapshot().operationalError).toBeNull();
  } finally {
    await Bun.write(gate, "release");
    const ownedPids = await pids(pidFile);
    await context.cleanup();
    await eventually(() => ownedPids.every((pid) => !alive(pid)));
  }
}, 20_000);
