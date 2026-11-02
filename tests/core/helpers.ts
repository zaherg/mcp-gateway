import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ControllerOptions, type McpGatewayController, open } from "../../src/core/controller";
import type { SelfProxyResolver } from "../../src/core/network";
import type { ConfigFormat } from "../../src/shared/config-document";
import type { GatewayConfig, StdioServerConfig } from "../../src/shared/types";

export const TOKEN = "synthetic-gateway-token-0123456789abcdef";
export const fixture = resolve("tests/fixtures/stdio-mcp.ts");
export async function testDirectory(): Promise<string> {
  await mkdir(resolve(".cache"), { recursive: true });
  return mkdtemp(resolve(".cache/core-test-"));
}
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
export const stdio = (env: Record<string, string> = {}): StdioServerConfig => ({
  command: process.execPath,
  args: [fixture],
  env,
});
export async function configFor(
  mcpServers: GatewayConfig["mcpServers"] = { echo: stdio() },
): Promise<GatewayConfig> {
  return { gateway: { host: "127.0.0.1", port: await freePort(), token: TOKEN }, mcpServers };
}
export async function setup(
  config?: GatewayConfig,
  format: ConfigFormat = "json",
  text?: string,
  options: ControllerOptions = {},
): Promise<{
  directory: string;
  path: string;
  config: GatewayConfig;
  controller: McpGatewayController;
  cleanup(): Promise<void>;
}> {
  const directory = await testDirectory();
  const path = join(directory, format === "jsonc" ? "mcp.jsonc" : "mcp.json");
  const selected = config ?? (await configFor());
  await writeFile(path, text ?? `${JSON.stringify(selected, null, 2)}\n`, { mode: 0o600 });
  const controller = await open(join(directory, "mcp.json"), options);
  return {
    directory,
    path,
    config: selected,
    controller,
    cleanup: async () => {
      await controller.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
// Exercise the real listener error handler without an OS-dependent socket failure.
export function failListener(controller: McpGatewayController): void {
  // biome-ignore lint/complexity/useLiteralKeys: Typed test access to the privately owned listener.
  const ingress = controller["ingress"];
  if (!ingress?.running) throw new Error("Expected a running fixture listener");
  // biome-ignore lint/complexity/useLiteralKeys: Trigger the actual private server's error handler.
  ingress["server"].emit("error", new Error("Synthetic listener failure"));
}

// A resolver whose answers stay pending until the test releases them, so a
// self-proxy check can be observed while it is still waiting.
export function controlledResolver() {
  let held = true;
  let outcome: Error | string[] = ["192.0.2.10"];
  const waiters = new Set<{
    resolve(addresses: readonly { address: string }[]): void;
    reject(error: Error): void;
  }>();
  const calls: string[] = [];
  const answer = (addresses: string[]) => addresses.map((address) => ({ address }));
  const resolve: SelfProxyResolver = (hostname) => {
    calls.push(hostname);
    if (!held) {
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(answer(outcome));
    }
    return new Promise((done, fail) => waiters.add({ resolve: done, reject: fail }));
  };
  const release = (addresses: string[] = ["192.0.2.10"]) => {
    held = false;
    outcome = addresses;
    for (const waiter of waiters) waiter.resolve(answer(addresses));
    waiters.clear();
  };
  return {
    resolve,
    calls,
    release,
    fail(error: Error) {
      held = false;
      outcome = error;
      for (const waiter of waiters) waiter.reject(error);
      waiters.clear();
    },
    get pending() {
      return waiters.size;
    },
  };
}

/** Bound how long a test waits for one operation, without leaving it unobserved. */
export async function within<A>(promise: Promise<A>, timeout = 2_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("The operation did not settle before its test bound.")),
          timeout,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function connect(
  address: string,
  name = "echo",
): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
  close(): Promise<void>;
}> {
  const client = new Client({ name: "synthetic-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${address}/mcp/${name}`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  try {
    await client.connect(transport, { timeout: 8_000 });
  } catch (error) {
    await client.close();
    throw error;
  }
  return {
    client,
    transport,
    close: async () => {
      try {
        await transport.terminateSession();
      } finally {
        await client.close();
      }
    },
  };
}
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeout = 5_000,
): Promise<void> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("Condition did not become true before timeout");
}
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export async function pids(path: string): Promise<number[]> {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").map(Number);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
