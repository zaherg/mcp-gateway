import { Redacted, Schema } from 'effect';

import {
  type ConfigFormat,
  isRecord,
  parseConfigDocument,
} from '@mcp-gateway/shared/config-document';
import type { ConfigFile, HttpServerConfig, StdioServerConfig } from '@mcp-gateway/shared/types';

export const KeyValueRowSchema = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  value: Schema.Redacted(Schema.String),
  secret: Schema.Boolean,
});

export type KeyValueRow = typeof KeyValueRowSchema.Type;

export const ServerEditorStateSchema = Schema.Struct({
  original: Schema.NullOr(Schema.String),
  name: Schema.String,
  type: Schema.Literals(['stdio', 'http']),
  command: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.Array(KeyValueRowSchema),
  cwd: Schema.String,
  url: Schema.String,
  headers: Schema.Array(KeyValueRowSchema),
  disabled: Schema.Boolean,
  legacyProtocol: Schema.Boolean,
  /** `null` inherits the global key unless `tokenRef` is set; any redacted string is this server's own key. */
  token: Schema.NullOr(Schema.Redacted(Schema.String)),
  /** This server's key is in Keychain; carried unchanged until a new key replaces it. */
  tokenRef: Schema.NullOr(Schema.String),
});

export type ServerEditorState = typeof ServerEditorStateSchema.Type;

export const DocumentSchema = Schema.Struct({
  text: Schema.Redacted(Schema.String),
  revision: Schema.String,
  dirty: Schema.Boolean,
});

export type DocumentRedacted = typeof DocumentSchema.Type;

let rowSequence = 0;

export const isDefaultSecretRow = (key: string, value: string): boolean => {
  if (!key && !value) return false;
  if (/\$\{[^}]+\}/.test(value)) return false;
  return (
    /^(authorization|x-api-key|api-key)$/i.test(key) ||
    /(-api-key|token|secret|password|key)$/i.test(key)
  );
};

export const createKeyValueRow = (
  key = '',
  value = '',
  secret = isDefaultSecretRow(key, value),
): KeyValueRow => ({
  id: `kv-${++rowSequence}`,
  key,
  value: Redacted.make(value),
  secret,
});

export const recordToKeyValueRows = (record: Record<string, string> | undefined): KeyValueRow[] => {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => createKeyValueRow(key, value));
};

const FORBIDDEN_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const keyValueRowsToRecord = (
  rows: readonly KeyValueRow[],
  message: string,
): Record<string, string> => {
  const result = Object.create(null) as Record<string, string>;
  for (const row of rows) {
    const key = row.key.trim();
    const rawValue = Redacted.value(row.value);
    if (key.length === 0) {
      if (rawValue.length > 0) throw new Error(message);
      continue;
    }
    if (FORBIDDEN_MAP_KEYS.has(key) || Object.hasOwn(result, key)) {
      throw new Error(message);
    }
    result[key] = rawValue;
  }
  return { ...result };
};

export const hasInvalidKeyValueRows = (rows: readonly KeyValueRow[]): boolean => {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    const rawValue = Redacted.value(row.value);
    if (key.length === 0) {
      if (rawValue.length > 0) return true;
      continue;
    }
    if (FORBIDDEN_MAP_KEYS.has(key) || seen.has(key)) return true;
    seen.add(key);
  }
  return false;
};

export const rowsToEnvPreview = (rows: readonly KeyValueRow[]): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key && !FORBIDDEN_MAP_KEYS.has(key)) env[key] = Redacted.value(row.value);
  }
  return env;
};

const stringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) &&
  !Object.hasOwn(value, '__proto__') &&
  Object.values(value).every((item) => typeof item === 'string');

/** Parses an editor JSON field that must hold an object of string values. */
export const parseStringMap = (text: string, message: string): Record<string, string> => {
  const value: unknown = JSON.parse(text || '{}');
  if (!stringMap(value)) throw new Error(message);
  return value;
};

const isBackend = (value: unknown): value is StdioServerConfig | HttpServerConfig => {
  if (
    !isRecord(value) ||
    (value.disabled !== undefined && typeof value.disabled !== 'boolean') ||
    (value.legacyProtocol !== undefined && typeof value.legacyProtocol !== 'boolean') ||
    (value.token !== undefined && typeof value.token !== 'string') ||
    (value.tokenRef !== undefined && typeof value.tokenRef !== 'string')
  ) {
    return false;
  }
  if ('url' in value) {
    return (
      typeof value.url === 'string' && (value.headers === undefined || stringMap(value.headers))
    );
  }
  return (
    typeof value.command === 'string' &&
    (value.args === undefined ||
      (Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string'))) &&
    (value.env === undefined || stringMap(value.env)) &&
    (value.cwd === undefined || typeof value.cwd === 'string')
  );
};

const isFormConfig = (value: unknown): value is ConfigFile => {
  if (!isRecord(value) || !isRecord(value.gateway) || !isRecord(value.mcpServers)) return false;
  const { gateway, mcpServers } = value;
  return (
    typeof gateway.host === 'string' &&
    typeof gateway.port === 'number' &&
    // Exactly one key form; native validation reports which rule failed.
    (typeof gateway.token === 'string') !== (typeof gateway.tokenRef === 'string') &&
    (gateway.token === undefined || typeof gateway.token === 'string') &&
    (gateway.tokenRef === undefined || typeof gateway.tokenRef === 'string') &&
    (gateway.autoStart === undefined || typeof gateway.autoStart === 'boolean') &&
    (gateway.launchAtLogin === undefined || typeof gateway.launchAtLogin === 'boolean') &&
    (gateway.keepAwake === undefined || typeof gateway.keepAwake === 'boolean') &&
    (gateway.allowedPeers === undefined ||
      (Array.isArray(gateway.allowedPeers) &&
        gateway.allowedPeers.every((item) => typeof item === 'string'))) &&
    Object.values(mcpServers).every(isBackend)
  );
};

// This guard is for rendering only. Native validation remains authoritative on every save.
export const formConfig = (text: string, format: ConfigFormat): ConfigFile | null => {
  try {
    const value = parseConfigDocument(text, format);
    // The parsed document keeps every field, including unknown ones for native rejection.
    return isFormConfig(value) ? value : null;
  } catch {
    return null;
  }
};

export const emptyEditor = (): ServerEditorState => ({
  original: null,
  name: '',
  type: 'stdio',
  command: '',
  args: [],
  env: [],
  cwd: '',
  url: '',
  headers: [],
  disabled: false,
  legacyProtocol: false,
  token: null,
  tokenRef: null,
});

/** The macOS Bear preset fields; a name the user already typed is kept. */
export const bearPreset = (name = '') => ({
  name: name || 'bear',
  command: '/Applications/Bear.app/Contents/MacOS/bearcli',
  args: ['mcp-server'],
});

export const editorFromServer = (
  name: string,
  server: StdioServerConfig | HttpServerConfig,
): ServerEditorState => {
  const base: ServerEditorState = {
    ...emptyEditor(),
    original: name,
    name,
    disabled: server.disabled ?? false,
    legacyProtocol: server.legacyProtocol ?? false,
    // Keep the raw reference text; only main expands it on save.
    token: server.token !== undefined ? Redacted.make(server.token) : null,
    tokenRef: server.tokenRef ?? null,
  };
  if ('url' in server) {
    return {
      ...base,
      type: 'http',
      url: server.url,
      headers: recordToKeyValueRows(server.headers),
    };
  }
  return {
    ...base,
    command: server.command,
    args: [...(server.args ?? [])],
    env: recordToKeyValueRows(server.env),
    cwd: server.cwd ?? '',
  };
};
