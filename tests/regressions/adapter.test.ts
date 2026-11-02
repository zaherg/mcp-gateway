import { expect, spyOn, test } from "bun:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { StatefulSessions } from "supergateway/dist/gateways/statefulSessions.js";
import { MAX_BACKEND_CALLS } from "../../src/core/backend-work";
import { MAX_SESSIONS } from "../../src/core/ingress";
import {
  alive,
  configFor,
  connect,
  eventually,
  pids,
  setup,
  stdio,
  TOKEN,
  within,
} from "../core/helpers";
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
  const response = await fetch(`${address}/mcp/${endpoint}`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/call",
      "Mcp-Name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: { value },
        ...(requestState ? { requestState } : {}),
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
  return { status: response.status, message: data ? JSON.parse(data) : null };
}

test.each([
  ["json", false],
  ["lf", false],
  ["crlf", false],
  ["cr", false],
  ["lf", true],
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
              newline: encoding === "lf" ? "\n" : encoding === "crlf" ? "\r\n" : "\r",
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
        "snowman ☃ café\nsecond line",
      );
      expect(result).toEqual({
        status: 200,
        message: {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: "snowman ☃ café\nsecond line" }] },
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

test.each(["invalid-json", "invalid-message", "unterminated"] as const)(
  "regression: %s streamed replies fail safely and release upstream resources",
  async (fault) => {
    const upstream = await httpFixture({
      modernDiscovery: "json",
      modernStream: { newline: "\r", fault },
    });
    const context = await setup(
      await configFor({
        remote: { url: upstream.url, headers: { Authorization: `Bearer ${upstream.token}` } },
      }),
    );
    try {
      const { address } = await context.controller.start();
      for (let call = 0; call < MAX_SESSIONS + 1; call++) {
        const result = await modern(address as string, "remote", undefined, "echo");
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

test("regression: malformed initialize returns 400 without retiring a usable endpoint", async () => {
  const context = await setup(await configFor({}));
  const pidFile = join(context.directory, "pids");
  let sibling: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const config = await configFor({ echo: stdio({ PID_FILE: pidFile }) });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    sibling = await connect(address as string);
    const initialPids = await pids(pidFile);
    const response = await fetch(`${address}/mcp/echo`, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    await response.text();
    expect(response.status).toBe(400);
    expect(context.controller.snapshot().servers[0].status).toBe("mounted");
    expect(await pids(pidFile)).toEqual(initialPids);
    expect((await sibling.client.listTools()).tools[0].name).toBe("echo");
    const client = await connect(address as string);
    try {
      expect((await client.client.listTools()).tools[0].name).toBe("echo");
    } finally {
      await client.close();
    }
  } finally {
    await sibling?.close();
    const ownedPids = await pids(pidFile);
    await context.cleanup();
    await eventually(() => ownedPids.every((pid) => !alive(pid)));
  }
}, 15_000);

for (const legacyCount of [0, 2]) {
  test(`regression: global ${MAX_SESSIONS}-resource cap includes retained modern children, ${legacyCount} legacy sessions, two endpoints and cleanup`, async () => {
    const context = await setup(await configFor({}));
    const pidFile = join(context.directory, "pids");
    const gate = join(context.directory, "cleanup-gate");
    const signalFile = join(context.directory, "cleanup-signals");
    const environment = {
      PID_FILE: pidFile,
      CLEANUP_GATE_FILE: gate,
      CLEANUP_SIGNAL_FILE: signalFile,
    };
    const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
    try {
      const config = await configFor({
        echo: stdio(environment),
        other: stdio(environment),
      });
      await context.controller.saveConfig(
        JSON.stringify(config),
        context.controller.snapshot().revision,
      );
      const { address } = await context.controller.start();
      for (let i = 0; i < legacyCount; i++)
        clients.push(await connect(address as string, i % 2 ? "other" : "echo"));
      const handles: Array<{ endpoint: string; state: string }> = [];
      for (let i = legacyCount; i < MAX_SESSIONS; i++) {
        const endpoint = i % 2 ? "other" : "echo";
        const result = await modern(address as string, endpoint);
        expect(result.status).toBe(200);
        expect(result.message.result.requestState).toMatch(/^sgw:/);
        handles.push({ endpoint, state: result.message.result.requestState });
      }
      await eventually(async () => (await pids(pidFile)).filter(alive).length === MAX_SESSIONS);
      const excess = await modern(address as string, "other");
      const liveAtCapacity = (await pids(pidFile)).filter(alive).length;
      // DELETE acknowledges before asynchronous child cleanup; admission must retain those slots.
      for (const client of clients.splice(0)) await client.close();
      if (legacyCount) {
        await eventually(async () => (await pids(signalFile)).length === legacyCount);
        expect((await pids(signalFile)).filter(alive)).toHaveLength(legacyCount);
      }
      const duringCleanup = legacyCount ? await modern(address as string, "echo") : null;
      const retainedPid = (await pids(pidFile))[legacyCount];
      const resumed = await modern(address as string, handles[0].endpoint, handles[0].state);
      expect(resumed.status).toBe(200);
      expect(resumed.message.error).toBeUndefined();
      expect(resumed.message.result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ value: "resumed", count: 1, pid: retainedPid, argv: [] }),
        },
      ]);
      await Bun.write(gate, "release");
      await context.controller.stop();
      await eventually(async () => (await pids(pidFile)).every((pid) => !alive(pid)));
      await context.controller.start();
      const afterCleanup = await connect(context.controller.snapshot().address as string);
      await afterCleanup.close();
      expect(excess.status).toBe(429);
      expect(liveAtCapacity).toBeLessThanOrEqual(MAX_SESSIONS);
      if (duringCleanup) expect(duringCleanup.status).toBe(429);
    } finally {
      await Bun.write(gate, "release");
      for (const client of clients) await client.close();
      const ownedPids = await pids(pidFile);
      await context.cleanup();
      await eventually(() => ownedPids.every((pid) => !alive(pid)));
    }
  }, 30_000);
}

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
    let local: Awaited<ReturnType<typeof connect>> | undefined;
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
      local = await connect(address as string);
      let state = "";
      for (let i = 1; i < MAX_SESSIONS; i++) {
        const result = await modern(address as string, "remote");
        expect(result.status).toBe(200);
        expect(result.message.error).toBeUndefined();
        expect(result.message.result.requestState).toMatch(/^sgw:/);
        state = result.message.result.requestState;
      }
      const beforeExcess = received.length;
      expect((await modern(address as string, "remote")).status).toBe(429);
      expect(received).toHaveLength(beforeExcess);
      const resumed = await modern(address as string, "remote", state);
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
      expect((await local.client.listTools()).tools[0].name).toBe("echo");
      await context.controller.stop();
      await context.controller.start();
      const afterCleanup = await modern(context.controller.snapshot().address as string, "remote");
      expect(afterCleanup.status).toBe(200);
      expect(afterCleanup.message.result.requestState).toMatch(/^sgw:/);
    } finally {
      await local?.client.close();
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
  const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
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
    for (let i = 1; i < MAX_SESSIONS; i++) clients.push(await connect(address as string));
    const completed = await modern(address as string, "modern", undefined, "echo");
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
    for (const client of clients) await client.close();
    const ownedPids = await pids(pidFile);
    await context.cleanup();
    await eventually(() => ownedPids.every((pid) => !alive(pid)));
  }
}, 20_000);

async function legacyCall(
  address: string,
  session: string,
  id: string | number,
  marker: string,
  options: {
    delay?: number;
    progressToken?: string | number;
    signal?: AbortSignal;
    value?: string;
  } = {},
) {
  const response = await fetch(`${address}/mcp/echo`, {
    method: "POST",
    signal: options.signal ?? AbortSignal.timeout(5_000),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": session,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "delay",
        arguments: {
          delay: options.delay ?? 20_000,
          marker,
          value: options.value ?? "synthetic-malformed-value",
        },
        ...(options.progressToken === undefined
          ? {}
          : { _meta: { progressToken: options.progressToken } }),
      },
    }),
  });
  const text = await response.text();
  return {
    status: response.status,
    messages: response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
      : [JSON.parse(text) as Record<string, unknown>],
  };
}

function messagesOf(text: string, contentType: string | null): Record<string, unknown>[] {
  return contentType?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    : [JSON.parse(text) as Record<string, unknown>];
}

/** One legacy POST carrying a single message or a batch. */
async function legacyBatch(address: string, session: string, payload: unknown[]) {
  const response = await fetch(`${address}/mcp/echo`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": session,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return {
    status: response.status,
    messages: response.headers.get("content-type")?.includes("application/json")
      ? [JSON.parse(text) as Record<string, unknown>]
      : messagesOf(text, response.headers.get("content-type")),
  };
}

/** Start a legacy POST and leave its response body unread. */
function openSessionPost(address: string, session: string, payload: unknown): Promise<Response> {
  return fetch(`${address}/mcp/echo`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": session,
    },
    body: JSON.stringify(payload),
  });
}

function delayMessage(
  id: string | number,
  marker: string,
  options: { delay?: number; progressToken?: string | number; value?: string } = {},
) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "delay",
      arguments: {
        delay: options.delay ?? 20_000,
        marker,
        value: options.value ?? "synthetic-malformed-value",
      },
      ...(options.progressToken === undefined
        ? {}
        : { _meta: { progressToken: options.progressToken } }),
    },
  };
}

async function legacyCancel(address: string, session: string, requestId: unknown) {
  const response = await fetch(`${address}/mcp/echo`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": session,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId },
    }),
  });
  await response.text();
  return response.status;
}

async function callLogEntries(path: string): Promise<{ wire: string; marker: string }[]> {
  try {
    return (await Bun.file(path).text())
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [wire, marker = ""] = line.split("\t");
        return { wire, marker };
      });
  } catch {
    return [];
  }
}

test("regression: capacity refusals settle legacy session state and duplicates never reach the session", async () => {
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "routing-calls");
  const pidFile = join(context.directory, "routing-pids");
  const aborts: AbortController[] = [];
  let client: Client | undefined;
  try {
    const config = await configFor({ echo: stdio({ CALL_LOG: callLog, PID_FILE: pidFile }) });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    client = new Client(
      { name: "synthetic-routing-client", version: "1.0.0" },
      { capabilities: { roots: { listChanged: true } } },
    );
    const logging: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      logging.push(notification.params);
    });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: "file:///synthetic-root", name: "synthetic" }],
    }));
    const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp/echo`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport, { timeout: 8_000 });
    const session = transport.sessionId as string;

    for (let index = 0; index < MAX_BACKEND_CALLS; index++) {
      const marker = `fill-${index}`;
      const abort = new AbortController();
      aborts.push(abort);
      void legacyCall(address as string, session, 100 + index, marker, {
        signal: abort.signal,
      }).catch(() => {});
      await eventually(async () =>
        (await callLogEntries(callLog)).some((entry) => entry.marker === marker),
      );
    }
    const refused = await legacyCall(address as string, session, 900, "refused", {
      progressToken: "refused-progress-token",
    });
    expect(refused.messages[0]).toMatchObject({ error: { code: 1001 } });
    const duplicate = await legacyCall(address as string, session, 100, "duplicate", {
      progressToken: "duplicate-progress-token",
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 100,
      error: { code: -32600 },
    });
    expect((await callLogEntries(callLog)).some((entry) => entry.marker === "duplicate")).toBe(
      false,
    );
    for (const abort of aborts.splice(0)) abort.abort();
    for (let index = 0; index < MAX_BACKEND_CALLS; index++)
      expect(await legacyCancel(address as string, session, 100 + index)).toBe(202);
    // A capacity-refused request's in-dispatch claim was released.
    const refusedReuse = await legacyCall(address as string, session, 900, "refused-reuse", {
      delay: 20,
    });
    expect(refusedReuse.messages[0].id).toBe(900);
    expect(typeof refusedReuse.messages[0].result).toBe("object");

    const progress: unknown[] = [];
    const result = await within(
      client.callTool({ name: "server-request", arguments: {} }, undefined, {
        onprogress: (value) => progress.push(value),
      }),
      5_000,
    );
    const payload = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    ) as { clientResponse?: { roots?: unknown } };
    expect(payload.clientResponse).toEqual({
      roots: [{ uri: "file:///synthetic-root", name: "synthetic" }],
    });
    expect(progress).toHaveLength(1);
    expect(logging).toContainEqual(
      expect.objectContaining({ data: "synthetic-backend-notification" }),
    );
  } finally {
    for (const abort of aborts) abort.abort();
    await client?.close().catch(() => {});
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);

for (const shape of ["no-result", "both", "null", "primitive"] as const) {
  test(`regression: malformed legacy ${shape} replies retain work until a valid reply frees only that call`, async () => {
    const context = await setup(await configFor({}));
    const callLog = join(context.directory, "malformed-calls");
    const signalFile = join(context.directory, "malformed-signal");
    const pidFile = join(context.directory, "malformed-pids");
    const aborts: AbortController[] = [];
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      const config = await configFor({
        echo: stdio({
          CALL_LOG: callLog,
          PID_FILE: pidFile,
          MALFORMED_RESPONSE_MARKER: "malformed",
          MALFORMED_RESPONSE_SHAPE: shape,
          MALFORMED_SIGNAL_FILE: signalFile,
        }),
      });
      await context.controller.saveConfig(
        JSON.stringify(config),
        context.controller.snapshot().revision,
      );
      const { address } = await context.controller.start();
      client = await connect(address as string);
      const session = client.transport.sessionId as string;
      for (let index = 0; index < MAX_BACKEND_CALLS - 1; index++) {
        const marker = `fill-${index}`;
        const abort = new AbortController();
        aborts.push(abort);
        void legacyCall(address as string, session, 100 + index, marker, {
          signal: abort.signal,
        }).catch(() => {});
        await eventually(async () =>
          (await callLogEntries(callLog)).some((entry) => entry.marker === marker),
        );
      }
      const malformed = legacyCall(address as string, session, 900, "malformed");
      await eventually(async () =>
        (await callLogEntries(callLog)).some((entry) => entry.marker === "malformed"),
      );
      await eventually(async () => (await Bun.file(signalFile).exists()) === true);
      await Bun.sleep(100);
      const refused = await legacyCall(address as string, session, 901, "probe", { delay: 20 });
      expect(refused.messages[0]).toMatchObject({ error: { code: 1001 } });
      expect((await callLogEntries(callLog)).some((entry) => entry.marker === "probe")).toBe(false);
      expect(
        context.controller.readLogs({
          after: 0,
          text: "Legacy backend response envelope was malformed.",
        }).entries,
      ).toHaveLength(1);
      expect(
        context.controller.readLogs({ after: 0, text: "Child non-JSON" }).entries,
      ).toHaveLength(0);

      const response = await malformed;
      expect(response.messages).toHaveLength(1);
      const payload = JSON.parse(
        (response.messages[0].result as { content: Array<{ text: string }> }).content[0].text,
      ) as { value?: string; count?: number };
      expect(payload).toMatchObject({
        value: "synthetic-malformed-value",
        count: expect.any(Number),
      });
      const after = await legacyCall(address as string, session, 902, "after", { delay: 20 });
      expect(after.messages[0]).toMatchObject({ id: 902, result: expect.any(Object) });
      expect(await callLogEntries(callLog)).toContainEqual(
        expect.objectContaining({ marker: "after" }),
      );
      for (const abort of aborts.splice(0)) abort.abort();
    } finally {
      for (const abort of aborts) abort.abort();
      await client?.close().catch(() => {});
      const processes = await pids(pidFile);
      await context.cleanup();
      await eventually(() => processes.every((pid) => !alive(pid)));
    }
  }, 25_000);
}

async function routingClient(address: string) {
  const client = new Client(
    { name: "synthetic-batch-client", version: "1.0.0" },
    { capabilities: { roots: { listChanged: true } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: "file:///synthetic-root", name: "synthetic" }],
  }));
  const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp/echo`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport, { timeout: 8_000 });
  return { client, session: transport.sessionId as string };
}

test("regression: a one-element legacy batch duplicate is refused before SDK dispatch and the original stream keeps its reply", async () => {
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "batch-calls");
  const pidFile = join(context.directory, "batch-pids");
  let client: Client | undefined;
  try {
    const config = await configFor({ echo: stdio({ CALL_LOG: callLog, PID_FILE: pidFile }) });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    const routing = await routingClient(address as string);
    client = routing.client;
    const original = legacyCall(address as string, routing.session, 100, "original", {
      delay: 500,
      value: "original-value",
    });
    original.catch(() => {});
    await eventually(async () =>
      (await callLogEntries(callLog)).some((entry) => entry.marker === "original"),
    );
    const duplicate = await legacyBatch(address as string, routing.session, [
      delayMessage(100, "batch-duplicate", {
        delay: 20,
        progressToken: "batch-duplicate-token",
      }),
    ]);
    expect(duplicate.status).toBe(400);
    expect(duplicate.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32600 },
    });
    expect(await callLogEntries(callLog)).not.toContainEqual(
      expect.objectContaining({ marker: "batch-duplicate" }),
    );
    const originalResponse = await original;
    expect(originalResponse.messages).toHaveLength(1);
    expect(originalResponse.messages[0].id).toBe(100);
    expect(typeof originalResponse.messages[0].result).toBe("object");
    expect(
      JSON.parse(
        (originalResponse.messages[0].result as { content: Array<{ text: string }> }).content[0]
          .text,
      ),
    ).toMatchObject({ value: "original-value" });
    // The refused batch's progress token cannot leak into the session: a later
    // reverse request and its progress are delivered on their own call.
    const progress: unknown[] = [];
    const reverse = await within(
      client.callTool({ name: "server-request", arguments: {} }, undefined, {
        onprogress: (value) => progress.push(value),
      }),
      5_000,
    );
    const reversePayload = JSON.parse(
      (reverse.content as Array<{ type: string; text: string }>)[0].text,
    ) as { clientResponse?: { roots?: Array<{ uri?: string }> } };
    expect(reversePayload.clientResponse?.roots?.[0]?.uri).toBe("file:///synthetic-root");
    expect(progress).toHaveLength(1);
  } finally {
    await client?.close().catch(() => {});
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);

test("regression: duplicate ids within one legacy batch dispatch nothing", async () => {
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "within-batch-calls");
  const pidFile = join(context.directory, "within-batch-pids");
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const config = await configFor({ echo: stdio({ CALL_LOG: callLog, PID_FILE: pidFile }) });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    client = await connect(address as string);
    const session = client.transport.sessionId as string;
    const batch = await legacyBatch(address as string, session, [
      delayMessage(200, "within-a", { delay: 20 }),
      delayMessage(200, "within-b", { delay: 20 }),
    ]);
    expect(batch.status).toBe(400);
    expect(batch.messages[0]).toMatchObject({ error: { code: -32600 } });
    const dispatched = await callLogEntries(callLog);
    expect(dispatched).not.toContainEqual(expect.objectContaining({ marker: "within-a" }));
    expect(dispatched).not.toContainEqual(expect.objectContaining({ marker: "within-b" }));
    // The refused batch left no claim behind.
    const after = await legacyCall(address as string, session, 200, "within-after", { delay: 20 });
    expect(after.messages[0]).toMatchObject({ id: 200, result: expect.any(Object) });
    expect(await callLogEntries(callLog)).toContainEqual(
      expect.objectContaining({ marker: "within-after" }),
    );
  } finally {
    await client?.close().catch(() => {});
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 20_000);

test("regression: a valid distinct-id legacy batch preserves results, notifications and client responses", async () => {
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "mixed-calls");
  const notificationLog = join(context.directory, "mixed-notifications");
  const pidFile = join(context.directory, "mixed-pids");
  try {
    const config = await configFor({
      echo: stdio({
        CALL_LOG: callLog,
        NOTIFICATION_LOG: notificationLog,
        PID_FILE: pidFile,
      }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    const initialize = await fetch(`${address}/mcp/echo`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
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
          clientInfo: { name: "raw-batch-client", version: "1" },
        },
      }),
    });
    const session = initialize.headers.get("mcp-session-id");
    expect(session).toBeString();
    await initialize.text();
    const server = openSessionPost(address as string, session as string, {
      jsonrpc: "2.0",
      id: 300,
      method: "tools/call",
      params: { name: "server-request", arguments: { marker: "server" } },
    });
    await eventually(async () =>
      (await callLogEntries(callLog)).some((entry) => entry.marker === "server"),
    );
    const mixed = await legacyBatch(address as string, session as string, [
      {
        jsonrpc: "2.0",
        id: 1,
        result: { roots: [{ uri: "file:///synthetic-root", name: "synthetic" }] },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      delayMessage(301, "mixed-call", { delay: 20, value: "batch-value" }),
    ]);
    expect(mixed.status).toBe(200);
    expect(mixed.messages).toHaveLength(1);
    expect(mixed.messages[0].id).toBe(301);
    expect(typeof mixed.messages[0].result).toBe("object");
    expect(
      JSON.parse(
        (mixed.messages[0].result as { content: Array<{ text: string }> }).content[0].text,
      ),
    ).toMatchObject({ value: "batch-value" });
    const serverResponse = await server;
    const serverMessages = messagesOf(
      await serverResponse.text(),
      serverResponse.headers.get("content-type"),
    );
    const serverResult = serverMessages.find(
      (message) => message.id === 300 && "result" in message,
    );
    if (!serverResult) throw new Error("Expected the server-request call result");
    expect(
      JSON.parse((serverResult.result as { content: Array<{ text: string }> }).content[0].text),
    ).toMatchObject({
      clientResponse: {
        roots: [{ uri: "file:///synthetic-root", name: "synthetic" }],
      },
    });
    expect(await Bun.file(notificationLog).text()).toContain("notifications/initialized");
  } finally {
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);

test("regression: concurrent legacy duplicates are refused by per-transport claims before SDK dispatch", async () => {
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "concurrent-calls");
  const pidFile = join(context.directory, "concurrent-pids");
  const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
  const base = StatefulSessions.prototype.post;
  let restore: (() => void) | undefined;
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  try {
    const config = await configFor({ echo: stdio({ CALL_LOG: callLog, PID_FILE: pidFile }) });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    clients.push(await connect(address as string), await connect(address as string));
    const [session, sibling] = clients.map((client) => client.transport.sessionId as string);
    let calls = 0;
    const spy = spyOn(StatefulSessions.prototype, "post").mockImplementation(async function (
      this: StatefulSessions,
      ...args: Parameters<typeof base>
    ) {
      if (++calls === 1) {
        firstEntered();
        await hold;
      }
      return base.apply(this, args);
    });
    restore = () => spy.mockRestore();
    const first = legacyCall(address as string, session, 100, "concurrent-first", {
      delay: 300,
      value: "first-value",
    });
    first.catch(() => {});
    await within(entered, 5_000);
    const duplicate = await legacyCall(address as string, session, 100, "concurrent-duplicate", {
      delay: 20,
      progressToken: "concurrent-token",
    });
    expect(duplicate.status).toBe(400);
    expect(duplicate.messages[0]).toEqual({
      jsonrpc: "2.0",
      id: 100,
      error: { code: -32600, message: "Duplicate in-flight request id." },
    });
    // A sibling session's identical id is independent of the held claim.
    const siblingCall = await legacyCall(address as string, sibling, 100, "sibling-first", {
      delay: 20,
    });
    expect(siblingCall.messages[0].id).toBe(100);
    expect(typeof siblingCall.messages[0].result).toBe("object");
    releaseFirst();
    const firstResponse = await first;
    expect(firstResponse.messages[0].id).toBe(100);
    expect(
      JSON.parse(
        (firstResponse.messages[0].result as { content: Array<{ text: string }> }).content[0].text,
      ),
    ).toMatchObject({ value: "first-value" });
    const dispatched = await callLogEntries(callLog);
    expect(dispatched).toContainEqual(expect.objectContaining({ marker: "concurrent-first" }));
    expect(dispatched).toContainEqual(expect.objectContaining({ marker: "sibling-first" }));
    expect(dispatched).not.toContainEqual(
      expect.objectContaining({ marker: "concurrent-duplicate" }),
    );
    // The normal completion released this invocation's claim.
    const reused = await legacyCall(address as string, session, 100, "concurrent-reuse", {
      delay: 20,
    });
    expect(reused.messages[0].id).toBe(100);
    expect(typeof reused.messages[0].result).toBe("object");
    // A failed inherited dispatch also releases its claim.
    let throwOnce = true;
    spy.mockImplementation(async function (
      this: StatefulSessions,
      ...args: Parameters<typeof base>
    ) {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("synthetic dispatch failure");
      }
      return base.apply(this, args);
    });
    const failed = await openSessionPost(
      address as string,
      session,
      delayMessage(103, "throw-failed", { delay: 20 }),
    );
    expect(failed.status).toBe(502);
    await failed.text();
    const retried = await legacyCall(address as string, session, 103, "throw-retried", {
      delay: 20,
    });
    expect(retried.messages[0].id).toBe(103);
    expect(typeof retried.messages[0].result).toBe("object");
  } finally {
    releaseFirst();
    restore?.();
    for (const client of clients) await client.client.close().catch(() => {});
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 30_000);
