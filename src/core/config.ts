import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { basename, dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { getNodeValue, type JSONPath } from 'jsonc-parser';
import * as z from 'zod/v4';

import { failure, GatewayError } from '@mcp-gateway/core/errors';
import { ipv4Number, isLocalRange, isSharedIpv4, parseIpv4Range } from '@mcp-gateway/core/ipv4';
import { anyNumber, ownRecord } from '@mcp-gateway/core/schema';
import {
  CONFIG_TOO_LARGE,
  type ConfigFormat,
  type ConfigIssue,
  configFormat,
  configRange,
  isRecord,
  MAX_CONFIG_BYTES,
  parseConfigDocument,
  parseConfigTree,
} from '@mcp-gateway/shared/config-document';
import type { GatewayConfig, HttpServerConfig, StdioServerConfig } from '@mcp-gateway/shared/types';

// Re-exported for existing main-process callers; the renderer imports the shared definition.
export { MAX_CONFIG_BYTES };

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

const AMBIGUOUS_CONFIG = 'Both configuration files exist; keep only one and reopen the app.';
// A lock with no readable pid is only treated as abandoned after this long.
const STALE_UNOWNED_LOCK_MS = 10_000;
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const StringMap = ownRecord(z.string());
const StdioSchema = z.strictObject({
  command: z.string(),
  args: z.array(z.string()).exactOptional(),
  env: StringMap.exactOptional(),
  cwd: z.string().exactOptional(),
  disabled: z.boolean().exactOptional(),
  legacyProtocol: z.boolean().exactOptional(),
  token: z.string().exactOptional(),
});
const HttpSchema = z.strictObject({
  url: z.string(),
  headers: StringMap.exactOptional(),
  disabled: z.boolean().exactOptional(),
  legacyProtocol: z.boolean().exactOptional(),
  token: z.string().exactOptional(),
});
const ConfigSchema = z.strictObject({
  gateway: z.strictObject({
    host: z.string(),
    port: anyNumber,
    token: z.string(),
    autoStart: z.boolean().exactOptional(),
    launchAtLogin: z.boolean().exactOptional(),
    allowedPeers: z.array(z.string()).exactOptional(),
  }),
  mcpServers: ownRecord(z.union([StdioSchema, HttpSchema])),
});

const invalid: (message?: string) => never = (
  message = 'Configuration does not match the supported schema.',
) => {
  throw failure('InvalidConfig', message);
};

/** A fixed, range-bearing explanation of the first structural configuration problem. */
interface StructureIssue {
  message: string;
  path: JSONPath;
  /** Point at the property name instead of its value, for unknown properties. */
  key?: boolean;
}

const UNKNOWN_PROPERTY = 'An unknown property is present; remove or rename it.';
const MISSING_PROPERTY = 'A required property is missing.';
const WRONG_PROPERTY = 'A property has the wrong type or value.';
const ROOT_OBJECT = 'The configuration must be a JSON object.';
const SERVER_ENTRY = 'A server entry must be an object with supported fields.';
const SERVER_TRANSPORT = 'A server entry must use either command fields or URL fields, not both.';
const SERVERS_OBJECT = 'Servers must be an object with one entry per server.';

/** Whether the parsed document has an entry at `path`; JSON cannot hold `undefined`. */
const pathExists = (value: unknown, path: JSONPath): boolean => {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return false;
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return false;
      current = current[segment];
      continue;
    }
    // Own properties only: a parsed configuration carries no inherited keys.
    if (!Object.hasOwn(current, segment)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return true;
};

const isUnrecognizedKeys = (issue: z.core.$ZodIssue): issue is z.core.$ZodIssueUnrecognizedKeys =>
  issue.code === 'unrecognized_keys';

const issuePath = (issue: z.core.$ZodIssue, base: JSONPath): JSONPath | null => {
  const path: JSONPath = [...base];
  for (const segment of issue.path) {
    if (typeof segment !== 'string' && typeof segment !== 'number') return null;
    path.push(segment);
  }
  return path;
};

const describeIssue = (
  issue: z.core.$ZodIssue,
  base: JSONPath,
  root: unknown,
): StructureIssue | null => {
  const path = issuePath(issue, base);
  if (!path) return null;
  if (path.length === 0 && issue.code === 'invalid_type') return { message: ROOT_OBJECT, path };
  if (isUnrecognizedKeys(issue)) {
    const key = issue.keys[0];
    if (key === undefined) return null;
    return { message: UNKNOWN_PROPERTY, path: [...path, key], key: true };
  }
  // Only schema-owned field names may appear in diagnostics, never arbitrary input keys.
  if (!pathExists(root, path)) {
    const key = path.at(-1);
    const known =
      typeof key === 'string' &&
      [ConfigSchema, ConfigSchema.shape.gateway, StdioSchema, HttpSchema].some((schema) =>
        Object.hasOwn(schema.shape, key),
      );
    return {
      message: known ? `The "${key}" property is required.` : MISSING_PROPERTY,
      path: path.slice(0, -1),
    };
  }
  return { message: WRONG_PROPERTY, path };
};

const preferredIssue = (issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue | undefined => {
  return issues.find((issue) => issue.code === 'unrecognized_keys') ?? issues[0];
};

const serverIssue = (entry: unknown, path: JSONPath, root: unknown): StructureIssue | null => {
  if (!isRecord(entry)) return { message: SERVER_ENTRY, path };
  const http = Object.hasOwn(entry, 'url');
  if (http && Object.hasOwn(entry, 'command')) return { message: SERVER_TRANSPORT, path };
  const result = (http ? HttpSchema : StdioSchema).safeParse(entry);
  if (result.success) return null;
  const issue = preferredIssue(result.error.issues);
  const field = issue?.path[0];
  if (issue?.code === 'custom' && (field === 'headers' || field === 'env')) {
    const values = entry[field];
    if (isRecord(values)) {
      // StringMap keeps its record-level error; locate the value using that same schema.
      for (const [key, value] of Object.entries(values)) {
        if (!StringMap.safeParse({ [key]: value }).success)
          return { message: WRONG_PROPERTY, path: [...path, field, key] };
      }
    }
  }
  return issue ? describeIssue(issue, path, root) : null;
};

/** Explains a schema failure using the same schemas and rules as the authoritative parse. */
const structureIssue = (value: unknown): StructureIssue | null => {
  const result = ConfigSchema.safeParse(value);
  if (result.success) return null;
  const issue = preferredIssue(result.error.issues);
  if (!issue) return null;
  // ownRecord reports one record-level issue; recover the failing server entry's own path.
  if (issue.code === 'custom' && issue.path.length === 1 && issue.path[0] === 'mcpServers') {
    if (!pathExists(value, ['mcpServers'])) return describeIssue(issue, [], value);
    const servers = isRecord(value) ? value.mcpServers : undefined;
    if (!isRecord(servers)) return { message: SERVERS_OBJECT, path: ['mcpServers'] };
    for (const [name, entry] of Object.entries(servers)) {
      const found = serverIssue(entry, ['mcpServers', name], value);
      if (found) return found;
    }
    return null;
  }
  return describeIssue(issue, [], value);
};

const TOKEN_RULE = '32 to 512 printable non-space ASCII characters.';
const MAX_ALLOWED_PEERS = 16;
const assertToken = (token: string, message: string): void => {
  if (!/^[\x21-\x7e]{32,512}$/.test(token)) invalid(message);
};

const expand = (value: string, environment: NodeJS.ProcessEnv): string => {
  const result = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = environment[name];
    if (replacement === undefined) invalid('A referenced environment variable is not defined.');
    return replacement;
  });
  if (result.includes('\0')) invalid('NUL characters are not allowed.');
  return result;
};

export const isHttpServer = (
  server: StdioServerConfig | HttpServerConfig,
): server is HttpServerConfig => {
  return 'url' in server;
};

const validateConfig = (value: unknown, environment: NodeJS.ProcessEnv): GatewayConfig => {
  let config: GatewayConfig;
  try {
    config = ConfigSchema.parse(value);
  } catch {
    invalid();
  }
  const map = (value: string) => expand(value, environment);
  const gateway = config.gateway;
  gateway.host = map(gateway.host);
  gateway.token = map(gateway.token);
  if (!Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65535)
    invalid('The listener port must be an integer from 1 to 65535.');
  assertToken(gateway.token, `The bearer token must contain ${TOKEN_RULE}`);
  // A shared-space interface netmask is a tunnel's single address or a carrier's
  // other customers, so it never selects clients; the ranges must be explicit.
  const host = ipv4Number(gateway.host);
  if (gateway.allowedPeers === undefined && host !== null && isSharedIpv4(host))
    invalid('A 100.64.0.0/10 address needs allowedPeers, such as ["100.64.0.0/10"].');
  if (gateway.allowedPeers !== undefined) {
    if (gateway.allowedPeers.length < 1 || gateway.allowedPeers.length > MAX_ALLOWED_PEERS)
      invalid(`allowedPeers must list 1 to ${MAX_ALLOWED_PEERS} address ranges.`);
    if (gateway.host.startsWith('127.'))
      invalid('allowedPeers cannot be used with a loopback address.');
    for (const text of gateway.allowedPeers) {
      const range = parseIpv4Range(text);
      if (!range || !isLocalRange(range))
        invalid(
          'Each allowedPeers entry must be a private or 100.64.0.0/10 IPv4 range, such as 100.64.0.0/10.',
        );
    }
  }
  if (Object.keys(config.mcpServers).length > 64) invalid('At most 64 servers are supported.');
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (!SAFE_NAME.test(name)) invalid('Server names must be safe URL path segments.');
    // An explicit key is authoritative even on a disabled server; only omission inherits.
    if (server.token !== undefined) {
      server.token = map(server.token);
      assertToken(server.token, `A server token must contain ${TOKEN_RULE}`);
    }
    if (isHttpServer(server)) {
      server.url = map(server.url);
      let url: URL;
      try {
        url = new URL(server.url);
      } catch {
        invalid('An upstream URL is invalid.');
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
        invalid('Upstreams require HTTP(S) URLs without userinfo or fragments.');
      if (server.headers) {
        const names = new Set<string>();
        server.headers = Object.fromEntries(
          Object.entries(server.headers).map(([header, value]) => {
            if (names.has(header.toLowerCase()))
              invalid('Duplicate upstream header names are not allowed.');
            names.add(header.toLowerCase());
            // Transport framing and destination are owned by the HTTP client.
            if (
              /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|mcp-session-id)$/i.test(
                header,
              )
            )
              invalid('An upstream header attempts to override transport policy.');
            const expanded = map(value);
            try {
              validateHeaderName(header);
              validateHeaderValue(header, expanded);
            } catch {
              invalid('An upstream header is invalid.');
            }
            return [header.toLowerCase(), expanded];
          }),
        );
      }
    } else {
      server.command = map(server.command);
      if (!server.command.trim()) invalid('A command executable is required.');
      server.args = server.args?.map(map);
      if (server.cwd !== undefined) {
        server.cwd = map(server.cwd);
        if (!isAbsolute(server.cwd)) invalid('A command working directory must be absolute.');
      }
      if (server.env) {
        for (const [key, value] of Object.entries(server.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            invalid('A command environment key is invalid.');
          server.env[key] = map(value);
        }
      }
    }
  }
  return config;
};

export const parseConfig = (
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
  format: ConfigFormat = 'json',
): GatewayConfig => {
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) invalid(CONFIG_TOO_LARGE);
  let value: unknown;
  try {
    value = parseConfigDocument(text, format);
  } catch {
    invalid();
  }
  return validateConfig(value, environment);
};

/**
 * Read-only dry run for the raw editor: one fixed, sanitized problem with its source range
 * where one can be located. No save, process, network, registration, or log side effect.
 */
export const previewConfig = (
  text: string,
  environment: NodeJS.ProcessEnv = process.env,
  format: ConfigFormat = 'json',
): ConfigIssue | null => {
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return { message: CONFIG_TOO_LARGE };
  const parsed = parseConfigTree(text, format);
  if (!parsed.ok) return parsed.issue;
  const value = getNodeValue(parsed.root);
  try {
    validateConfig(value, environment);
    return null;
  } catch (error) {
    // Structural failures get a range; field rules already carry fixed, actionable text.
    if (!(error instanceof GatewayError)) throw error;
    const structural = structureIssue(value);
    if (!structural) return { message: error.message };
    const range = configRange(parsed.root, structural.path, structural.key === true);
    return range
      ? { message: structural.message, offset: range.offset, length: range.length }
      : { message: structural.message };
  }
};

/** One route's accepted credential. Callers only pass a found own server entry. */
export const effectiveServerToken = (
  gateway: GatewayConfig['gateway'],
  server: StdioServerConfig | HttpServerConfig,
): string => server.token ?? gateway.token;

export const serverFingerprint = (server: StdioServerConfig | HttpServerConfig): string => {
  const sorted = (values: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify(
    isHttpServer(server)
      ? {
          url: new URL(server.url).href,
          // parseConfig already lowercased the header names.
          headers: sorted(server.headers),
          legacyProtocol: server.legacyProtocol === true,
          token: server.token,
        }
      : {
          command: server.command,
          args: server.args ?? [],
          env: sorted(server.env),
          cwd: server.cwd,
          legacyProtocol: server.legacyProtocol === true,
          token: server.token,
        },
  );
};

const newConfigText = (): string => {
  return `${JSON.stringify(
    {
      gateway: {
        host: '127.0.0.1',
        port: 8765,
        token: randomBytes(32).toString('hex'),
        autoStart: false,
        launchAtLogin: false,
      },
      mcpServers: {},
    },
    null,
    2,
  )}\n`;
};
const assertPlainDirectory = (stat: Stats): void => {
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw failure('UnsafeFile', 'Configuration paths must not contain symlinks.');
};

const safeParent = async (path: string): Promise<void> => {
  const parent = dirname(path);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    assertPlainDirectory(await fs.lstat(current));
  }
  const stat = await fs.lstat(parent);
  if ((stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw failure(
      'UnsafeFile',
      'The configuration directory must be owned by this user and not writable by others.',
    );
};

export const ensureParent = async (path: string): Promise<void> => {
  const parent = dirname(path);
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split('/').filter(Boolean)) {
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
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stat = await fs.lstat(current);
    }
    assertPlainDirectory(stat);
  }
  await safeParent(path);
};

export interface ConfigDocument {
  text: string;
  revision: string;
}
const revisionOf = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

const guarded = async <A>(work: () => Promise<A>): Promise<A> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw failure('ConfigIO', 'Configuration file access failed.');
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
      'UnsafeFile',
      'The configuration must be an owner-only regular file with no hard links.',
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
    this.jsonPath = this.selectedPath.endsWith('.jsonc')
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
    if (this.selectionRefused) throw failure('AmbiguousConfig', AMBIGUOUS_CONFIG);
    const alternate = this.path === this.jsonPath ? this.jsoncPath : this.jsonPath;
    if (await this.exists(alternate)) {
      if (await this.exists(this.path)) throw failure('AmbiguousConfig', AMBIGUOUS_CONFIG);
      throw failure('ConfigIO', 'The configuration filename changed; reopen the app to select it.');
    }
  }

  read(): Promise<ConfigDocument> {
    return guarded(async () => {
      await safeParent(this.path);
      await this.checkSelection();
      const entry = await fs.lstat(this.path);
      if (entry.isSymbolicLink())
        throw failure('UnsafeFile', 'Symlinked configuration files are refused.');
      const handle = await fs.open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat();
        safeFile(before);
        if (before.ino !== entry.ino || before.dev !== entry.dev)
          throw failure('UnsafeFile', 'The configuration file changed during access.');
        if (before.size > MAX_CONFIG_BYTES) throw failure('InvalidConfig', CONFIG_TOO_LARGE);
        const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await handle.stat();
        if (length > MAX_CONFIG_BYTES) throw failure('InvalidConfig', CONFIG_TOO_LARGE);
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw failure('ConfigIO', 'The configuration changed during access.');
        const bytes = buffer.subarray(0, length);
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw failure('InvalidConfig', 'Configuration must contain valid UTF-8.');
        }
        await this.checkSelection();
        return { text, revision: revisionOf(bytes) };
      } finally {
        await handle.close();
      }
    });
  }

  // A lock left behind by a process that died is recognizable: it names its pid.
  // Only a lock whose owner is gone (or whose pid was never written and that is
  // old) is removed; a live or unknown owner keeps the refusal.
  private async lockIsStale(lockPath: string): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(
        lockPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      return false;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) return false;
      const pid = Number((await handle.readFile('utf8')).trim());
      if (!Number.isSafeInteger(pid) || pid <= 0)
        return Date.now() - stat.mtimeMs > STALE_UNOWNED_LOCK_MS;
      if (pid === process.pid) return false;
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    } finally {
      await handle.close();
    }
  }

  private async acquireLock(lockPath: string): Promise<fs.FileHandle> {
    for (let attempt = 0; ; attempt++) {
      let lock: fs.FileHandle;
      try {
        lock = await fs.open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (attempt === 0 && (await this.lockIsStale(lockPath))) {
          await fs.unlink(lockPath).catch((failed) => {
            if (!missing(failed)) throw failed;
          });
          continue;
        }
        throw failure(
          'ConfigLocked',
          'Configuration is locked by another running writer. If mcp.json.lock beside the configuration is stale, quit every app instance and confirm no writer is active before removing it and retrying.',
        );
      }
      try {
        await lock.writeFile(String(process.pid));
      } catch (error) {
        await lock.close();
        await fs.unlink(lockPath).catch(() => undefined);
        throw error;
      }
      return lock;
    }
  }

  private async locked<A>(work: () => Promise<A>): Promise<A> {
    await safeParent(this.path);
    const lockPath = `${this.jsonPath}.lock`;
    const lock = await this.acquireLock(lockPath);
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
        await file.writeFile(text, 'utf8');
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
          throw failure('AmbiguousConfig', AMBIGUOUS_CONFIG);
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
          throw failure('StaleRevision', 'Configuration changed on disk; reload before saving.');
        if (current.text === text) return current;
        await this.checkSelection();
        await this.replace(text, false);
        return { text, revision: revisionOf(text) };
      }),
    );
  }
}
