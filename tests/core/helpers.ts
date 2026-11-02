import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type McpGatewayController, open } from "../../src/core/controller";
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
  const controller = await open(join(directory, "mcp.json"));
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
