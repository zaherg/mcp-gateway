import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { failure, GatewayError } from "@mcp-gateway/core/errors";
import { anyNumber, ownRecord } from "@mcp-gateway/core/schema";
import {
  type ConfigFormat,
  configFormat,
  parseConfigDocument,
} from "@mcp-gateway/shared/config-document";
import type { GatewayConfig, HttpServerConfig, StdioServerConfig } from "@mcp-gateway/shared/types";
import * as z from "zod/v4";

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

export const MAX_CONFIG_BYTES = 1024 * 1024;
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const StringMap = ownRecord(z.string());
const StdioSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).exactOptional(),
  env: StringMap.exactOptional(),
  cwd: z.string().exactOptional(),
  disabled: z.boolean().exactOptional(),
  legacyProtocol: z.boolean().exactOptional(),
});
const HttpSchema = z.strictObject({
  url: z.string(),
  headers: StringMap.exactOptional(),
  disabled: z.boolean().exactOptional(),
  legacyProtocol: z.boolean().exactOptional(),
});
const ConfigSchema = z.strictObject({
  gateway: z.strictObject({
    host: z.string(),
    port: anyNumber,
    token: z.string(),
    autoStart: z.boolean().exactOptional(),
    launchAtLogin: z.boolean().exactOptional(),
  }),
  mcpServers: ownRecord(z.union([StdioSchema, HttpSchema])),
});

const invalid: (message?: string) => never = (
  message = "Configuration does not match the supported schema.",
) => {
  throw failure("InvalidConfig", message);
};

const expand = (value: string, environment: NodeJS.ProcessEnv): string => {
  const result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = environment[name];
    if (replacement === undefined) invalid("A referenced environment variable is not defined.");
    return replacement;
  });
  if (result.includes("\0")) invalid("NUL characters are not allowed.");
  return result;
};

export const isHttpServer = (
  server: StdioServerConfig | HttpServerConfig,
): server is HttpServerConfig => {
  return "url" in server;
};

export const parseConfig = (
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
  format: ConfigFormat = "json",
): GatewayConfig => {
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) invalid("Configuration exceeds the size limit.");
  let config: GatewayConfig;
  try {
    const raw = parseConfigDocument(text, format);
    const decoded = ConfigSchema.parse(raw);
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
};

export const serverFingerprint = (server: StdioServerConfig | HttpServerConfig): string => {
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
          legacyProtocol: server.legacyProtocol === true,
        }
      : {
          command: server.command,
          args: server.args ?? [],
          env: sorted(server.env),
          cwd: server.cwd,
          legacyProtocol: server.legacyProtocol === true,
        },
  );
};

const newConfigText = (host = "127.0.0.1"): string => {
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
};
const safeParent = async (path: string): Promise<void> => {
  const parent = dirname(path);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw failure("UnsafeFile", "Configuration paths must not contain symlinks.");
  }
  const stat = await fs.lstat(parent);
  if ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw failure(
      "UnsafeFile",
      "The configuration directory must be owned by this user and not writable by others.",
    );
};

export const ensureParent = async (path: string): Promise<void> => {
  const parent = dirname(path);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (!missing(error)) throw error;
      await safeParent(current);
      try {
        await fs.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw failure("UnsafeFile", "Configuration paths must not contain symlinks.");
  }
  await safeParent(path);
};

export interface ConfigDocument {
  text: string;
  revision: string;
}
const revisionOf = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const guarded = async <A>(work: () => Promise<A>): Promise<A> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw failure("ConfigIO", "Configuration file access failed.");
  }
};

const safeFile = (stat: Stats): void => {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw failure(
      "UnsafeFile",
      "The configuration must be an owner-only regular file with no hard links.",
    );
};

export class ConfigStore {
  private selectedPath: string;
  private readonly jsonPath: string;
  private readonly jsoncPath: string;
  private selectionRefused = false;
  private initialized = false;
  constructor(path: string) {
    this.selectedPath = resolve(path);
    this.jsonPath = this.selectedPath.endsWith(".jsonc")
      ? this.selectedPath.slice(0, -1)
      : this.selectedPath;
    this.jsoncPath = `${this.jsonPath}c`;
  }

  get path(): string {
    return this.selectedPath;
  }
  get format(): ConfigFormat {
    return configFormat(this.path);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await fs.lstat(path);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private async checkSelection(): Promise<void> {
    if (this.selectionRefused)
      throw failure(
        "AmbiguousConfig",
        "Both configuration files exist; keep only one and reopen the app.",
      );
    const alternate = this.path === this.jsonPath ? this.jsoncPath : this.jsonPath;
    if (await this.exists(alternate)) {
      if (await this.exists(this.path))
        throw failure(
          "AmbiguousConfig",
          "Both configuration files exist; keep only one and reopen the app.",
        );
      throw failure("ConfigIO", "The configuration filename changed; reopen the app to select it.");
    }
  }

  read(): Promise<ConfigDocument> {
    return guarded(async () => {
      await safeParent(this.path);
      await this.checkSelection();
      const entry = await fs.lstat(this.path);
      if (entry.isSymbolicLink())
        throw failure("UnsafeFile", "Symlinked configuration files are refused.");
      const handle = await fs.open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat();
        safeFile(before);
        if (before.ino !== entry.ino || before.dev !== entry.dev)
          throw failure("UnsafeFile", "The configuration file changed during access.");
        if (before.size > MAX_CONFIG_BYTES)
          throw failure("InvalidConfig", "Configuration exceeds the size limit.");
        const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await handle.stat();
        if (length > MAX_CONFIG_BYTES)
          throw failure("InvalidConfig", "Configuration exceeds the size limit.");
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw failure("ConfigIO", "The configuration changed during access.");
        const bytes = buffer.subarray(0, length);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw failure("InvalidConfig", "Configuration must contain valid UTF-8.");
        }
        await this.checkSelection();
        return { text, revision: revisionOf(bytes) };
      } finally {
        await handle.close();
      }
    });
  }

  private async locked<A>(work: () => Promise<A>): Promise<A> {
    await safeParent(this.path);
    const lockPath = `${this.jsonPath}.lock`;
    let lock: fs.FileHandle;
    try {
      lock = await fs.open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw failure(
          "ConfigLocked",
          "Configuration is locked. If mcp.json.lock beside the configuration is stale, quit every app instance and confirm no writer is active before removing it and retrying.",
        );
      throw error;
    }
    try {
      return await work();
    } finally {
      try {
        await lock.close();
      } finally {
        await fs.unlink(lockPath);
      }
    }
  }

  private async replace(text: string, create: boolean): Promise<void> {
    const temp = join(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`);
    const file = await fs.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let failed: { error: unknown } | undefined;
    try {
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      if (create) {
        await fs.link(temp, this.path);
        await fs.unlink(temp);
      } else {
        await fs.rename(temp, this.path);
      }
      const directory = await fs.open(
        dirname(this.path),
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      failed = { error };
    } finally {
      try {
        await fs.unlink(temp);
      } catch (error) {
        if (!missing(error) && !failed) failed = { error };
      }
    }
    if (failed) throw failed.error;
  }

  initialize(): Promise<ConfigDocument> {
    if (this.initialized || this.selectionRefused) return this.read();
    return guarded(async () => {
      // Inspect each ancestor before creating owner-only directories; recursive
      // mkdir would follow a symlink before the policy check could reject it.
      await ensureParent(this.path);
      await this.locked(async () => {
        const json = await this.exists(this.jsonPath);
        const jsonc = await this.exists(this.jsoncPath);
        if (json && jsonc) {
          this.selectionRefused = true;
          throw failure(
            "AmbiguousConfig",
            "Both configuration files exist; keep only one and reopen the app.",
          );
        }
        this.selectedPath = jsonc ? this.jsoncPath : this.jsonPath;
        if (!json && !jsonc) await this.replace(newConfigText(), true);
        this.initialized = true;
      });
      return this.read();
    });
  }

  save(text: string, expectedRevision: string): Promise<ConfigDocument> {
    return guarded(() =>
      this.locked(async () => {
        await this.checkSelection();
        parseConfig(text, process.env, this.format);
        const current = await this.read();
        if (current.revision !== expectedRevision)
          throw failure("StaleRevision", "Configuration changed on disk; reload before saving.");
        if (current.text === text) return current;
        await this.checkSelection();
        await this.replace(text, false);
        return { text, revision: revisionOf(text) };
      }),
    );
  }
}
