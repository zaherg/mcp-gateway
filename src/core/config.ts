import { randomBytes } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isAbsolute } from "node:path";
import { Schema } from "effect";
import { type ConfigFormat, parseConfigDocument } from "../shared/config-document";
import type { GatewayConfig, HttpServerConfig, StdioServerConfig } from "../shared/types";
import { failure } from "./errors";

export const MAX_CONFIG_BYTES = 1024 * 1024;
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const StringMap = Schema.Record(Schema.String, Schema.String);
const StdioSchema = Schema.Struct({
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(StringMap),
  cwd: Schema.optionalKey(Schema.String),
  disabled: Schema.optionalKey(Schema.Boolean),
});
const HttpSchema = Schema.Struct({
  url: Schema.String,
  headers: Schema.optionalKey(StringMap),
  disabled: Schema.optionalKey(Schema.Boolean),
});
const ConfigSchema = Schema.Struct({
  gateway: Schema.Struct({
    host: Schema.String,
    port: Schema.Number,
    token: Schema.String,
    autoStart: Schema.optionalKey(Schema.Boolean),
    launchAtLogin: Schema.optionalKey(Schema.Boolean),
  }),
  mcpServers: Schema.Record(Schema.String, Schema.Union([StdioSchema, HttpSchema])),
});

function invalid(message = "Configuration does not match the supported schema."): never {
  throw failure("InvalidConfig", message);
}

function expand(value: string, environment: NodeJS.ProcessEnv): string {
  const result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = environment[name];
    if (replacement === undefined) invalid("A referenced environment variable is not defined.");
    return replacement;
  });
  if (result.includes("\0")) invalid("NUL characters are not allowed.");
  return result;
}

export function isHttpServer(
  server: StdioServerConfig | HttpServerConfig,
): server is HttpServerConfig {
  return "url" in server;
}

export function parseConfig(
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
  format: ConfigFormat = "json",
): GatewayConfig {
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) invalid("Configuration exceeds the size limit.");
  let config: GatewayConfig;
  try {
    const raw = parseConfigDocument(text, format);
    const decoded = Schema.decodeUnknownSync(ConfigSchema, { onExcessProperty: "error" })(raw);
    config = {
      gateway: { ...decoded.gateway },
      mcpServers: Object.fromEntries(
        Object.entries(decoded.mcpServers).map(([name, server]) => [
          name,
          "command" in server
            ? { ...server, args: server.args ? [...server.args] : undefined }
            : { ...server },
        ]),
      ),
    };
  } catch {
    invalid();
  }
  const map = (value: string) => expand(value, environment);
  const gateway = config.gateway;
  gateway.host = map(gateway.host);
  gateway.token = map(gateway.token);
  if (!Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65535)
    invalid("The listener port must be an integer from 1 to 65535.");
  if (!/^[\x21-\x7e]{32,512}$/.test(gateway.token))
    invalid("The bearer token must contain 32 to 512 printable non-space ASCII characters.");
  if (Object.keys(config.mcpServers).length > 64) invalid("At most 64 servers are supported.");
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!SAFE_NAME.test(name)) invalid("Server names must be safe URL path segments.");
    if (isHttpServer(server)) {
      server.url = map(server.url);
      let url: URL;
      try {
        url = new URL(server.url);
      } catch {
        invalid("An upstream URL is invalid.");
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
        invalid("Upstreams require HTTP(S) URLs without userinfo or fragments.");
      if (server.headers) {
        const names = new Set<string>();
        server.headers = Object.fromEntries(
          Object.entries(server.headers).map(([header, value]) => {
            if (names.has(header.toLowerCase()))
              invalid("Duplicate upstream header names are not allowed.");
            names.add(header.toLowerCase());
            // Transport framing and destination are owned by the HTTP client.
            if (
              /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|mcp-session-id)$/i.test(
                header,
              )
            )
              invalid("An upstream header attempts to override transport policy.");
            const expanded = map(value);
            try {
              validateHeaderName(header);
              validateHeaderValue(header, expanded);
            } catch {
              invalid("An upstream header is invalid.");
            }
            return [header.toLowerCase(), expanded];
          }),
        );
      }
    } else {
      server.command = map(server.command);
      if (!server.command.trim()) invalid("A command executable is required.");
      server.args = server.args?.map(map);
      if (server.cwd !== undefined) {
        server.cwd = map(server.cwd);
        if (!isAbsolute(server.cwd)) invalid("A command working directory must be absolute.");
      }
      if (server.env) {
        for (const [key, value] of Object.entries(server.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            invalid("A command environment key is invalid.");
          server.env[key] = map(value);
        }
      }
    }
  }
  return config;
}

export function serverFingerprint(server: StdioServerConfig | HttpServerConfig): string {
  const sorted = (values: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(
    isHttpServer(server)
      ? {
          url: new URL(server.url).href,
          headers: sorted(
            Object.fromEntries(
              Object.entries(server.headers ?? {}).map(([name, value]) => [
                name.toLowerCase(),
                value,
              ]),
            ),
          ),
        }
      : {
          command: server.command,
          args: server.args ?? [],
          env: sorted(server.env),
          cwd: server.cwd,
        },
  );
}

export function newConfigText(host = "127.0.0.1"): string {
  return `${JSON.stringify(
    {
      gateway: {
        host,
        port: 8765,
        token: randomBytes(32).toString("hex"),
        autoStart: false,
        launchAtLogin: false,
      },
      mcpServers: {},
    },
    null,
    2,
  )}\n`;
}
