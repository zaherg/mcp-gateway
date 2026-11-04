import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as serverSource from "supergateway/dist/lib/serverSource.js";
import {
  BACKEND_CAPACITY_ERROR,
  DUPLICATE_REQUEST_ERROR,
  MAX_BACKEND_CALLS,
} from "../../src/core/backend-work";
import { alive, configFor, connect, eventually, pids, setup, stdio, TOKEN } from "../core/helpers";

// Ordinary regression tests: admission regressions must fail the unit command.
type CallId = string | number;

interface Dispatch {
  /** The id this peer sent to the backend: a remapped wire id for legacy calls. */
  wire: number;
  marker: string;
}

async function started(path: string): Promise<Dispatch[]> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [wire, marker = ""] = line.split("\t");
        return { wire: Number(wire), marker };
      });
  } catch {
    return [];
  }
}

function dispatched(entries: Dispatch[], marker: string): boolean {
  return entries.some((entry) => entry.marker === marker);
}

function wireOf(entries: Dispatch[], marker: string): number | undefined {
  return entries.find((entry) => entry.marker === marker)?.wire;
}

function sseMessages(text: string): Record<string, unknown>[] {
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  return data.length ? data : [JSON.parse(text) as Record<string, unknown>];
}

function sessionHeaders(session: string) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Mcp-Session-Id": session,
  };
}

function delayBody(id: CallId, delay: number, marker: string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "delay", arguments: { delay, marker } },
  });
}

async function delayCall(
  address: string,
  session: string,
  id: CallId,
  delay: number,
  marker: string,
) {
  const response = await fetch(`${address}/mcp/echo`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: sessionHeaders(session),
    body: delayBody(id, delay, marker),
  });
  return { status: response.status, messages: sseMessages(await response.text()) };
}

/** One validated session call whose response the caller abandons unread. */
function disconnected(
  address: string,
  session: string,
  id: CallId,
  marker: string,
  delay = 20_000,
): AbortController {
  const abort = new AbortController();
  const response = fetch(`${address}/mcp/echo`, {
    method: "POST",
    signal: abort.signal,
    headers: sessionHeaders(session),
    body: delayBody(id, delay, marker),
  });
  // A network disconnect is not the protocol's notifications/cancelled.
  response.catch(() => {});
  return abort;
}

async function cancel(address: string, session: string, requestId: unknown): Promise<number> {
  const response = await fetch(`${address}/mcp/echo`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: sessionHeaders(session),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId },
    }),
  });
  await response.text();
  return response.status;
}

async function modern(
  address: string,
  endpoint: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
  requestState?: string,
) {
  const response = await fetch(`${address}/mcp/${endpoint}`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: modernHeaders(name),
    body: modernBody(id, name, args, requestState),
  });
  const text = await response.text();
  return {
    status: response.status,
    messages: response.headers.get("content-type")?.includes("text/event-stream")
      ? sseMessages(text)
      : [JSON.parse(text) as Record<string, unknown>],
  };
}

function modernHeaders(name: string) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Mcp-Protocol-Version": "2026-07-28",
    "Mcp-Method": "tools/call",
    "Mcp-Name": name,
  };
}

function modernBody(
  id: number,
  name: string,
  args: Record<string, unknown>,
  requestState?: string,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      ...(requestState === undefined ? {} : { requestState }),
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  });
}

/** A modern call whose HTTP response the caller abandons, keeping its work charged. */
function modernDisconnected(
  address: string,
  endpoint: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): AbortController {
  const abort = new AbortController();
  const response = fetch(`${address}/mcp/${endpoint}`, {
    method: "POST",
    signal: abort.signal,
    headers: modernHeaders(name),
    body: modernBody(id, name, args),
  });
  response.catch(() => {});
  return abort;
}

test("regression: failed cancellation forwarding retains the request and its reply", async () => {
  const original = serverSource.startServer;
  const mocked = spyOn(serverSource, "startServer").mockImplementation((...args) => {
    const factory = original(...args);
    return (owner) => {
      const peer = factory(owner);
      return {
        write(message) {
          if ("method" in message && message.method === "notifications/cancelled")
            throw new Error("Synthetic cancellation forwarding refusal");
          peer.write(message);
        },
        end: () => peer.end(),
        stop: () => peer.stop(),
        get gone() {
          return peer.gone;
        },
      };
    };
  });
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "calls");
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let pending: ReturnType<typeof delayCall> | undefined;
  try {
    await context.controller.saveConfig(
      JSON.stringify(await configFor({ echo: stdio({ CALL_LOG: callLog }) })),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    if (!address) throw new Error("Missing test address");
    client = await connect(address);
    const session = client.transport.sessionId;
    if (!session) throw new Error("Missing test session");
    pending = delayCall(address, session, 101, 500, "retained-after-refusal");
    const result = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await eventually(async () => dispatched(await started(callLog), "retained-after-refusal"));
    expect(await cancel(address, session, 101)).toBe(202);
    const settled = await result;
    if ("error" in settled) throw settled.error;
    expect(settled.value.status).toBe(200);
    expect(settled.value.messages).toEqual([
      expect.objectContaining({ id: 101, result: expect.any(Object) }),
    ]);
  } finally {
    mocked.mockRestore();
    await client?.close();
    await context.cleanup();
    if (pending) await Promise.allSettled([pending]);
  }
});

test("regression: disconnected session calls are bounded by one shared backend-work cap", async () => {
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "started-calls");
  const pidFile = join(context.directory, "pids");
  const aborts: AbortController[] = [];
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

    // Fill the allowed work with calls whose response streams are abandoned.
    for (let index = 0; index < MAX_BACKEND_CALLS; index++) {
      const marker = `call-${index}`;
      aborts.push(disconnected(address as string, session, 100 + index, marker));
      await eventually(async () => dispatched(await started(callLog), marker));
    }
    const filled = await started(callLog);
    expect(filled).toHaveLength(MAX_BACKEND_CALLS);
    expect(new Set(filled.map((entry) => entry.wire)).size).toBe(MAX_BACKEND_CALLS);
    for (let index = 0; index < MAX_BACKEND_CALLS; index++) {
      const wire = wireOf(filled, `call-${index}`);
      expect(wire).toBeNumber();
      // The backend sees the wire id, never the client's original id.
      expect(wire).not.toBe(100 + index);
    }
    for (const abort of aborts.splice(0)) abort.abort();
    await Bun.sleep(50);

    // The response stream is still connected here, so the refusal is the
    // validated transport's fixed JSON-RPC capacity error.
    const refused = await delayCall(address as string, session, 900, 2_000, "probe-900");
    expect(refused).toEqual({
      status: 200,
      messages: [{ jsonrpc: "2.0", id: 900, error: BACKEND_CAPACITY_ERROR }],
    });
    expect(dispatched(await started(callLog), "probe-900")).toBe(false);

    // Further disconnects above the cap dispatch no backend work.
    for (let index = 0; index < 4; index++)
      aborts.push(disconnected(address as string, session, 901 + index, `over-${index}`));
    await Bun.sleep(300);
    for (const abort of aborts.splice(0)) abort.abort();
    expect(await started(callLog)).toHaveLength(MAX_BACKEND_CALLS);

    // The forwarded protocol cancellation frees exactly its own call.
    expect(await cancel(address as string, session, 100)).toBe(202);
    const freed = await delayCall(address as string, session, 950, 20, "freed-950");
    expect(freed.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 950,
      result: { content: expect.any(Array) },
    });
    expect(dispatched(await started(callLog), "freed-950")).toBe(true);

    // Refill the budget, then prove an unknown cancellation frees nothing.
    aborts.push(disconnected(address as string, session, 960, "refill-960"));
    await eventually(async () => dispatched(await started(callLog), "refill-960"));
    for (const abort of aborts.splice(0)) abort.abort();
    expect(await cancel(address as string, session, "unknown-synthetic-id")).toBe(202);
    const stillRefused = await delayCall(address as string, session, 951, 2_000, "still-951");
    expect(stillRefused.messages[0]).toMatchObject({ id: 951, error: BACKEND_CAPACITY_ERROR });
    expect(dispatched(await started(callLog), "still-951")).toBe(false);

    // Cancelling a different owned call restores admission for a new call.
    expect(await cancel(address as string, session, 101)).toBe(202);
    const renewed = await delayCall(address as string, session, 952, 20, "renewed-952");
    expect(renewed.messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: 952,
      result: { content: expect.any(Array) },
    });
    expect(dispatched(await started(callLog), "renewed-952")).toBe(true);
  } finally {
    for (const abort of aborts) abort.abort();
    await client?.close();
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 20_000);

test("regression: duplicate in-flight ids are refused before dispatch while number 0, string 0 and siblings stay isolated", async () => {
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "started-calls");
  const pidFile = join(context.directory, "pids");
  const aborts: AbortController[] = [];
  const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
  try {
    const config = await configFor({ echo: stdio({ CALL_LOG: callLog, PID_FILE: pidFile }) });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    clients.push(await connect(address as string), await connect(address as string));
    const [first, sibling] = clients.map((client) => client.transport.sessionId as string);

    aborts.push(disconnected(address as string, first, 0, "a-zero"));
    await eventually(async () => dispatched(await started(callLog), "a-zero"));
    // A second in-flight id 0 in the same session is a protocol error, not a
    // second dispatch and not a release of the first reservation.
    const duplicate = await delayCall(address as string, first, 0, 20, "a-duplicate");
    // Duplicates are refused at the pre-transport boundary with HTTP 400.
    expect(duplicate).toEqual({
      status: 400,
      messages: [{ jsonrpc: "2.0", id: 0, error: DUPLICATE_REQUEST_ERROR }],
    });
    expect(dispatched(await started(callLog), "a-duplicate")).toBe(false);
    aborts.push(disconnected(address as string, first, "0", "a-string"));
    await eventually(async () => dispatched(await started(callLog), "a-string"));
    aborts.push(disconnected(address as string, sibling, 0, "b-zero"));
    await eventually(async () => dispatched(await started(callLog), "b-zero"));
    const identities = await started(callLog);
    expect(identities.filter((entry) => entry.marker === "a-zero")).toHaveLength(1);
    // The backend never sees the client's 0 or "0"; same-session ids stay distinct.
    expect(wireOf(identities, "a-zero")).not.toBe(0);
    expect(wireOf(identities, "a-string")).not.toBe(wireOf(identities, "a-zero"));
    // The sibling session has its own peer and id space; its identical id is isolated and dispatched.
    expect(wireOf(identities, "b-zero")).toBeNumber();
    expect(wireOf(identities, "b-zero")).not.toBe(0);

    // Fill the cap: first session keeps 0, "0" and ten fills; the sibling keeps its 0.
    for (let index = 0; index < MAX_BACKEND_CALLS - 4; index++) {
      const marker = `fill-${index}`;
      aborts.push(disconnected(address as string, first, 200 + index, marker));
      await eventually(async () => dispatched(await started(callLog), marker));
    }
    aborts.push(disconnected(address as string, sibling, 1, "b-fill"));
    await eventually(async () => dispatched(await started(callLog), "b-fill"));
    for (const abort of aborts.splice(0)) abort.abort();
    expect(
      (await delayCall(address as string, first, 999, 20, "probe-full")).messages[0],
    ).toMatchObject({ error: BACKEND_CAPACITY_ERROR });
    expect(dispatched(await started(callLog), "probe-full")).toBe(false);

    // Number and string ids are distinct reservations; each cancellation frees one.
    expect(await cancel(address as string, first, 0)).toBe(202);
    const afterNumber = await delayCall(address as string, first, 999, 20, "probe-number");
    expect(afterNumber.messages[0]).toMatchObject({ id: 999, result: expect.any(Object) });
    expect(dispatched(await started(callLog), "probe-number")).toBe(true);
    expect(await cancel(address as string, sibling, 0)).toBe(202);
    const afterSibling = await delayCall(address as string, sibling, 999, 20, "probe-sibling");
    expect(afterSibling.messages[0]).toMatchObject({ id: 999, result: expect.any(Object) });
    expect(dispatched(await started(callLog), "probe-sibling")).toBe(true);
  } finally {
    for (const abort of aborts) abort.abort();
    for (const client of clients) await client.client.close();
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);

test("regression: a late reply for a cancelled request cannot release work that reuses its id", async () => {
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "started-calls");
  const pidFile = join(context.directory, "pids");
  const aborts: AbortController[] = [];
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const config = await configFor({
      echo: stdio({ CALL_LOG: callLog, PID_FILE: pidFile, LATE_REPLY_ON_CANCEL: "1" }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    client = await connect(address as string);
    const session = client.transport.sessionId as string;

    // The cancelled backend call keeps running and will answer late.
    aborts.push(disconnected(address as string, session, 500, "old-500", 300));
    await eventually(async () => dispatched(await started(callLog), "old-500"));
    expect(await cancel(address as string, session, 500)).toBe(202);
    // Reusing the same client id starts new work under a new backend-facing id.
    aborts.push(disconnected(address as string, session, 500, "new-500"));
    await eventually(async () => dispatched(await started(callLog), "new-500"));
    const reusedIds = await started(callLog);
    const oldWire = wireOf(reusedIds, "old-500");
    const newWire = wireOf(reusedIds, "new-500");
    expect(oldWire).toBeNumber();
    expect(newWire).toBeNumber();
    expect(oldWire).not.toBe(500);
    expect(newWire).not.toBe(500);
    expect(oldWire).not.toBe(newWire);
    for (let index = 0; index < MAX_BACKEND_CALLS - 1; index++) {
      const marker = `late-fill-${index}`;
      aborts.push(disconnected(address as string, session, 600 + index, marker));
      await eventually(async () => dispatched(await started(callLog), marker));
    }
    for (const abort of aborts.splice(0)) abort.abort();
    expect(
      (await delayCall(address as string, session, 998, 20, "late-probe")).messages[0],
    ).toMatchObject({ error: BACKEND_CAPACITY_ERROR });

    // The old call's reply arrived late; it must not free the reused 500 slot.
    await Bun.sleep(400);
    expect(
      (await delayCall(address as string, session, 997, 20, "late-probe-2")).messages[0],
    ).toMatchObject({ error: BACKEND_CAPACITY_ERROR });
    expect(dispatched(await started(callLog), "late-probe")).toBe(false);

    // Cancelling the reused call frees its own slot.
    expect(await cancel(address as string, session, 500)).toBe(202);
    const after = await delayCall(address as string, session, 996, 20, "late-after");
    expect(after.messages[0]).toMatchObject({ id: 996, result: expect.any(Object) });
    expect(dispatched(await started(callLog), "late-after")).toBe(true);
  } finally {
    for (const abort of aborts) abort.abort();
    await client?.close();
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);

test("regression: backend work is shared across endpoints and generations, and a refused continuation is preserved", async () => {
  const context = await setup(await configFor({}));
  const echoCalls = join(context.directory, "echo-calls");
  const otherCalls = join(context.directory, "other-calls");
  const echoPids = join(context.directory, "echo-pids");
  const otherPids = join(context.directory, "other-pids");
  const aborts: AbortController[] = [];
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const config = await configFor({
      echo: stdio({ CALL_LOG: echoCalls, PID_FILE: echoPids }),
      other: stdio({ CALL_LOG: otherCalls, PID_FILE: otherPids }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    client = await connect(address as string, "echo");
    const session = client.transport.sessionId as string;

    // A retained modern continuation on the second endpoint.
    const opened = await modern(address as string, "other", 700, "ask", {});
    expect(opened.status).toBe(200);
    const state = (opened.messages[0].result as { requestState?: string }).requestState;
    expect(state).toMatch(/^sgw:/);

    // The legacy session fills the shared cap through disconnected calls.
    for (let index = 0; index < MAX_BACKEND_CALLS; index++) {
      const marker = `fill-${index}`;
      aborts.push(disconnected(address as string, session, 100 + index, marker));
      await eventually(async () => dispatched(await started(echoCalls), marker));
    }
    expect(await started(echoCalls)).toHaveLength(MAX_BACKEND_CALLS);
    for (const abort of aborts.splice(0)) abort.abort();

    // Refused at the shared cap without consuming the retained handle.
    const refused = await modern(
      address as string,
      "other",
      701,
      "ask",
      { value: "refused" },
      state,
    );
    expect(refused).toEqual({
      status: 429,
      messages: [{ jsonrpc: "2.0", id: 701, error: BACKEND_CAPACITY_ERROR }],
    });

    // The forwarded protocol cancellation frees one slot, and the same handle resumes.
    expect(await cancel(address as string, session, 100)).toBe(202);
    const resumed = await modern(
      address as string,
      "other",
      702,
      "ask",
      { value: "resumed" },
      state,
    );
    expect(resumed.status).toBe(200);
    const result = resumed.messages[0].result as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0].text)).toMatchObject({ value: "resumed" });

    // DELETE cleanup releases the legacy session's remaining work.
    await client.close();
    client = undefined;
    await eventually(async () => (await pids(echoPids)).every((pid) => !alive(pid)));
    await eventually(
      async () =>
        (await modern(address as string, "other", 703, "delay", { delay: 20, marker: "after" }))
          .status === 200,
    );
    // Modern per-request owners are not remapped; only legacy client ids are.
    expect(wireOf(await started(otherCalls), "after")).toBe(703);
    expect(context.controller.snapshot().servers.every((server) => server.error === null)).toBe(
      true,
    );
    expect(context.controller.snapshot().operationalError).toBeNull();
  } finally {
    for (const abort of aborts) abort.abort();
    await client?.close();
    const processes = [...(await pids(echoPids)), ...(await pids(otherPids))];
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);

test("regression: backend work stays charged until owned cleanup actually completes", async () => {
  const context = await setup(await configFor({}));
  const gate = join(context.directory, "cleanup-gate");
  const signals = join(context.directory, "cleanup-signals");
  const echoCalls = join(context.directory, "echo-calls");
  const otherCalls = join(context.directory, "other-calls");
  const echoPids = join(context.directory, "echo-pids");
  const otherPids = join(context.directory, "other-pids");
  const aborts: AbortController[] = [];
  let deleting: Promise<unknown> | undefined;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const config = await configFor({
      echo: stdio({
        CALL_LOG: echoCalls,
        PID_FILE: echoPids,
        CLEANUP_GATE_FILE: gate,
        CLEANUP_SIGNAL_FILE: signals,
      }),
      other: stdio({ CALL_LOG: otherCalls, PID_FILE: otherPids }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    client = await connect(address as string, "echo");
    const session = client.transport.sessionId as string;
    for (let index = 0; index < MAX_BACKEND_CALLS; index++) {
      const marker = `gate-${index}`;
      aborts.push(disconnected(address as string, session, 100 + index, marker));
      await eventually(async () => dispatched(await started(echoCalls), marker));
    }
    for (const abort of aborts.splice(0)) abort.abort();

    // DELETE starts the owned child cleanup, which the fixture holds until the gate opens.
    deleting = fetch(`${address}/mcp/echo`, {
      method: "DELETE",
      signal: AbortSignal.timeout(15_000),
      headers: sessionHeaders(session),
    });
    deleting.catch(() => {});
    await eventually(async () => (await pids(signals)).length === 1);
    const [stopping] = await pids(signals);
    expect(alive(stopping)).toBe(true);

    // Cleanup is in progress, not confirmed: the work budget stays charged.
    const refused = await modern(address as string, "other", 800, "delay", {
      delay: 20,
      marker: "gate-probe",
    });
    expect(refused).toEqual({
      status: 429,
      messages: [{ jsonrpc: "2.0", id: 800, error: BACKEND_CAPACITY_ERROR }],
    });
    expect(dispatched(await started(otherCalls), "gate-probe")).toBe(false);

    // The actual process cleanup frees the calls it owned.
    await Bun.write(gate, "release");
    await eventually(() => !alive(stopping));
    expect((await deleting) as Response).toMatchObject({ status: 200 });
    await eventually(
      async () =>
        (
          await modern(address as string, "other", 801, "delay", {
            delay: 20,
            marker: "gate-after",
          })
        ).status === 200,
    );
    expect(wireOf(await started(otherCalls), "gate-after")).toBe(801);
  } finally {
    await Bun.write(gate, "release");
    for (const abort of aborts) abort.abort();
    await client?.close().catch(() => {});
    const processes = [...(await pids(echoPids)), ...(await pids(otherPids))];
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);

test("regression: a disconnected modern request keeps its work until its own child cleanup ends", async () => {
  const context = await setup(await configFor({}));
  const gate = join(context.directory, "cleanup-gate");
  const signals = join(context.directory, "cleanup-signals");
  const calls = join(context.directory, "modern-calls");
  const pidFile = join(context.directory, "pids");
  const aborts: AbortController[] = [];
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const config = await configFor({
      echo: stdio({
        CALL_LOG: calls,
        PID_FILE: pidFile,
        CLEANUP_GATE_FILE: gate,
        CLEANUP_SIGNAL_FILE: signals,
      }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    client = await connect(address as string);
    const session = client.transport.sessionId as string;
    // Fill the shared budget so only the disconnected modern call is in doubt.
    for (let index = 0; index < MAX_BACKEND_CALLS - 1; index++) {
      const marker = `modern-fill-${index}`;
      aborts.push(disconnected(address as string, session, 100 + index, marker));
      await eventually(async () => dispatched(await started(calls), marker));
    }
    aborts.push(
      modernDisconnected(address as string, "echo", 810, "delay", {
        delay: 20_000,
        marker: "modern-long",
      }),
    );
    await eventually(async () => dispatched(await started(calls), "modern-long"));
    aborts[aborts.length - 1].abort();
    await eventually(async () => (await pids(signals)).length === 1);
    const [stopping] = await pids(signals);
    expect(alive(stopping)).toBe(true);

    // No terminal reply was delivered and cleanup is unconfirmed, so its slot
    // stays charged and no continuation can inherit it.
    const refused = await modern(address as string, "echo", 811, "delay", {
      delay: 20,
      marker: "modern-probe",
    });
    expect(refused.messages[0]).toMatchObject({ error: BACKEND_CAPACITY_ERROR });
    expect(dispatched(await started(calls), "modern-probe")).toBe(false);

    await Bun.write(gate, "release");
    await eventually(() => !alive(stopping));
    await eventually(
      async () =>
        (
          await modern(address as string, "echo", 812, "delay", {
            delay: 20,
            marker: "modern-after",
          })
        ).status === 200,
    );
    const deliveries = await started(calls);
    expect(wireOf(deliveries, "modern-long")).toBe(810);
    expect(wireOf(deliveries, "modern-after")).toBe(812);
    expect(wireOf(deliveries, "modern-fill-0")).not.toBe(100);
  } finally {
    await Bun.write(gate, "release");
    for (const abort of aborts) abort.abort();
    await client?.close().catch(() => {});
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);

test("regression: a failed backend session releases only its own work and leaves its sibling usable", async () => {
  const context = await setup(await configFor({}));
  const echoCalls = join(context.directory, "echo-calls");
  const echoPids = join(context.directory, "echo-pids");
  const otherCalls = join(context.directory, "other-calls");
  const otherPids = join(context.directory, "other-pids");
  const aborts: AbortController[] = [];
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const config = await configFor({
      echo: stdio({ CALL_LOG: echoCalls, PID_FILE: echoPids }),
      other: stdio({ CALL_LOG: otherCalls, PID_FILE: otherPids }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    client = await connect(address as string, "echo");
    const session = client.transport.sessionId as string;
    for (let index = 0; index < MAX_BACKEND_CALLS; index++) {
      const marker = `kill-${index}`;
      aborts.push(disconnected(address as string, session, 100 + index, marker));
      await eventually(async () => dispatched(await started(echoCalls), marker));
    }
    for (const abort of aborts.splice(0)) abort.abort();
    expect(
      (await modern(address as string, "other", 900, "delay", { delay: 20, marker: "kill-probe" }))
        .status,
    ).toBe(429);

    // The owning child fails without any protocol reply; its confirmed exit frees
    // exactly the work that child held.
    const [echoChild] = (await pids(echoPids)).filter(alive);
    process.kill(echoChild, "SIGKILL");
    await eventually(() => !alive(echoChild));
    await eventually(
      async () =>
        (
          await modern(address as string, "other", 901, "delay", {
            delay: 20,
            marker: "kill-after",
          })
        ).status === 200,
    );
    expect(
      context.controller.snapshot().servers.every((server) => server.status === "mounted"),
    ).toBe(true);
    const fresh = await connect(address as string, "echo");
    try {
      expect((await fresh.client.listTools()).tools[0].name).toBe("echo");
    } finally {
      await fresh.close();
    }
  } finally {
    for (const abort of aborts) abort.abort();
    await client?.client.close();
    const processes = [...(await pids(echoPids)), ...(await pids(otherPids))];
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);
