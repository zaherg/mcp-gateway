import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { type ControllerOptions, type McpGatewayController, open } from "../../src/core/controller";
import type { GatewayIngress } from "../../src/core/ingress";
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

export const MODERN_PROTOCOL = "2026-07-28";

/** One stateless MCP 2026-07-28 call through the gateway. */
export async function mcpCall(
  address: string,
  name: string,
  method: string,
  params: Record<string, unknown> = {},
  id: string | number = 1,
  signal?: AbortSignal,
  // biome-ignore lint/suspicious/noExplicitAny: Parsed JSON-RPC envelope from the loopback gateway.
): Promise<{ status: number; message: Record<string, any> | null }> {
  const response = await fetch(`${address}/mcp/${name}`, {
    method: "POST",
    signal: signal ?? AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Protocol-Version": MODERN_PROTOCOL,
      "Mcp-Method": method,
      ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL,
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

/** Observe the real ledgers without adding a production diagnostics API. */
export function ingressCounts(ingress: GatewayIngress) {
  return {
    // biome-ignore lint/complexity/useLiteralKeys: Typed test access to owned admission state.
    active: ingress["active"],
    // biome-ignore lint/complexity/useLiteralKeys: Typed test access to owned admission state.
    rate: ingress["rateCount"],
    // biome-ignore lint/complexity/useLiteralKeys: Typed test access to owned admission state.
    resources: ingress["admission"]["used"],
    // biome-ignore lint/complexity/useLiteralKeys: Typed test access to owned admission state.
    calls: ingress["work"].outstanding,
  };
}

/** A minimal stateless client; rejects up front when the endpoint is unusable. */
export async function connect(address: string, name = "echo") {
  const result = async (method: string, params?: Record<string, unknown>, signal?: AbortSignal) => {
    const { status, message } = await mcpCall(address, name, method, params, 1, signal);
    if (status !== 200 || !message || message.error)
      throw new Error(`MCP ${method} failed: ${status}`);
    return message.result;
  };
  await result("tools/list");
  const client = {
    listTools: () => result("tools/list") as Promise<{ tools: Array<{ name: string }> }>,
    callTool: (
      params: { name: string; arguments?: Record<string, unknown> },
      _options?: unknown,
      extra?: { signal?: AbortSignal; timeout?: number },
    ) =>
      result("tools/call", params, extra?.signal) as Promise<
        {
          content?: Array<{ type: string; text: string }>;
          isError?: boolean;
          requestState?: string;
        } & Record<string, unknown>
      >,
    close: async () => {},
  };
  return { client, close: async () => {} };
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
