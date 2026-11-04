import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type ClientRequest, request } from "node:http";
import { join } from "node:path";
import { createParser } from "eventsource-parser";
import {
  captureRegisteredGroup,
  inspectRegisteredGroup,
} from "../../../src/main/updater/registered-group";
import { configFor, eventually, pids, setup, stdio, TOKEN } from "../../core/helpers";

function headers(session?: string) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(session ? { "Mcp-Session-Id": session } : {}),
  };
}
async function post(address: string, session: string | undefined, payload: unknown) {
  return fetch(`${address}/mcp/echo`, {
    method: "POST",
    headers: headers(session),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(6_000),
  });
}
async function initialize(address: string): Promise<string> {
  const response = await post(address, undefined, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "audit", version: "1" },
    },
  });
  const session = response.headers.get("mcp-session-id");
  await response.text();
  if (response.status !== 200 || !session) throw new Error("Synthetic initialize failed");
  return session;
}
function delayed(id: number, marker: string, milliseconds = 20_000) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "delay",
      arguments: { delay: milliseconds, marker, value: marker },
    },
  };
}
async function calls(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

for (const cancel of [false, true]) {
  test(`A3: batch sibling survives cancellation=${cancel}`, async () => {
    const context = await setup(await configFor({}));
    const log = join(context.directory, "calls");
    let pending: Promise<string> | undefined;
    try {
      await context.controller.saveConfig(
        JSON.stringify(await configFor({ echo: stdio({ CALL_LOG: log }) })),
        context.controller.snapshot().revision,
      );
      const { address } = await context.controller.start();
      if (!address) throw new Error("Missing synthetic address");
      const session = await initialize(address);
      pending = post(address, session, [
        delayed(20, "cancelled", 250),
        delayed(21, "sibling", 500),
      ]).then(async (response) => {
        expect(response.status).toBe(200);
        return response.text();
      });
      // Observe any rejection immediately while waiting for both backend dispatches.
      const outcome = pending.then(
        (text) => ({ text }),
        (error: unknown) => ({ error }),
      );
      await eventually(async () => (await calls(log)).length === 2);
      if (cancel) {
        const cancelled = await post(address, session, {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 20 },
        });
        await cancelled.text();
        expect(cancelled.status).toBe(202);
      }
      const settled = await outcome;
      if ("error" in settled) throw settled.error;
      const messages: unknown[] = [];
      createParser({
        onEvent(event) {
          messages.push(JSON.parse(event.data));
        },
      }).feed(settled.text);
      expect(messages).toContainEqual(
        expect.objectContaining({
          id: 21,
          result: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining('"value":"sibling"'),
              }),
            ]),
          }),
        }),
      );
    } finally {
      await context.cleanup();
      if (pending) await Promise.allSettled([pending]);
    }
  }, 15_000);
}

test.skipIf(process.platform === "win32")(
  "A2: permission-refused backend stop cannot report completed cleanup",
  async () => {
    const context = await setup(await configFor({}));
    const pidFile = join(context.directory, "backend-pid");
    let group: Awaited<ReturnType<typeof captureRegisteredGroup>> | undefined;
    let stop: Promise<unknown> | undefined;
    let restore: (() => void) | undefined;
    let completed = false;
    let testError: Error | undefined;
    try {
      await context.controller.saveConfig(
        JSON.stringify(await configFor({ echo: stdio({ PID_FILE: pidFile }) })),
        context.controller.snapshot().revision,
      );
      const { address } = await context.controller.start();
      if (!address) throw new Error("Missing synthetic address");
      await initialize(address);
      const [pid] = await pids(pidFile);
      if (!pid) throw new Error("Missing owned backend PID");
      group = await captureRegisteredGroup({
        leaderPid: pid,
        helperPath: process.execPath,
        planPath: pidFile,
      });
      const originalKill = process.kill;
      const denied = spyOn(process, "kill").mockImplementation(
        new Proxy(originalKill, {
          apply(target, receiver, args: unknown[]) {
            if (args[0] === -pid)
              throw Object.assign(new Error("synthetic permission refusal"), { code: "EPERM" });
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
      restore = () => denied.mockRestore();
      stop = context.controller.stop().then(() => {
        completed = true;
      });
      const settled = stop.then(
        () => null,
        (error: unknown) => error,
      );
      await Bun.sleep(1_500);
      expect((await inspectRegisteredGroup(group)).status).toBe("alive");
      expect(completed).toBe(false);
      await settled;
    } catch (error) {
      testError = error instanceof Error ? error : new Error(String(error));
    } finally {
      restore?.();
      if (group) {
        const captured = group;
        const current = await inspectRegisteredGroup(captured);
        if (current.status === "unknown")
          testError ??= new Error("Owned fixture group identity is uncertain");
        if (current.status === "alive") process.kill(-captured.pgid, "SIGKILL");
        await eventually(async () => (await inspectRegisteredGroup(captured)).status === "absent");
      }
      if (stop) await Promise.allSettled([stop]);
      await context.cleanup();
    }
    if (testError) throw testError;
  },
  15_000,
);

test("A13: ordinary HTTP saturation leaves cancellation and DELETE headroom", async () => {
  const context = await setup(await configFor({}));
  const log = join(context.directory, "calls");
  const sockets: ClientRequest[] = [];
  const errors: Error[] = [];
  let closing = false;
  try {
    await context.controller.saveConfig(
      JSON.stringify(await configFor({ echo: stdio({ CALL_LOG: log }) })),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    if (!address) throw new Error("Missing synthetic address");
    const sessions: string[] = [];
    for (let i = 0; i < 16; i++) sessions.push(await initialize(address));
    const listening: number[] = [];
    for (const [i, session] of sessions.entries()) {
      const call = request(
        `${address}/mcp/echo`,
        { method: "POST", headers: headers(session) },
        (response) => response.resume(),
      );
      call.on("error", (error) => {
        if (!closing) errors.push(error);
      });
      sockets.push(call);
      call.end(JSON.stringify(delayed(100 + i, `held-${i}`)));
    }
    await eventually(async () => (await calls(log)).length === 16);
    for (const session of sessions) {
      const stream = request(
        `${address}/mcp/echo`,
        { method: "GET", headers: headers(session) },
        (response) => {
          listening.push(response.statusCode ?? 0);
          response.resume();
        },
      );
      stream.on("error", (error) => {
        if (!closing) errors.push(error);
      });
      sockets.push(stream);
      stream.end();
    }
    await eventually(() => listening.length === 16);
    expect(listening.every((status) => status === 200 || status === 429)).toBe(true);
    const cancellation = await post(address, sessions[0], {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 100 },
    });
    await cancellation.text();
    const deletion = await fetch(`${address}/mcp/echo`, {
      method: "DELETE",
      headers: headers(sessions[0]),
      signal: AbortSignal.timeout(5_000),
    });
    await deletion.text();
    expect(errors).toEqual([]);
    expect({ cancellation: cancellation.status, deletion: deletion.status }).toEqual({
      cancellation: 202,
      deletion: 200,
    });
  } finally {
    closing = true;
    const closed = sockets.map((socket) =>
      socket.closed ? Promise.resolve() : new Promise<void>((done) => socket.once("close", done)),
    );
    for (const socket of sockets) socket.destroy();
    await Promise.all(closed);
    await context.cleanup();
  }
}, 20_000);
