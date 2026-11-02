import { createRoot } from "react-dom/client";
import { App } from "../../src/mainview/App";
import "../../src/mainview/styles.css";
import type { AppClient, AppResult, AppSnapshot, QuitStatus } from "../../src/shared/rpc";
import type { GatewayConfig } from "../../src/shared/types";

let config: GatewayConfig = {
  gateway: {
    host: "192.168.68.130",
    port: 8765,
    token: "synthetic-test-token-not-a-real-secret",
    autoStart: false,
    launchAtLogin: false,
  },
  mcpServers: {},
};
let revision = 1;
let running = false;
let broken = false;
let quitStatus: QuitStatus = { attempt: 0, phase: "idle", error: null };
const calls: Array<{ action: string; expectedRevision?: string; name?: string }> = [];
function snapshot(): AppSnapshot {
  return {
    platform: "macos",
    gateway: {
      configFormat: "json",
      configPath: "/synthetic/Application Support/MCP Gateway/mcp.json",
      configText: broken ? '{"unknown":true}' : `${JSON.stringify(config, null, 2)}\n`,
      revision: String(revision),
      running,
      address: running ? `http://${config.gateway.host}:${config.gateway.port}` : null,
      interfaces: [
        { name: "en0", address: "192.168.68.130", netmask: "255.255.252.0", loopback: false },
        { name: "lo0", address: "127.0.0.1", netmask: "255.0.0.0", loopback: true },
      ],
      servers: Object.entries(config.mcpServers).map(([name, server]) => ({
        name,
        type: "url" in server ? "http" : "stdio",
        endpoint: `http://${config.gateway.host}:${config.gateway.port}/mcp/${name}`,
        enabled: !server.disabled,
        status: server.disabled ? "disabled" : running ? "mounted" : "stopped",
        error: null,
      })),
      events: [],
      configError: broken
        ? {
            code: "InvalidConfig",
            message: "Unknown configuration properties.",
            occurrenceId: "synthetic-config-issue",
          }
        : null,
      operationalError: null,
    },
    login: { enabled: config.gateway.launchAtLogin ?? false, supported: true, error: null },
  };
}
const ok = <T,>(value: T): AppResult<T> => ({ ok: true, value });
const client: AppClient = {
  readLogs: async () => ok({ entries: [], cursor: 0, generation: 0, gap: false, hasMore: false }),
  clearLogs: async () => ok({ entries: [], cursor: 0, generation: 1, gap: false, hasMore: false }),
  snapshot: async () => ok(snapshot()),
  quit: async () => {
    calls.push({ action: "quit" });
    quitStatus = { attempt: quitStatus.attempt + 1, phase: "ready", error: null };
    return ok({ requested: true, status: quitStatus });
  },
  quitStatus: async () => ok(quitStatus),
  start: async () => {
    calls.push({ action: "start" });
    running = true;
    return ok(snapshot());
  },
  stop: async () => {
    calls.push({ action: "stop" });
    running = false;
    return ok(snapshot());
  },
  restartServer: async ({ name }) => {
    calls.push({ action: "restart", name });
    return ok(snapshot());
  },
  saveConfig: async ({ text, expectedRevision }) => {
    calls.push({ action: "save", expectedRevision });
    if (expectedRevision !== String(revision))
      return {
        ok: false,
        error: { code: "StaleRevision", message: "Configuration changed externally." },
      };
    try {
      const next = JSON.parse(text);
      if (
        !next.gateway ||
        !next.mcpServers ||
        Object.keys(next).some((key) => !["gateway", "mcpServers"].includes(key))
      )
        throw new Error("Unsupported configuration.");
      config = next;
      broken = false;
      revision++;
      return ok(snapshot());
    } catch {
      return {
        ok: false,
        error: { code: "InvalidConfig", message: "Configuration must match the schema." },
      };
    }
  },
  copyEndpoint: async ({ name }) => {
    calls.push({ action: "copyEndpoint", name });
    return ok(null);
  },
  copyClientConfig: async ({ name }) => {
    calls.push({ action: "copyClientConfig", name });
    return ok(null);
  },
};
declare global {
  interface Window {
    uiFixture: {
      externalChange(): void;
      breakConfig(): void;
      state(): { config: GatewayConfig; revision: number; calls: typeof calls };
    };
  }
}
window.uiFixture = {
  externalChange() {
    revision++;
  },
  breakConfig() {
    broken = true;
    revision++;
    running = false;
  },
  state: () => ({ config, revision, calls }),
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing test root.");
createRoot(root).render(<App client={client} />);
