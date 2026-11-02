import { expect, test } from "bun:test";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { MAX_SESSIONS } from "../../src/core/ingress";
import { alive, configFor, connect, eventually, pids, setup, stdio, TOKEN } from "../core/helpers";

// Ordinary regression tests: protocol or admission regressions must fail the unit command.
async function modern(address: string, endpoint: string, requestState?: string, name = "ask") {
  const response = await fetch(`${address}/mcp/${endpoint}`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
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
        arguments: { value: "resumed" },
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

test("regression: modern HTTP continuations share admission with stdio and isolate configured upstream credentials", async () => {
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
      result = { resultType: "input_required", requestState: "opaque-upstream-state", content: [] };
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
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
}, 20_000);

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
