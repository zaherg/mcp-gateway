import { expect, spyOn, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect as connectSocket, type Socket } from "node:net";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MAX_BACKEND_CALLS } from "../../src/core/backend-work";
import {
  GatewayIngress,
  MAX_BODY_BYTES,
  MAX_CONCURRENT_REQUESTS,
  MAX_CONTROL_REQUESTS,
  MAX_CONTROL_REQUESTS_PER_MINUTE,
  MAX_ORDINARY_REQUESTS,
  MAX_ORDINARY_REQUESTS_PER_MINUTE,
  MAX_SESSIONS,
  REQUEST_DEADLINE_MS,
} from "../../src/core/ingress";
import {
  alive,
  configFor,
  eventually,
  ingressCounts,
  initializeSession,
  pids,
  stdio,
  TOKEN,
  testDirectory,
} from "./helpers";

function openPost(address: string, body: string | Uint8Array, session?: string, complete = true) {
  let status: number | undefined;
  const errors: Error[] = [];
  const req = request(
    `${address}/mcp/echo`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
    },
    (res) => {
      status = res.statusCode;
      res.on("error", (error) => errors.push(error));
      res.resume();
    },
  );
  // Deliberately disconnected streams can report ECONNRESET; retain errors so
  // complete-response assertions can distinguish them from HTTP refusals.
  req.on("error", (error) => errors.push(error));
  const closed = new Promise<void>((resolve) => req.once("close", resolve));
  req.write(body);
  if (complete) req.end();
  return { req, closed, errors, status: () => status };
}
const partial = (address: string) => openPost(address, '{"jsonrpc":"2.0",', undefined, false);
type Pending = ReturnType<typeof partial>;

async function closePending(pending: readonly Pending[]) {
  for (const { req } of pending) req.destroy();
  await Promise.all(pending.map(({ closed }) => closed));
}
async function exchange(address: string, init: RequestInit = {}, path = "/mcp/echo") {
  const response = await fetch(`${address}${path}`, {
    ...init,
    signal: AbortSignal.timeout(5_000),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...init.headers,
    },
  });
  await response.text();
  return response.status;
}
const post = (address: string, session: string, body: unknown) =>
  exchange(address, {
    method: "POST",
    headers: { "Mcp-Session-Id": session },
    body: JSON.stringify(body),
  });
const removeSession = (address: string, session: string) =>
  exchange(address, { method: "DELETE", headers: { "Mcp-Session-Id": session } });
const cancellation = (id: string | number) => ({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: id },
});
const delayed = (id: string | number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "delay", arguments: { delay: 20_000 } },
});

function rollWindow(ingress: GatewayIngress) {
  // biome-ignore lint/complexity/useLiteralKeys: Advance admission only, without altering SDK/process timers.
  ingress["rateStart"] = Date.now() - 60_001;
}

async function saturate(ingress: GatewayIngress, pending: Pending[]) {
  const remaining = MAX_ORDINARY_REQUESTS - ingressCounts(ingress).ordinary;
  for (let i = 0; i < remaining; i++) pending.push(partial(ingress.address));
  await eventually(() => ingressCounts(ingress).ordinary === MAX_ORDINARY_REQUESTS);
}

test("all 32 HTTP slots include incomplete bodies; reserved disconnect and endpoint stop release ownership", async () => {
  const ingress = await GatewayIngress.open(await configFor(), () => {});
  const pending: Pending[] = [];
  try {
    const session = await initializeSession(ingress.address);
    await saturate(ingress, pending);
    for (let i = 0; i < MAX_CONTROL_REQUESTS; i++) pending.push(partial(ingress.address));
    await eventually(() => ingressCounts(ingress).reserved === MAX_CONTROL_REQUESTS);
    const counts = ingressCounts(ingress);
    expect(counts.ordinary + counts.reserved).toBe(MAX_CONCURRENT_REQUESTS);
    expect(counts.resources).toBe(1);
    expect(counts.calls).toBe(0);
    expect(await removeSession(ingress.address, session)).toBe(429);
    expect(ingressCounts(ingress).rate).toBe(counts.rate);
    const disconnected = pending.pop();
    if (!disconnected) throw new Error("Missing owned parser");
    await closePending([disconnected]);
    await eventually(() => ingressCounts(ingress).reserved === MAX_CONTROL_REQUESTS - 1);
    expect(await removeSession(ingress.address, session)).toBe(200);
    await ingress.restart("echo");
    await eventually(() => {
      const counts = ingressCounts(ingress);
      return counts.ordinary === 0 && counts.reserved === 0;
    });
    expect(ingressCounts(ingress).resources).toBe(0);
    expect(ingress.running).toBe(true);
  } finally {
    await closePending(pending);
    await ingress.close();
  }
}, 15_000);

test("a parser deadline ends the same admission lease and never dispatches a backend", async () => {
  const ingress = await GatewayIngress.open(await configFor(), () => {});
  const expire: Array<() => void> = [];
  const original = setTimeout;
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args) {
        if (args[1] === REQUEST_DEADLINE_MS && typeof args[0] === "function") expire.push(args[0]);
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
  const pending = partial(ingress.address);
  try {
    await eventually(() => expire.length === 1);
    expect(ingressCounts(ingress).ordinary).toBe(1);
    expire[0]();
    await eventually(() => ingressCounts(ingress).ordinary === 0);
    expect(ingressCounts(ingress)).toEqual({
      ordinary: 0,
      reserved: 0,
      rate: 1,
      ordinaryRate: 1,
      resources: 0,
      calls: 0,
    });
  } finally {
    clock.mockRestore();
    await closePending([pending]);
    await ingress.close();
  }
});

test("pending parsers charge rate on entry and cannot alter a rolled-over window", async () => {
  const ingress = await GatewayIngress.open(await configFor(), () => {});
  const pending: Pending[] = [];
  try {
    await saturate(ingress, pending);
    pending.push(partial(ingress.address));
    await eventually(() => ingressCounts(ingress).reserved === 1);
    expect(ingressCounts(ingress).rate).toBe(MAX_ORDINARY_REQUESTS + 1);
    expect(ingressCounts(ingress).ordinaryRate).toBe(MAX_ORDINARY_REQUESTS);
    rollWindow(ingress);
    // Still saturated by the previous window's actual requests; no refunded tokens.
    expect(await removeSession(ingress.address, "unknown")).toBe(429);
    expect(ingressCounts(ingress).rate).toBe(1);
    expect(ingressCounts(ingress).ordinaryRate).toBe(0);
    await closePending(pending);
    await eventually(
      () => ingressCounts(ingress).ordinary === 0 && ingressCounts(ingress).reserved === 0,
    );
    expect(ingressCounts(ingress).rate).toBe(1);
    expect(ingressCounts(ingress).ordinaryRate).toBe(0);
    expect(await exchange(ingress.address, { headers: { "Mcp-Session-Id": "unknown" } })).toBe(404);
    expect(ingressCounts(ingress).rate).toBe(2);
    expect(ingressCounts(ingress).ordinaryRate).toBe(1);
  } finally {
    await closePending(pending);
    await ingress.close();
  }
});

test("reserved parsing preserves authentication, route, media, byte and session checks", async () => {
  const ingress = await GatewayIngress.open(
    await configFor({ echo: stdio(), other: stdio() }),
    () => {},
  );
  const pending: Pending[] = [];
  try {
    const session = await initializeSession(ingress.address);
    await saturate(ingress, pending);
    for (const [headers, status] of [
      [{ Authorization: "Bearer invalid" }, 401],
      [{ Host: "untrusted.invalid" }, 403],
      [{ Origin: "https://untrusted.invalid" }, 403],
    ] as const) {
      const before = ingressCounts(ingress).rate;
      expect(
        await exchange(ingress.address, {
          method: "DELETE",
          headers: { "Mcp-Session-Id": session, ...headers },
        }),
      ).toBe(status);
      expect(ingressCounts(ingress).rate).toBe(before);
    }
    expect(await exchange(ingress.address, { method: "DELETE" }, "/mcp/missing")).toBe(404);
    expect(
      await exchange(
        ingress.address,
        { method: "DELETE", headers: { "Mcp-Session-Id": session } },
        "/mcp/other",
      ),
    ).toBe(429);
    expect(await removeSession(ingress.address, "unknown")).toBe(429);
    expect(
      await exchange(ingress.address, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": session, "Mcp-Protocol-Version": "unsupported" },
      }),
    ).toBe(400);
    expect(
      await exchange(ingress.address, {
        method: "DELETE",
        headers: { "Mcp-Session-Id": session, "Mcp-Protocol-Version": "2026-07-28" },
      }),
    ).toBe(429);
    expect(
      await exchange(ingress.address, {
        method: "POST",
        headers: { "Mcp-Session-Id": session, "Mcp-Method": "notifications/cancelled" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 30, method: "tools/list" }),
      }),
    ).toBe(429);
    for (const contentType of ["text/plain", "application/json; charset=utf-16"]) {
      expect(
        await exchange(ingress.address, {
          method: "POST",
          headers: { "Content-Type": contentType, "Mcp-Session-Id": session },
          body: JSON.stringify(cancellation(1)),
        }),
      ).toBe(415);
    }
    for (const body of ["[]", '{"jsonrpc":', JSON.stringify([cancellation(1), null])]) {
      expect(
        await exchange(ingress.address, {
          method: "POST",
          headers: { "Mcp-Session-Id": session },
          body,
        }),
      ).toBe(400);
    }
    for (const [body, status] of [
      [Buffer.from([0xff]), 400],
      [`{"padding":"${"x".repeat(MAX_BODY_BYTES)}"}`, 413],
    ] as const) {
      const invalid = openPost(ingress.address, body, session);
      pending.push(invalid);
      await invalid.closed;
      expect(invalid.status()).toBe(status);
      expect(invalid.errors).toEqual([]);
    }
    await eventually(() => ingressCounts(ingress).reserved === 0);
    expect(ingressCounts(ingress).ordinary).toBe(MAX_ORDINARY_REQUESTS);
    expect(ingressCounts(ingress).resources).toBe(1);
    expect(ingressCounts(ingress).calls).toBe(0);
    expect(await removeSession(ingress.address, session)).toBe(200);
  } finally {
    await closePending(pending);
    await ingress.close();
  }
}, 15_000);

for (const batch of [false, true]) {
  test(`same-write pipelined ${batch ? "batch" : "single call"} cancellation uses reserved admission`, async () => {
    const directory = await testDirectory();
    const notificationLog = join(directory, "notifications");
    const ingress = await GatewayIngress.open(
      await configFor({ echo: stdio({ NOTIFICATION_LOG: notificationLog }) }),
      () => {},
    );
    const pending: Pending[] = [];
    let socket: Socket | undefined;
    let closed: Promise<void> | undefined;
    try {
      const session = await initializeSession(ingress.address);
      for (let index = 0; index < MAX_ORDINARY_REQUESTS - 1; index++)
        pending.push(partial(ingress.address));
      await eventually(() => ingressCounts(ingress).ordinary === MAX_ORDINARY_REQUESTS - 1);
      const before = ingressCounts(ingress);
      const address = new URL(ingress.address);
      const encode = (body: unknown, last: boolean) => {
        const text = JSON.stringify(body);
        return [
          "POST /mcp/echo HTTP/1.1",
          `Host: ${address.host}`,
          `Authorization: Bearer ${TOKEN}`,
          "Content-Type: application/json",
          "Accept: application/json, text/event-stream",
          `Mcp-Session-Id: ${session}`,
          `Content-Length: ${Buffer.byteLength(text)}`,
          ...(last ? ["Connection: close"] : []),
          "",
          text,
        ].join("\r\n");
      };
      const original = delayed(2_001);
      const sibling = {
        ...delayed(2_002),
        params: { name: "delay", arguments: { delay: 100, value: "surviving-sibling" } },
      };
      const connection = connectSocket(Number(address.port), address.hostname);
      socket = connection;
      closed = new Promise((resolve) => connection.once("close", resolve));
      const response = new Promise<string>((resolve, reject) => {
        let text = "";
        connection.on("data", (chunk) => {
          text += chunk.toString("utf8");
          if (Buffer.byteLength(text) > 64 * 1024)
            connection.destroy(new Error("Pipelined fixture response exceeded its bound"));
        });
        connection.once("error", reject);
        connection.once("end", () => resolve(text));
        connection.setTimeout(5_000, () =>
          connection.destroy(new Error("Pipelined fixture response timed out")),
        );
        connection.once("connect", () => {
          // No SDK spies or dispatch pauses: both HTTP requests share one socket write.
          connection.write(
            encode(batch ? [original, sibling] : original, false) +
              encode(cancellation(2_001), true),
          );
        });
      });
      const text = await response;
      expect([...text.matchAll(/^HTTP\/1\.1 (\d{3})/gm)].map((match) => Number(match[1]))).toEqual([
        200, 202,
      ]);
      const messages = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)));
      if (batch) {
        expect(messages).toEqual([
          {
            jsonrpc: "2.0",
            id: 2_002,
            result: { content: [{ type: "text", text: expect.any(String) }] },
          },
        ]);
        expect(JSON.parse(messages[0].result.content[0].text)).toMatchObject({
          value: "surviving-sibling",
          count: 2,
        });
      } else expect(messages).toEqual([]);
      await eventually(async () => {
        try {
          return (await readFile(notificationLog, "utf8")) === "notifications/cancelled\n";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      });
      await eventually(() => ingressCounts(ingress).reserved === 0);
      expect(ingressCounts(ingress)).toEqual({
        ...before,
        rate: before.rate + 2,
        ordinaryRate: before.ordinaryRate + 1,
      });
      expect(await removeSession(ingress.address, session)).toBe(200);
      await eventually(() => ingressCounts(ingress).resources === 0);
    } finally {
      socket?.destroy();
      await closed;
      await closePending(pending);
      await ingress.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}

test("concurrent reserved controls cannot claim the same operation or race DELETE", async () => {
  const ingress = await GatewayIngress.open(await configFor(), () => {});
  const pending: Pending[] = [];
  const gate = Promise.withResolvers<void>();
  let entered = false;
  let first: Promise<{ status: number } | { error: unknown }> | undefined;
  let restore: (() => void) | undefined;
  try {
    const session = await initializeSession(ingress.address);
    pending.push(openPost(ingress.address, JSON.stringify(delayed(100)), session));
    await eventually(() => ingressCounts(ingress).calls === 1);
    await saturate(ingress, pending);
    const original = StreamableHTTPServerTransport.prototype.handleRequest;
    const paused = spyOn(
      StreamableHTTPServerTransport.prototype,
      "handleRequest",
    ).mockImplementation(
      new Proxy(original, {
        async apply(target, receiver, args) {
          if (
            args[0].method === "POST" &&
            args[2]?.method === "notifications/cancelled" &&
            !entered
          ) {
            entered = true;
            await gate.promise;
          }
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    restore = () => paused.mockRestore();
    first = post(ingress.address, session, cancellation(100)).then(
      (status) => ({ status }),
      (error: unknown) => ({ error }),
    );
    await eventually(() => entered);
    expect(ingressCounts(ingress).reserved).toBe(1);
    expect(await post(ingress.address, session, cancellation(100))).toBe(429);
    expect(await post(ingress.address, session, [cancellation(100), cancellation(100)])).toBe(429);
    expect(await removeSession(ingress.address, session)).toBe(429);
    expect(ingressCounts(ingress).calls).toBe(1);
    gate.resolve();
    expect(await first).toEqual({ status: 202 });
    await eventually(
      () =>
        ingressCounts(ingress).calls === 0 &&
        ingressCounts(ingress).ordinary === MAX_ORDINARY_REQUESTS - 1,
    );
    await saturate(ingress, pending);
    expect(await post(ingress.address, session, cancellation(100))).toBe(429);
    expect(await removeSession(ingress.address, session)).toBe(200);
    await eventually(() => ingressCounts(ingress).resources === 0);
    expect(ingressCounts(ingress).reserved).toBe(0);
  } finally {
    gate.resolve();
    if (first) await first;
    restore?.();
    await closePending(pending);
    await ingress.close();
  }
}, 15_000);

test("reserved cancellation preserves batch siblings and DELETE retains leases through delayed cleanup", async () => {
  const directory = await testDirectory();
  const gate = join(directory, "cleanup-gate");
  const signals = join(directory, "cleanup-signals");
  const pidFile = join(directory, "pids");
  const ingress = await GatewayIngress.open(
    await configFor({
      echo: stdio({ PID_FILE: pidFile, CLEANUP_GATE_FILE: gate, CLEANUP_SIGNAL_FILE: signals }),
    }),
    () => {},
  );
  const pending: Pending[] = [];
  try {
    const sessions: string[] = [];
    for (let index = 0; index < MAX_SESSIONS; index++)
      sessions.push(await initializeSession(ingress.address));
    const batch = openPost(
      ingress.address,
      JSON.stringify([delayed(100), delayed(101)]),
      sessions[0],
    );
    pending.push(batch);
    for (let index = 1; index < MAX_BACKEND_CALLS - 1; index++) {
      pending.push(
        openPost(ingress.address, JSON.stringify(delayed(index + 200)), sessions[index]),
      );
    }
    await eventually(() => ingressCounts(ingress).calls === MAX_BACKEND_CALLS);
    await saturate(ingress, pending);
    expect(ingressCounts(ingress).resources).toBe(MAX_SESSIONS);
    expect(await post(ingress.address, sessions[0], cancellation(100))).toBe(202);
    expect(ingressCounts(ingress).calls).toBe(MAX_BACKEND_CALLS - 1);
    expect(ingressCounts(ingress).ordinary).toBe(MAX_ORDINARY_REQUESTS);
    expect(batch.req.closed).toBe(false);
    expect(await removeSession(ingress.address, sessions[1])).toBe(200);
    await eventually(async () => (await pids(signals)).length === 1);
    const [stopping] = await pids(signals);
    expect(alive(stopping)).toBe(true);
    expect(ingressCounts(ingress).resources).toBe(MAX_SESSIONS);
    expect(ingressCounts(ingress).calls).toBe(MAX_BACKEND_CALLS - 1);
    await eventually(() => ingressCounts(ingress).ordinary === MAX_ORDINARY_REQUESTS - 1);
    expect(await exchange(ingress.address, { headers: { "Mcp-Session-Id": "unknown" } })).toBe(404);
    await expect(initializeSession(ingress.address)).rejects.toThrow("Initialize failed: 429");
    expect((await pids(pidFile)).filter(alive)).toHaveLength(MAX_SESSIONS);
    await writeFile(gate, "release");
    await eventually(
      () => !alive(stopping) && ingressCounts(ingress).resources === MAX_SESSIONS - 1,
    );
    expect(ingressCounts(ingress).calls).toBe(MAX_BACKEND_CALLS - 2);
    expect(await initializeSession(ingress.address)).toBeString();
    expect(ingressCounts(ingress).resources).toBe(MAX_SESSIONS);
    expect((await pids(pidFile)).filter(alive)).toHaveLength(MAX_SESSIONS);
  } finally {
    await writeFile(gate, "release");
    await closePending(pending);
    await ingress.close();
    expect((await pids(pidFile)).some(alive)).toBe(false);
    await rm(directory, { recursive: true });
  }
}, 15_000);

test("224 ordinary admissions retain exactly 16 controls, with renewal only in the next window", async () => {
  const ingress = await GatewayIngress.open(await configFor(), () => {});
  const pending: Pending[] = [];
  try {
    const session = await initializeSession(ingress.address);
    const ids = Array.from({ length: MAX_BACKEND_CALLS }, (_, index) =>
      index % 2 === 0 ? index / 2 : String(Math.floor(index / 2)),
    );
    pending.push(openPost(ingress.address, JSON.stringify(ids.map(delayed)), session));
    await eventually(() => ingressCounts(ingress).calls === MAX_BACKEND_CALLS);
    const used = ingressCounts(ingress).ordinaryRate;
    for (let i = used; i < MAX_ORDINARY_REQUESTS_PER_MINUTE; i++) {
      expect(await exchange(ingress.address, { headers: { "Mcp-Session-Id": "unknown" } })).toBe(
        404,
      );
    }
    expect(ingressCounts(ingress).rate).toBe(MAX_ORDINARY_REQUESTS_PER_MINUTE);
    expect(ingressCounts(ingress).ordinaryRate).toBe(MAX_ORDINARY_REQUESTS_PER_MINUTE);
    for (const [index, id] of ids.entries()) {
      expect(await post(ingress.address, session, cancellation(id))).toBe(202);
      expect(ingressCounts(ingress).calls).toBe(MAX_BACKEND_CALLS - index - 1);
      expect(ingressCounts(ingress).rate).toBe(MAX_ORDINARY_REQUESTS_PER_MINUTE + index + 1);
    }
    expect(ids).toHaveLength(MAX_CONTROL_REQUESTS_PER_MINUTE);
    expect(ingressCounts(ingress).rate).toBe(240);
    expect(await removeSession(ingress.address, session)).toBe(429);
    expect(ingressCounts(ingress).rate).toBe(240);
    expect(ingressCounts(ingress).resources).toBe(1);
    rollWindow(ingress);
    expect(await removeSession(ingress.address, session)).toBe(200);
    await eventually(() => ingressCounts(ingress).resources === 0);
    expect(ingressCounts(ingress)).toEqual({
      ordinary: 0,
      reserved: 0,
      rate: 1,
      ordinaryRate: 1,
      resources: 0,
      calls: 0,
    });
  } finally {
    await closePending(pending);
    await ingress.close();
  }
}, 15_000);
