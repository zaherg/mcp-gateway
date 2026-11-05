import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { join } from "node:path";
import { backendSummary } from "../../src/core/adapter";
import { diagnosticText, LogBuffer } from "../../src/core/logs";
import { LOG_LIMITS, type LogPage, type LogQuery } from "../../src/shared/logs";
import { alive, configFor, connect, eventually, pids, setup, stdio, TOKEN } from "./helpers";

const metadata = { server: "synthetic", level: "debug", source: "logger" } as const;
function all(buffer: { readLogs(query: LogQuery): LogPage }): string {
  let cursor = 0;
  let text = "";
  for (;;) {
    const page = buffer.readLogs({ after: cursor });
    text += page.entries.map((entry) => entry.text).join("\n");
    if (!page.hasMore) return text;
    expect(page.cursor).toBeGreaterThan(cursor);
    cursor = page.cursor;
  }
}

test("log buffer keeps monotonic IDs, stable timestamps, exact raw text, levels, filters, bounded pages and clear generations", () => {
  const buffer = new LogBuffer();
  for (let index = 0; index < 110; index++)
    buffer.append({ ...metadata, level: index % 2 ? "warn" : "debug" }, [
      `raw fake-password=fixture-only ${index}\n`,
    ]);
  const first = buffer.read({ after: 0 });
  expect(first.entries).toHaveLength(LOG_LIMITS.batchEntries);
  expect(first.entries[0]).toEqual({
    ...metadata,
    id: 1,
    text: "raw fake-password=fixture-only 0\n",
    time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    truncated: false,
  });
  expect(first.cursor).toBe(50);
  expect(first.hasMore).toBe(true);
  expect(buffer.read({ after: 50 }).entries[0].id).toBe(51);
  expect(
    buffer
      .read({ after: 0, level: "warn", server: "synthetic", text: "PASSWORD=fixture-only 109" })
      .entries.map((entry) => entry.id),
  ).toEqual([110]);
  expect(buffer.read({ after: 0, text: "absent" })).toMatchObject({
    entries: [],
    cursor: 110,
    hasMore: false,
  });
  const cleared = buffer.clear();
  expect(cleared).toEqual({ entries: [], cursor: 110, generation: 1, gap: false, hasMore: false });
  buffer.append(metadata, ["after clear"]);
  expect(buffer.read({ after: 50 })).toMatchObject({ generation: 1, gap: true, cursor: 111 });
  expect(buffer.read({ after: 900 })).toMatchObject({ generation: 1, gap: true, cursor: 111 });
  expect(buffer.read({ after: 110 }).entries[0].id).toBe(111);
});

test("log buffer entry/total/response byte caps include Unicode, escaping and metadata; count retention reports cursor gaps", () => {
  const buffer = new LogBuffer();
  for (let index = 0; index < 600; index++) buffer.append(metadata, [String(index)]);
  expect(buffer.read({ after: 0 })).toMatchObject({ gap: true, cursor: 150 });
  expect(buffer.read({ after: 0 }).entries[0].id).toBe(101);
  buffer.clear();
  for (let index = 0; index < 200; index++) buffer.append(metadata, ["\u0000🦊".repeat(20_000)]);
  let cursor = 0;
  let count = 0;
  let bytes = 2;
  for (;;) {
    const page = buffer.read({ after: cursor });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(LOG_LIMITS.batchBytes);
    for (const entry of page.entries) {
      expect(entry.truncated).toBe(true);
      expect(entry.text).toEndWith("[entry truncated]");
      expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(LOG_LIMITS.entryBytes);
      bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
      count++;
    }
    cursor = page.cursor;
    if (!page.hasMore) break;
  }
  expect(count).toBeGreaterThan(100);
  expect(count).toBeLessThan(200);
  expect(bytes).toBeLessThanOrEqual(LOG_LIMITS.bytes);
});

test("diagnostic formatting captures Error stack/cause and circular values without executing getters, toJSON, toString or custom inspection", () => {
  let executed = false;
  const cause = Object.assign(new Error("synthetic secret cause"), { code: "ECONNREFUSED" });
  const error = Object.assign(new Error("synthetic top error", { cause }), {
    detail: "fake-password=fixture-only",
  });
  const circular: { error: Error; self?: unknown } = { error };
  circular.self = circular;
  Object.defineProperty(circular, "danger", {
    get() {
      executed = true;
      throw new Error("Getter executed");
    },
  });
  const text = diagnosticText([
    circular,
    {
      toJSON() {
        executed = true;
      },
      toString() {
        executed = true;
      },
      [Symbol.for("nodejs.util.inspect.custom")]() {
        executed = true;
      },
    },
  ]);
  expect(text).toContain("stack:");
  expect(text).toContain("synthetic secret cause");
  expect(text).toContain("ECONNREFUSED");
  expect(text).toContain("fake-password=fixture-only");
  expect(text).toContain("[circular]");
  expect(text).toContain("[accessor]");
  expect(executed).toBe(false);
  expect(
    diagnosticText([
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("Synthetic proxy refusal");
          },
        },
      ),
    ]),
  ).toContain("[unreadable object]");
});

test("safe backend summaries allow only OS codes, HTTP statuses and process exit data, never raw values or getters", () => {
  const enoent = Object.assign(new Error("fake-secret=fixture-only"), { code: "ENOENT" });
  expect(backendSummary([new Error("outer synthetic failure", { cause: enoent })])).toContain(
    "ENOENT",
  );
  expect(backendSummary([new Error("Child exited: code=7, signal=SIGFAKECREDENTIAL")])).toBe(
    "A backend operation failed. Open Logs for details.",
  );
  expect(backendSummary([enoent])).toBe(
    "Backend failed (ENOENT). Check the executable, permissions or connection. Open Logs for details.",
  );
  expect(backendSummary([{ status: 503, body: "fake-secret=fixture-only" }])).toBe(
    "Backend HTTP request failed (503). Open Logs for details.",
  );
  expect(backendSummary([new Error("Child exited: code=7, signal=null")])).toBe(
    "Backend process exited (code 7, signal null). Open Logs for details.",
  );
  expect(backendSummary(["Child exited: code=null, signal=SIGTERM"])).toBe(
    "Backend process exited (code null, signal SIGTERM). Open Logs for details.",
  );
  expect(backendSummary([new Error("fake-secret=fixture-only")])).toBe(
    "A backend operation failed. Open Logs for details.",
  );
  let called = false;
  expect(
    backendSummary([
      {
        get status() {
          called = true;
          return 503;
        },
      },
    ]),
  ).toBe("A backend operation failed. Open Logs for details.");
  expect(called).toBe(false);
});

test("synthetic stderr and logger protocol values stay full in local logs but not summaries; benign stderr is not failure and no LAN log route exists", async () => {
  const context = await setup(
    await configFor({
      echo: stdio({ PRIVATE_DIAGNOSTIC: "synthetic-fake-password=fixture-only\n" }),
    }),
  );
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const started = await context.controller.start();
    client = await connect(started.address as string);
    await client.client.callTool({ name: "echo", arguments: { value: "synthetic note payload" } });
    await eventually(() =>
      all(context.controller).includes("synthetic-fake-password=fixture-only"),
    );
    // Stateless 2026-07-28 bodies are never logged: only fixture stderr and
    // lifecycle lines reach local Logs.
    expect(all(context.controller)).not.toContain("synthetic note payload");
    expect(
      context.controller
        .readLogs({ after: 0, level: "error" })
        .entries.some((entry) => entry.source === "stderr"),
    ).toBe(true);
    const snapshot = context.controller.snapshot();
    expect(snapshot.operationalError).toBeNull();
    expect(snapshot.servers[0].error).toBeNull();
    expect(
      JSON.stringify({ events: snapshot.events, error: snapshot.operationalError }),
    ).not.toContain("fixture-only");
    expect("logs" in snapshot).toBe(false);
    for (const route of ["/logs", "/readLogs", "/clearLogs", "/mcp/echo/logs"]) {
      const response = await fetch(`${started.address}${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  } finally {
    await client?.close();
    await context.cleanup();
  }
});

test("actual spawn error and process exit retain synthetic detail locally, sanitized MCP responses and new stable failure occurrences", async () => {
  const context = await setup(
    await configFor({ echo: { command: "/synthetic-fixture-only/missing" } }),
  );
  try {
    const started = await context.controller.start();
    const probe = async () => {
      const response = await fetch(`${started.address}/mcp/echo`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      const text = await response.text();
      expect(text).not.toContain("fixture-only");
      expect(text).toContain("MCP server process failed");
    };
    await probe();
    await eventually(() => context.controller.snapshot().operationalError !== null);
    const first = context.controller.snapshot().operationalError;
    expect(first?.message).toContain("ENOENT");
    expect(all(context.controller)).toContain("/synthetic-fixture-only/missing");
    expect(all(context.controller)).toContain("stack:");
    expect(
      JSON.stringify({ events: context.controller.snapshot().events, error: first }),
    ).not.toContain("fixture-only");
    expect(context.controller.snapshot().operationalError?.occurrenceId).toBe(first?.occurrenceId);
    context.controller.clearLogs();
    expect(context.controller.snapshot().operationalError).toEqual(first);
    await context.controller.restartServer("echo");
    await probe();
    expect(context.controller.snapshot().operationalError?.occurrenceId).not.toBe(
      first?.occurrenceId,
    );
    const before = context.controller.snapshot();
    const next = JSON.parse(before.configText);
    next.mcpServers.echo = stdio({ SYNTHETIC_EXIT_CODE: "7" });
    await context.controller.saveConfig(JSON.stringify(next), before.revision);
    await probe();
    await eventually(
      () => context.controller.snapshot().operationalError?.occurrenceId !== first?.occurrenceId,
    );
    // A backend that starts and then exits nonzero is a distinct new failure.
    expect(context.controller.snapshot().operationalError?.code).toBe("BackendFailure");
  } finally {
    await context.cleanup();
  }
});

test("an unsanctioned SIGTERM of a retained child is recorded as a backend failure", async () => {
  const context = await setup(await configFor({}));
  const pidFile = join(context.directory, "pids");
  try {
    await context.controller.saveConfig(
      JSON.stringify(await configFor({ echo: stdio({ PID_FILE: pidFile }) })),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    const client = await connect(address as string);
    // Retain one child so its pid is observable.
    await client.client.callTool({ name: "ask", arguments: {} });
    await eventually(async () => (await pids(pidFile)).filter(alive).length === 1);
    const owned = (await pids(pidFile)).find(alive);
    if (!owned) throw new Error("Missing retained child");
    expect(alive(owned)).toBe(true);
    expect(context.controller.snapshot().operationalError).toBeNull();
    process.kill(owned, "SIGTERM");
    await eventually(() => context.controller.snapshot().operationalError !== null);
    expect(context.controller.snapshot().operationalError?.code).toBe("BackendFailure");
    // The endpoint stays mounted and usable despite the recorded failure.
    expect(context.controller.snapshot().servers[0].status).toBe("mounted");
    const fresh = await connect(address as string);
    expect((await fresh.client.listTools()).tools[0].name).toBe("echo");
    await client.close();
  } finally {
    const owned = await pids(pidFile);
    await context.cleanup();
    await eventually(() => owned.every((pid) => !alive(pid)));
  }
});
test("actual HTTP failure retains no upstream body and only status in summaries/MCP responses", async () => {
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === "server/discover") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { supportedVersions: ["2026-07-28"] },
        }),
      );
      return;
    }
    res.writeHead(503).end("synthetic-fake-upstream-credential=fixture-only");
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No synthetic listener");
  const context = await setup(
    await configFor({ echo: { url: `http://127.0.0.1:${address.port}/mcp` } }),
  );
  try {
    const started = await context.controller.start();
    await expect(connect(started.address as string)).rejects.toThrow();
    await eventually(() => context.controller.snapshot().operationalError !== null);
    expect(context.controller.snapshot().operationalError?.message).toContain("503");
    // Modern HTTP backends never surface upstream response bodies in local
    // logs or summaries.
    expect(all(context.controller)).not.toContain("fixture-only");
    expect(JSON.stringify(context.controller.snapshot().events)).not.toContain("fixture-only");
  } finally {
    await context.cleanup();
    await new Promise<void>((done) => upstream.close(() => done()));
  }
});
