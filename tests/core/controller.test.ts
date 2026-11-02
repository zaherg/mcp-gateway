import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { open } from "../../src/core/controller";
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

const call = (client: Awaited<ReturnType<typeof connect>>["client"], value: string) =>
  client.callTool({ name: "echo", arguments: { value } });

describe("McpGatewayController", () => {
  test("initializes stopped and exposes interfaces with explicit configuration bytes", async () => {
    const directory = await testDirectory();
    const controller = await open(join(directory, "mcp.json"));
    try {
      const snapshot = controller.snapshot();
      expect(snapshot.running).toBe(false);
      expect(snapshot.address).toBeNull();
      expect(snapshot.configPath).toBe(join(directory, "mcp.json"));
      expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(snapshot.interfaces.some((choice) => choice.address === "127.0.0.1")).toBe(true);
      expect(snapshot.servers).toEqual([]);
      expect(snapshot.configError).toBeNull();
      expect(JSON.parse(snapshot.configText).gateway.autoStart).toBe(false);
    } finally {
      await controller.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("login launch and exposure autoStart flags round-trip separately through CAS settings edits", async () => {
    const context = await setup();
    let reopened: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const next = structuredClone(context.config);
      next.gateway.launchAtLogin = true;
      next.gateway.autoStart = false;
      const saved = await context.controller.saveConfig(
        JSON.stringify(next),
        context.controller.snapshot().revision,
      );
      expect(JSON.parse(saved.configText).gateway).toMatchObject({
        launchAtLogin: true,
        autoStart: false,
      });
      await context.controller.close();
      reopened = await open(context.path);
      expect(reopened.snapshot().running).toBe(false);
      next.gateway.autoStart = true;
      const autoStart = await reopened.saveConfig(
        JSON.stringify(next),
        reopened.snapshot().revision,
      );
      expect(autoStart.running).toBe(false);
      await reopened.close();
      reopened = await open(context.path);
      expect(reopened.snapshot().running).toBe(true);
      await reopened.stop();
      expect(reopened.snapshot().running).toBe(false);
    } finally {
      await reopened?.close();
      await context.cleanup();
    }
  });

  test("distinct same-port sockets load and save while self-targets and unassigned listeners are refused", async () => {
    const config = await configFor();
    config.mcpServers = { separate: { url: `http://[::1]:${config.gateway.port}/mcp` } };
    const context = await setup(config);
    try {
      const before = context.controller.snapshot();
      expect(before.configError).toBeNull();
      expect(before.running).toBe(false);
      const saved = await context.controller.saveConfig(`${before.configText}\n`, before.revision);
      expect(saved.configError).toBeNull();
      const recursive = structuredClone(config);
      recursive.mcpServers.separate = {
        url: `http://127.0.0.1:${config.gateway.port}/mcp/separate`,
      };
      await expect(
        context.controller.saveConfig(JSON.stringify(recursive), saved.revision),
      ).rejects.toMatchObject({ code: "NetworkPolicy" });
      const unassigned = { ...config, gateway: { ...config.gateway, host: "192.0.2.5" } };
      await expect(
        context.controller.saveConfig(JSON.stringify(unassigned), saved.revision),
      ).rejects.toMatchObject({ code: "NetworkPolicy" });
      expect(await readFile(context.path, "utf8")).toBe(saved.configText);
      await context.controller.close();
      recursive.gateway.autoStart = true;
      await writeFile(context.path, JSON.stringify(recursive));
      const reopened = await open(context.path);
      try {
        expect(reopened.snapshot()).toMatchObject({
          running: false,
          configError: { code: "NetworkPolicy" },
        });
        await expect(reopened.start()).rejects.toMatchObject({ code: "InvalidConfig" });
      } finally {
        await reopened.close();
      }
    } finally {
      await context.cleanup();
    }
  });

  test("failed saves preserve live endpoints, no-op preserves bytes and stale revisions refuse overwrite", async () => {
    const context = await setup();
    try {
      const { address } = await context.controller.start();
      const client = await connect(address as string);
      try {
        const snapshot = context.controller.snapshot();
        await expect(
          context.controller.saveConfig('{"gateway":', snapshot.revision),
        ).rejects.toMatchObject({ code: "InvalidConfig" });
        expect(context.controller.snapshot().running).toBe(true);
        expect(await readFile(context.path, "utf8")).toBe(snapshot.configText);
        const noOp = await context.controller.saveConfig(snapshot.configText, snapshot.revision);
        expect(noOp.revision).toBe(snapshot.revision);
        expect(noOp.configText).toBe(snapshot.configText);
        const changed = await context.controller.saveConfig(
          `${snapshot.configText}\n`,
          snapshot.revision,
        );
        await expect(
          context.controller.saveConfig(snapshot.configText, snapshot.revision),
        ).rejects.toMatchObject({ code: "StaleRevision" });
        expect(changed.revision).not.toBe(snapshot.revision);
        const sessionId = client.transport.sessionId;
        const reordered = {
          ...context.config,
          mcpServers: {
            echo: { disabled: false, env: {}, args: stdio().args, command: process.execPath },
          },
        };
        await context.controller.saveConfig(JSON.stringify(reordered), changed.revision);
        expect((await call(client.client, "still-live")).isError).not.toBe(true);
        expect(client.transport.sessionId).toBe(sessionId);
      } finally {
        await client.close();
      }
    } finally {
      await context.cleanup();
    }
  });

  test("changed, disabled and removed endpoints reconcile independently without losing unchanged sessions", async () => {
    const context = await setup(await configFor({ alpha: stdio(), beta: stdio() }));
    const clients: Array<Awaited<ReturnType<typeof connect>>> = [];
    try {
      const { address } = await context.controller.start();
      clients.push(
        await connect(address as string, "alpha"),
        await connect(address as string, "beta"),
      );
      const betaId = clients[1].transport.sessionId;
      const snapshot = context.controller.snapshot();
      const next = structuredClone(context.config);
      next.mcpServers.alpha = stdio({ SYNTHETIC_ENV: "updated" });
      await context.controller.saveConfig(JSON.stringify(next), snapshot.revision);
      expect((await call(clients[1].client, "beta-still-live")).isError).not.toBe(true);
      expect(clients[1].transport.sessionId).toBe(betaId);
      const freshAlpha = await connect(address as string, "alpha");
      clients.push(freshAlpha);
      await context.controller.restartServer("alpha");
      expect((await call(clients[1].client, "beta-after-restart")).isError).not.toBe(true);
      next.mcpServers.alpha.disabled = true;
      const disabled = await context.controller.saveConfig(
        JSON.stringify(next),
        context.controller.snapshot().revision,
      );
      expect(disabled.servers.find((entry) => entry.name === "alpha")?.status).toBe("disabled");
      expect(
        (await fetch(`${address}/mcp/alpha`, { headers: { Authorization: `Bearer ${TOKEN}` } }))
          .status,
      ).toBe(404);
      delete next.mcpServers.alpha;
      const removed = await context.controller.saveConfig(JSON.stringify(next), disabled.revision);
      expect(removed.servers.map((entry) => entry.name)).toEqual(["beta"]);
      await expect(context.controller.restartServer("missing")).rejects.toMatchObject({
        code: "BackendFailure",
      });
      await clients[1].close();
      clients.splice(1, 1);
    } finally {
      for (const client of clients) await client.close().catch(() => {});
      await context.cleanup();
    }
  }, 15_000);

  test("external truncated config fails closed, valid correction stays stopped and never restores defaults", async () => {
    const context = await setup();
    try {
      await context.controller.start();
      const valid = context.controller.snapshot().configText;
      await writeFile(context.path, '{"gateway":{"token":"SECRET-fixture');
      await eventually(
        () =>
          !context.controller.snapshot().running &&
          context.controller.snapshot().configError !== null,
      );
      const invalid = context.controller.snapshot();
      expect(invalid.configText).toBe('{"gateway":{"token":"SECRET-fixture');
      expect(
        JSON.stringify({ events: invalid.events, configError: invalid.configError }),
      ).not.toContain("SECRET-fixture");
      await expect(context.controller.start()).rejects.toMatchObject({ code: "InvalidConfig" });
      expect(await readFile(context.path, "utf8")).toBe(invalid.configText);
      const temp = join(context.directory, "replacement.json");
      await writeFile(temp, valid, { mode: 0o600 });
      await rename(temp, context.path);
      await eventually(() => context.controller.snapshot().configError === null);
      expect(context.controller.snapshot().running).toBe(false);
      expect(context.controller.snapshot().configText).toBe(valid);
      await context.controller.start();
      expect(context.controller.snapshot().running).toBe(true);
    } finally {
      await context.cleanup();
    }
  });

  test("parent directory replacement fails closed until the controller is reopened", async () => {
    const context = await setup();
    const moved = `${context.directory}-moved`;
    let reopened: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const started = await context.controller.start();
      await rename(context.directory, moved);
      await mkdir(context.directory, { mode: 0o700 });
      await writeFile(context.path, started.configText, { mode: 0o600 });
      await eventually(
        () =>
          !context.controller.snapshot().running &&
          context.controller.snapshot().configError?.code === "ConfigIO",
      );
      await expect(context.controller.start()).rejects.toMatchObject({ code: "ConfigIO" });
      const saved = await context.controller.saveConfig(started.configText, started.revision);
      expect(saved.running).toBe(false);
      expect(saved.configError?.code).toBe("ConfigIO");
      await expect(context.controller.start()).rejects.toMatchObject({ code: "ConfigIO" });
      await context.controller.close();
      reopened = await open(context.path);
      expect(reopened.snapshot().configError).toBeNull();
      expect((await reopened.start()).running).toBe(true);
    } finally {
      await reopened?.close();
      await context.cleanup();
      await rm(moved, { recursive: true, force: true });
    }
  });

  test("external symlink replacement stops exposure and refuses saves", async () => {
    const context = await setup();
    try {
      await context.controller.start();
      const target = join(context.directory, "target.json");
      await writeFile(target, context.controller.snapshot().configText, { mode: 0o600 });
      await rm(context.path);
      await symlink(target, context.path);
      await eventually(
        () =>
          !context.controller.snapshot().running &&
          context.controller.snapshot().configError?.code === "UnsafeFile",
      );
      await expect(
        context.controller.saveConfig(
          context.controller.snapshot().configText,
          context.controller.snapshot().revision,
        ),
      ).rejects.toMatchObject({ code: "UnsafeFile" });
    } finally {
      await context.cleanup();
    }
  });

  test("external valid updates preserve unchanged sessions and do not enable autoStart on a stopped controller", async () => {
    const context = await setup();
    try {
      const { address } = await context.controller.start();
      const client = await connect(address as string);
      try {
        const next = structuredClone(context.config);
        next.mcpServers.second = stdio();
        await writeFile(context.path, JSON.stringify(next));
        await eventually(() => context.controller.snapshot().servers.length === 2);
        expect((await call(client.client, "unchanged")).isError).not.toBe(true);
      } finally {
        await client.close();
      }
      await context.controller.stop();
      const next = structuredClone(context.config);
      next.gateway.autoStart = true;
      await writeFile(context.path, JSON.stringify(next));
      await eventually(() => context.controller.snapshot().configText === JSON.stringify(next));
      expect(context.controller.snapshot().running).toBe(false);
    } finally {
      await context.cleanup();
    }
  });

  test("cancellation, restart, stop and idempotent Quit clean owned child process groups", async () => {
    const directory = await testDirectory();
    const pidFile = join(directory, "pids");
    const descendants = join(directory, "descendants");
    const context = await setup(
      await configFor({ echo: stdio({ PID_FILE: pidFile, DESCENDANT_PID_FILE: descendants }) }),
    );
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      const { address } = await context.controller.start();
      client = await connect(address as string);
      const abort = new AbortController();
      const pending = client.client.callTool(
        { name: "delay", arguments: { value: "cancel-me", delay: 10_000 } },
        undefined,
        { signal: abort.signal, timeout: 12_000 },
      );
      await Bun.sleep(100);
      abort.abort();
      await expect(pending).rejects.toThrow();
      expect((await call(client.client, "after-cancel")).isError).not.toBe(true);
      await context.controller.restartServer("echo");
      await client.client.close();
      await eventually(async () =>
        [...(await pids(pidFile)), ...(await pids(descendants))].every((pid) => !alive(pid)),
      );
      client = await connect(address as string);
      await context.controller.stop();
      await client.client.close();
      await eventually(async () =>
        [...(await pids(pidFile)), ...(await pids(descendants))].every((pid) => !alive(pid)),
      );
      const again = await context.controller.start();
      client = await connect(again.address as string);
      await Promise.all([context.controller.close(), context.controller.close()]);
      await client.client.close();
      await eventually(async () =>
        [...(await pids(pidFile)), ...(await pids(descendants))].every((pid) => !alive(pid)),
      );
      expect(context.controller.snapshot().running).toBe(false);
      await expect(context.controller.start()).rejects.toMatchObject({ code: "Closed" });
    } finally {
      await client?.client.close();
      await context.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);

  test("disconnect during initialization cleans only its child and preserves an established sibling session", async () => {
    const directory = await testDirectory();
    const pidFile = join(directory, "pids");
    const context = await setup(
      await configFor({ echo: stdio({ PID_FILE: pidFile, HANG_INITIALIZE_CLIENT: "disconnect" }) }),
    );
    let sibling: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      const { address } = await context.controller.start();
      sibling = await connect(address as string);
      const [siblingPid] = await pids(pidFile);
      const req = request(`${address}/mcp/echo`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      });
      req.on("error", () => {});
      req.on("response", (response) => response.resume());
      req.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "disconnect", version: "1" },
          },
        }),
      );
      await eventually(async () => (await pids(pidFile)).length === 2);
      req.destroy();
      await eventually(async () =>
        (await pids(pidFile)).filter((pid) => pid !== siblingPid).every((pid) => !alive(pid)),
      );
      expect(alive(siblingPid)).toBe(true);
      expect(context.controller.snapshot().servers[0].status).toBe("mounted");
      const result = await call(sibling.client, "sibling-survived");
      expect(result.isError).toBeUndefined();
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({ value: "sibling-survived", count: 1, pid: siblingPid, argv: [] }),
        },
      ]);
    } finally {
      await sibling?.close();
      const ownedPids = await pids(pidFile);
      await context.cleanup();
      await eventually(() => ownedPids.every((pid) => !alive(pid)));
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  test("listener bind failures stay stopped and produce a typed redacted operational error", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    const config = await configFor();
    config.gateway.port = address.port;
    const context = await setup(config);
    try {
      await expect(context.controller.start()).rejects.toMatchObject({ code: "ListenerFailure" });
      expect(context.controller.snapshot().running).toBe(false);
      expect(context.controller.snapshot().operationalError?.code).toBe("ListenerFailure");
    } finally {
      await context.cleanup();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  test("mount readiness does not imply handshake and backend failures expose no command or diagnostic secrets", async () => {
    const config = await configFor({
      echo: { command: "/nonexistent/SECRET-fixture-command", args: ["SECRET-fixture-argument"] },
    });
    const context = await setup(config);
    try {
      const started = await context.controller.start();
      expect(started.servers[0].status).toBe("mounted");
      expect(started.operationalError).toBeNull();
      await expect(connect(started.address as string)).rejects.toThrow();
      await eventually(() => context.controller.snapshot().operationalError !== null);
      const snapshot = context.controller.snapshot();
      expect(
        JSON.stringify({
          events: snapshot.events,
          operationalError: snapshot.operationalError,
          errors: snapshot.servers.map((server) => server.error),
        }),
      ).not.toContain("SECRET-fixture");
    } finally {
      await context.cleanup();
    }
  }, 15_000);

  test("serialized competing saves have one winner and listener address/token changes reconcile", async () => {
    const context = await setup();
    try {
      const first = await context.controller.start();
      const next = await configFor();
      const original = context.controller.snapshot();
      const results = await Promise.allSettled([
        context.controller.saveConfig(JSON.stringify(next), original.revision),
        context.controller.saveConfig(`${original.configText}\n`, original.revision),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(context.controller.snapshot().running).toBe(true);
      expect(context.controller.snapshot().address).not.toBe(first.address);
      const current = context.controller.snapshot();
      const client = await connect(current.address as string);
      const oldSessionId = client.transport.sessionId as string;
      next.gateway.token = "changed-synthetic-token-0123456789abcdef";
      await context.controller.saveConfig(JSON.stringify(next), current.revision);
      await client.client.close();
      expect(
        (
          await fetch(`${context.controller.snapshot().address}/mcp/echo`, {
            headers: {
              Authorization: `Bearer ${next.gateway.token}`,
              "Mcp-Session-Id": oldSessionId,
            },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(`${context.controller.snapshot().address}/mcp/echo`, {
            headers: { Authorization: `Bearer ${TOKEN}` },
          })
        ).status,
      ).toBe(401);
    } finally {
      await context.cleanup();
    }
  }, 15_000);
});

test("JSONC startup selection, external ambiguity and rename fail closed without switching", async () => {
  const config = await configFor({});
  config.gateway.autoStart = true;
  const text = `// JSONC retained\n${JSON.stringify(config)}`;
  const context = await setup(config, "jsonc", text);
  try {
    expect(context.controller.snapshot()).toMatchObject({
      configPath: context.path,
      configFormat: "jsonc",
      configText: text,
      configError: null,
      running: true,
    });
    await writeFile(context.path, '// truncated SECRET\n{"gateway":');
    await eventually(
      () =>
        !context.controller.snapshot().running &&
        context.controller.snapshot().configError?.code === "InvalidConfig",
    );
    expect(context.controller.snapshot().configText).toBe('// truncated SECRET\n{"gateway":');
    expect(JSON.stringify(context.controller.snapshot().configError)).not.toContain("SECRET");
    await writeFile(context.path, text);
    await eventually(() => context.controller.snapshot().configError === null);
    expect(context.controller.snapshot().running).toBe(false);
    await context.controller.start();
    const alternate = join(context.directory, "mcp.json");
    await writeFile(alternate, JSON.stringify(config), { mode: 0o600 });
    await eventually(
      () =>
        !context.controller.snapshot().running &&
        context.controller.snapshot().configError?.code === "AmbiguousConfig",
    );
    await expect(
      context.controller.saveConfig(text, context.controller.snapshot().revision),
    ).rejects.toMatchObject({ code: "AmbiguousConfig" });
    expect(context.controller.snapshot().configPath).toBe(context.path);
    await rm(alternate);
    await eventually(() => context.controller.snapshot().configError === null);
    expect(context.controller.snapshot().running).toBe(false);
    await context.controller.start();
    await rename(context.path, alternate);
    await eventually(
      () =>
        !context.controller.snapshot().running &&
        context.controller.snapshot().configError?.code === "ConfigIO",
    );
    expect(context.controller.snapshot().configPath).toBe(context.path);
    await expect(
      context.controller.saveConfig(text, context.controller.snapshot().revision),
    ).rejects.toMatchObject({ code: "ConfigIO" });
    await expect(readFile(context.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await context.cleanup();
  }
});

test("strict JSON comments and ambiguous autoStart both refuse exposure visibly", async () => {
  const config = await configFor({});
  config.gateway.autoStart = true;
  const text = `// SECRET fixture comment\n${JSON.stringify(config)}`;
  const context = await setup(config, "json", text);
  let reopened: Awaited<ReturnType<typeof open>> | undefined;
  try {
    expect(context.controller.snapshot()).toMatchObject({
      configError: { code: "InvalidConfig" },
      configText: text,
      running: false,
    });
    expect(JSON.stringify(context.controller.snapshot().configError)).not.toContain("SECRET");
    await context.controller.close();
    await writeFile(`${context.path}c`, JSON.stringify(config), { mode: 0o600 });
    reopened = await open(context.path);
    expect(reopened.snapshot()).toMatchObject({
      configError: { code: "AmbiguousConfig" },
      running: false,
      revision: "",
      configText: "",
    });
    await expect(reopened.saveConfig(JSON.stringify(config), "")).rejects.toMatchObject({
      code: "AmbiguousConfig",
    });
    expect(await readFile(context.path, "utf8")).toBe(text);
  } finally {
    await reopened?.close();
    await context.cleanup();
  }
});
