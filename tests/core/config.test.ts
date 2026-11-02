// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Configuration fixtures require literal environment references.
import { describe, expect, test } from "bun:test";
import {
  MAX_CONFIG_BYTES,
  newConfigText,
  parseConfig,
  serverFingerprint,
} from "../../src/core/config";
import { configFor, TOKEN } from "./helpers";

function rejected(text: string): void {
  expect(() => parseConfig(text)).toThrow();
  try {
    parseConfig(text);
  } catch (error) {
    expect(String(error)).not.toContain("SECRET-fixture");
  }
}

describe("config", () => {
  test("new configs are stopped, empty and have independent strong tokens", () => {
    const first = parseConfig(newConfigText());
    const second = parseConfig(newConfigText());
    expect(first.gateway.autoStart).toBe(false);
    expect(first.gateway.launchAtLogin).toBe(false);
    expect(first.mcpServers).toEqual({});
    expect(first.gateway.token).toMatch(/^[a-f0-9]{64}$/);
    expect(first.gateway.token).not.toBe(second.gateway.token);
  });

  test("preserves standard fields and resolves references without shell evaluation", async () => {
    const config = await configFor({
      local: {
        command: "${EXECUTABLE}",
        args: ["literal;$(touch nope)", "${VALUE}"],
        cwd: "${DIRECTORY}",
        env: { VALUE: "${VALUE}" },
        disabled: false,
      },
      remote: { url: "${UPSTREAM}", headers: { Authorization: "Bearer ${VALUE}" }, disabled: true },
    });
    config.gateway.token = "${TOKEN}";
    const result = parseConfig(JSON.stringify(config), {
      EXECUTABLE: "/usr/bin/printf",
      VALUE: "SECRET-fixture",
      DIRECTORY: process.cwd(),
      UPSTREAM: "https://example.invalid/mcp",
      TOKEN,
    });
    expect(result.mcpServers.local).toEqual({
      command: "/usr/bin/printf",
      args: ["literal;$(touch nope)", "SECRET-fixture"],
      cwd: process.cwd(),
      env: { VALUE: "SECRET-fixture" },
      disabled: false,
    });
    expect(result.mcpServers.remote).toEqual({
      url: "https://example.invalid/mcp",
      headers: { authorization: "Bearer SECRET-fixture" },
      disabled: true,
    });
  });

  test("normalizes expanded runtime headers without changing source spelling or fingerprints", async () => {
    const config = await configFor({
      remote: {
        url: "https://example.invalid/mcp",
        headers: { "Content-Type": "application/json", Authorization: "Bearer ${VALUE}" },
      },
    });
    const source = `// Retain header spelling and environment references.\n${JSON.stringify(config)}\n`;
    const parsed = parseConfig(source, { VALUE: "synthetic-upstream-token" }, "jsonc");
    expect(parsed.mcpServers.remote).toEqual({
      url: "https://example.invalid/mcp",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer synthetic-upstream-token",
      },
    });
    const lower = parseConfig(
      source
        .replace('"Content-Type"', '"content-type"')
        .replace('"Authorization"', '"authorization"'),
      { VALUE: "synthetic-upstream-token" },
      "jsonc",
    );
    expect(serverFingerprint(parsed.mcpServers.remote)).toBe(
      serverFingerprint(lower.mcpServers.remote),
    );
    expect(config.mcpServers.remote).toEqual({
      url: "https://example.invalid/mcp",
      headers: { "Content-Type": "application/json", Authorization: "Bearer ${VALUE}" },
    });
  });

  test("rejects ambiguous server kinds, unknown policy and invalid trusted-boundary values", async () => {
    const base = await configFor();
    const badServers = [
      { command: "echo", url: "https://example.invalid" },
      { command: "echo", shell: true },
      { url: "https://example.invalid", allowedTools: ["read"] },
      { command: "echo", args: "SECRET-fixture" },
      { command: "echo", cwd: "relative" },
      { command: "echo", env: { "BAD=KEY": "SECRET-fixture" } },
      { command: "echo\u0000SECRET-fixture" },
      { url: "file:///SECRET-fixture" },
      { url: "https://user:SECRET-fixture@example.invalid" },
      { url: "https://example.invalid", headers: { Host: "SECRET-fixture" } },
      { url: "https://example.invalid", headers: { "McP-SeSsIoN-Id": "SECRET-fixture" } },
      {
        url: "https://example.invalid",
        headers: { Authorization: "SECRET-fixture", authorization: "duplicate" },
      },
      { url: "https://example.invalid", headers: { "Bad Header": "SECRET-fixture" } },
      {
        url: "https://example.invalid",
        headers: { Authorization: "SECRET-fixture\r\nX: injected" },
      },
      { command: "${UNDEFINED_FIXTURE_REFERENCE}" },
    ];
    for (const server of badServers)
      rejected(JSON.stringify({ ...base, mcpServers: { echo: server } }));
    rejected(JSON.stringify({ ...base, policy: "SECRET-fixture" }));
    rejected(JSON.stringify({ ...base, mcpServers: { "../bad": { command: "echo" } } }));
    rejected(JSON.stringify({ ...base, gateway: { ...base.gateway, port: 0 } }));
    rejected(JSON.stringify({ ...base, gateway: { ...base.gateway, port: 1.2 } }));
    rejected(JSON.stringify({ ...base, gateway: { ...base.gateway, token: "SECRET-fixture" } }));
    rejected(JSON.stringify(base).replace('"gateway":', '"gateway":{},"gateway":'));
    rejected('{"gateway":');
    rejected(" ".repeat(MAX_CONFIG_BYTES + 1));
  });
});
