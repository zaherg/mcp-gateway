import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as adapter from "../../src/core/adapter";
import { open } from "../../src/core/controller";
import { GatewayIngress } from "../../src/core/ingress";
import type { ResourceLease } from "../../src/core/resource-admission";
import { QuitCoordinator } from "../../src/main/lifecycle";
import { alive, configFor, connect, eventually, failListener, pids, stdio } from "./helpers";

const base = resolve(".cache/linux-runtime/shutdown-fixes");

// Wrap the actual mount at its existing factory seam. The held lease represents
// an outstanding resource; real synthetic MCP child cleanup still runs normally.
function controlledMounts(terminal = false) {
  const create = adapter.createMount;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const actual: ReturnType<typeof create>[] = [];
  const leases = new Set<ResourceLease>();
  let calls = 0;
  let completed = 0;
  const spy = spyOn(adapter, "createMount").mockImplementation((...args) => {
    const mount = create(...args);
    actual.push(mount);
    const lease = args[3].acquire();
    if (!lease) throw new Error("Controlled cleanup resource was not reserved.");
    leases.add(lease);
    let cleanup: Promise<void> | undefined;
    return {
      ...mount,
      close: () => {
        calls++;
        cleanup ??= gate.then(async () => {
          if (terminal) throw new Error("synthetic-unconfirmed-cleanup");
          await mount.close();
          lease.release();
          leases.delete(lease);
          completed++;
        });
        return cleanup;
      },
    };
  });
  return {
    release,
    get calls() {
      return calls;
    },
    get completed() {
      return completed;
    },
    get outstanding() {
      return leases.size;
    },
    get created() {
      return actual.length;
    },
    async dispose() {
      release();
      try {
        await Promise.all(actual.map((mount) => mount.close()));
        for (const lease of leases) lease.release();
        leases.clear();
      } finally {
        spy.mockRestore();
      }
    },
  };
}

async function directory() {
  await mkdir(base, { recursive: true, mode: 0o700 });
  return mkdtemp(join(base, "boundary-"));
}

async function expectedFailureDuringTeardown(close: () => Promise<void>) {
  try {
    await close();
  } catch (error) {
    expect(error).toMatchObject({ code: "ShutdownFailure" });
  }
}

test("controller Quit retry retains outstanding ingress cleanup until raw completion", async () => {
  const path = await directory();
  const pidFile = join(path, "pids");
  const config = await configFor({ echo: stdio({ PID_FILE: pidFile }) });
  await writeFile(join(path, "mcp.json"), JSON.stringify(config), { mode: 0o600 });
  const mounts = controlledMounts();
  const controller = await open(join(path, "mcp.json"));
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let exits = 0;
  let vetoes = 0;
  const quit = new QuitCoordinator(
    () => controller.close(),
    () => {
      exits++;
    },
    () => {},
  );
  try {
    const started = await controller.start();
    client = await connect(started.address as string);
    // Retain a backend child so the live-process lifecycle assertion holds.
    await client.client.callTool({ name: "ask", arguments: {} });
    expect((await pids(pidFile)).some(alive)).toBe(true);
    quit.handle(() => {
      vetoes++;
    });
    await eventually(() => quit.status().phase === "failed", 12_000);
    const stopped = controller.snapshot();
    expect({
      running: stopped.running,
      address: stopped.address,
      error: stopped.operationalError?.code,
    }).toEqual({ running: false, address: null, error: "ShutdownFailure" });
    await expect(
      fetch(`${started.address}/mcp/echo`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
    expect(mounts.outstanding).toBe(1);
    expect(mounts.completed).toBe(0);
    await expect(controller.stop()).rejects.toMatchObject({ code: "Closed" });
    quit.handle(() => {
      vetoes++;
    });
    await Bun.sleep(100);
    expect(quit.status()).toMatchObject({ attempt: 2, phase: "pending" });
    expect(exits).toBe(0);
    expect(vetoes).toBe(2);
    await eventually(() => quit.status().phase === "failed", 12_000);
    expect(mounts.outstanding).toBe(1);
    expect(exits).toBe(0);
    quit.handle(() => {
      vetoes++;
    });
    await Bun.sleep(100);
    expect(quit.status()).toMatchObject({ attempt: 3, phase: "pending" });
    expect(exits).toBe(0);
    expect(mounts.outstanding).toBe(1);
    mounts.release();
    await eventually(() => exits === 1);
    expect(vetoes).toBe(3);
    expect(mounts.completed).toBe(1);
    expect(mounts.outstanding).toBe(0);
    expect(mounts.calls).toBe(1);
    expect(quit.status().phase).toBe("ready");
    expect(controller.snapshot().running).toBe(false);
    expect(controller.snapshot().operationalError).toBeNull();
    await expect(controller.start()).rejects.toMatchObject({ code: "Closed" });
    await eventually(async () => (await pids(pidFile)).every((pid) => !alive(pid)));
    await controller.close();
  } finally {
    mounts.release();
    await mounts.dispose();
    await client?.client.close();
    await expectedFailureDuringTeardown(() => controller.close());
    await eventually(async () => (await pids(pidFile)).every((pid) => !alive(pid)));
    await rm(path, { recursive: true, force: true });
  }
}, 30_000);

test.each(["stop", "listener error"])(
  "%s and stopped reconfiguration cannot replace ingress until outstanding cleanup finishes",
  async (cause) => {
    const path = await directory();
    const config = await configFor({ echo: stdio() });
    await writeFile(join(path, "mcp.json"), JSON.stringify(config), { mode: 0o600 });
    const mounts = controlledMounts();
    const controller = await open(join(path, "mcp.json"));
    try {
      const initial = await controller.start();
      if (cause === "stop") {
        await expect(controller.stop()).rejects.toMatchObject({ code: "ShutdownFailure" });
      } else {
        failListener(controller);
        await eventually(
          () => controller.snapshot().operationalError?.code === "ShutdownFailure",
          12_000,
        );
      }
      expect(controller.snapshot().running).toBe(false);
      expect(mounts.outstanding).toBe(1);
      const next = { ...config, mcpServers: { replacement: stdio() } };
      const saved = await controller.saveConfig(JSON.stringify(next), initial.revision);
      expect(saved.servers.map(({ name, status }) => ({ name, status }))).toEqual([
        { name: "replacement", status: "stopped" },
      ]);
      expect(mounts.created).toBe(1);
      let settled = false;
      const restart = controller.start().then((value) => {
        settled = true;
        return value;
      });
      await Bun.sleep(100);
      expect(settled).toBe(false);
      expect(mounts.created).toBe(1);
      mounts.release();
      const started = await restart;
      expect(started.running).toBe(true);
      expect(started.servers.map(({ name, status }) => ({ name, status }))).toEqual([
        { name: "replacement", status: "mounted" },
      ]);
      expect(mounts.completed).toBe(1);
      expect(mounts.created).toBe(2);
      await controller.close();
      expect(mounts.outstanding).toBe(0);
      expect(mounts.completed).toBe(2);
    } finally {
      await mounts.dispose();
      await expectedFailureDuringTeardown(() => controller.close());
      await rm(path, { recursive: true, force: true });
    }
  },
  20_000,
);

test("endpoint reconciliation re-awaits a removed mount instead of creating replacements after timeout", async () => {
  const mounts = controlledMounts();
  const config = await configFor({ echo: stdio() });
  const ingress = await GatewayIngress.open(config, () => {});
  try {
    await expect(ingress.reconcile({ ...config, mcpServers: {} })).rejects.toMatchObject({
      code: "ShutdownFailure",
    });
    expect(mounts.outstanding).toBe(1);
    let settled = false;
    const replacement = ingress.reconcile(config).then(() => {
      settled = true;
    });
    await Bun.sleep(100);
    expect(settled).toBe(false);
    expect(mounts.created).toBe(1);
    mounts.release();
    await replacement;
    expect(mounts.completed).toBe(1);
    expect(mounts.created).toBe(2);
    expect(mounts.calls).toBe(1);
    await ingress.close();
    expect(mounts.outstanding).toBe(0);
  } finally {
    await mounts.dispose();
    await expectedFailureDuringTeardown(() => ingress.close());
  }
}, 20_000);

test("terminal unconfirmed raw cleanup rejection remains refused on every Quit retry", async () => {
  const path = await directory();
  const pidFile = join(path, "pids");
  const config = await configFor({ echo: stdio({ PID_FILE: pidFile }) });
  await writeFile(join(path, "mcp.json"), JSON.stringify(config), { mode: 0o600 });
  const mounts = controlledMounts(true);
  const controller = await open(join(path, "mcp.json"));
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let exits = 0;
  let vetoes = 0;
  const quit = new QuitCoordinator(
    () => controller.close(),
    () => {
      exits++;
    },
    () => {},
  );
  try {
    const started = await controller.start();
    client = await connect(started.address as string);
    // Retain a backend child so the live-process lifecycle assertion holds.
    await client.client.callTool({ name: "ask", arguments: {} });
    expect((await pids(pidFile)).some(alive)).toBe(true);
    mounts.release();
    for (let attempt = 1; attempt <= 3; attempt++) {
      quit.handle(() => {
        vetoes++;
      });
      await eventually(() => quit.status().phase === "failed");
      expect(quit.status().attempt).toBe(attempt);
      expect(controller.snapshot().running).toBe(false);
      expect(mounts.outstanding).toBe(1);
      expect(mounts.completed).toBe(0);
      expect(mounts.calls).toBe(1);
      expect(exits).toBe(0);
    }
    expect(vetoes).toBe(3);
    await expect(
      fetch(`${started.address}/mcp/echo`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  } finally {
    await mounts.dispose();
    await client?.client.close();
    await expectedFailureDuringTeardown(() => controller.close());
    await eventually(async () => (await pids(pidFile)).every((pid) => !alive(pid)));
    await rm(path, { recursive: true, force: true });
  }
}, 10_000);
