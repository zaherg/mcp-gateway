import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKEND_CAPACITY_ERROR, MAX_BACKEND_CALLS } from "../../src/core/backend-work";
import { MAX_CONCURRENT_REQUESTS } from "../../src/core/ingress";
import {
  alive,
  configFor,
  eventually,
  ingressCounts,
  pids,
  setup,
  stdio,
  TOKEN,
} from "../core/helpers";

// Ordinary regression tests: admission regressions must fail the unit command.
interface Dispatch {
  /** The id the gateway sent to the backend (the caller's own id for modern). */
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
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
      : ([JSON.parse(text)] as Record<string, unknown>[]),
  };
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

test("regression: disconnected modern requests are bounded by one shared backend-work cap across endpoints", async () => {
  const context = await setup(await configFor({}));
  const callLog = join(context.directory, "calls");
  const pidFile = join(context.directory, "pids");
  const aborts: AbortController[] = [];
  try {
    const config = await configFor({
      echo: stdio({ CALL_LOG: callLog, PID_FILE: pidFile }),
      other: stdio({ CALL_LOG: callLog, PID_FILE: pidFile }),
    });
    await context.controller.saveConfig(
      JSON.stringify(config),
      context.controller.snapshot().revision,
    );
    const { address } = await context.controller.start();
    // biome-ignore lint/complexity/useLiteralKeys: Observe the real listener's shared admission ledgers.
    const ingress = context.controller["ingress"];
    if (!ingress) throw new Error("Missing ingress");
    // The shared budget is held by in-flight requests on one endpoint.
    for (let index = 0; index < MAX_BACKEND_CALLS; index++) {
      const marker = `fill-${index}`;
      aborts.push(
        modernDisconnected(address as string, "echo", 100 + index, "delay", {
          delay: 20_000,
          marker,
        }),
      );
      await eventually(async () => dispatched(await started(callLog), marker));
    }
    expect((await pids(pidFile)).filter(alive)).toHaveLength(MAX_BACKEND_CALLS);
    expect(ingressCounts(ingress)).toMatchObject({
      resources: MAX_BACKEND_CALLS,
      calls: MAX_BACKEND_CALLS,
    });
    expect(ingressCounts(ingress).active).toBeLessThanOrEqual(MAX_CONCURRENT_REQUESTS);
    // A second endpoint shares the same budget and is refused at capacity.
    const refused = await modern(address as string, "other", 900, "delay", {
      delay: 20,
      marker: "cap-probe",
    });
    expect(refused.status).toBe(429);
    expect(refused.messages[0]).toMatchObject({ error: BACKEND_CAPACITY_ERROR });
    expect(dispatched(await started(callLog), "cap-probe")).toBe(false);
    expect((await pids(pidFile)).filter(alive).length).toBeLessThanOrEqual(MAX_BACKEND_CALLS);

    // Disconnecting every request lets each child's confirmed cleanup free its work.
    for (const abort of aborts.splice(0)) abort.abort();
    await eventually(async () => (await pids(pidFile)).every((pid) => !alive(pid)));
    await eventually(
      () => ingressCounts(ingress).resources === 0 && ingressCounts(ingress).calls === 0,
    );
    await eventually(
      async () =>
        (
          await modern(address as string, "other", 901, "delay", {
            delay: 20,
            marker: "after-release",
          })
        ).status === 200,
    );
    // Both endpoints stay usable after the disconnected fills are reaped.
    expect(
      context.controller.snapshot().servers.every((server) => server.status === "mounted"),
    ).toBe(true);
  } finally {
    for (const abort of aborts) abort.abort();
    const processes = await pids(pidFile);
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
    // Fill the shared budget so only the disconnected modern call is in doubt.
    for (let index = 0; index < MAX_BACKEND_CALLS - 1; index++) {
      const marker = `modern-fill-${index}`;
      aborts.push(
        modernDisconnected(address as string, "echo", 100 + index, "delay", {
          delay: 20_000,
          marker,
        }),
      );
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
    expect(wireOf(deliveries, "modern-fill-0")).toBe(100);
  } finally {
    await Bun.write(gate, "release");
    for (const abort of aborts) abort.abort();
    const processes = await pids(pidFile);
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);

test("regression: a failed backend child releases only its own work and leaves a sibling usable", async () => {
  const context = await setup(await configFor({}));
  const gate = join(context.directory, "cleanup-gate");
  const signals = join(context.directory, "cleanup-signals");
  const echoCalls = join(context.directory, "echo-calls");
  const echoPids = join(context.directory, "echo-pids");
  const otherCalls = join(context.directory, "other-calls");
  const otherPids = join(context.directory, "other-pids");
  const aborts: AbortController[] = [];
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
    // Every slot is held by a gate-held child whose cleanup is unconfirmed.
    for (let index = 0; index < MAX_BACKEND_CALLS; index++) {
      const marker = `kill-${index}`;
      aborts.push(
        modernDisconnected(address as string, "echo", 100 + index, "delay", {
          delay: 20_000,
          marker,
        }),
      );
      await eventually(async () => dispatched(await started(echoCalls), marker));
    }
    for (const abort of aborts.splice(0)) abort.abort();
    // All children are held by the cleanup gate, so none has released its work.
    await eventually(async () => (await pids(signals)).length === MAX_BACKEND_CALLS);
    expect(
      (
        await modern(address as string, "other", 900, "delay", {
          delay: 20,
          marker: "kill-probe",
        })
      ).messages[0],
    ).toMatchObject({ error: BACKEND_CAPACITY_ERROR });

    // A confirmed child exit frees exactly the work that child held; the gate
    // still holds every other child's work.
    const [echoChild] = (await pids(echoPids)).filter(alive);
    expect(echoChild).toBeDefined();
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
  } finally {
    await Bun.write(gate, "release");
    for (const abort of aborts) abort.abort();
    const processes = [...(await pids(echoPids)), ...(await pids(otherPids))];
    await context.cleanup();
    await eventually(() => processes.every((pid) => !alive(pid)));
  }
}, 25_000);
