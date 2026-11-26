import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  format as formatText,
  getNodeValue,
  type JSONPath,
  modify,
  type Node,
  type ParseError,
  parseTree,
  SyntaxKind,
} from 'jsonc-parser';

export type ConfigFormat = 'json' | 'jsonc';
export const configFormat = (path: string): ConfigFormat =>
  path.endsWith('.jsonc') ? 'jsonc' : 'json';

/** Shared with the raw editor: main and the renderer enforce the same file limit. */
export const MAX_CONFIG_BYTES = 1024 * 1024;
export const CONFIG_TOO_LARGE = 'Configuration exceeds the size limit.';
/** A server name is one URL path segment; the renderer checks it before editing a draft. */
export const SAFE_NAME =
  /^(?!(?:constructor|toString|toLocaleString|valueOf|hasOwnProperty|isPrototypeOf|propertyIsEnumerable|__proto__|__defineGetter__|__defineSetter__|__lookupGetter__|__lookupSetter__)$)[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const SENSITIVE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'NODE_EXTRA_CA_CERTS',
  'GIT_SSH_COMMAND',
  'BASH_ENV',
  'ZDOTDIR',
]);

export const sensitiveEnvOverrides = (
  env: Readonly<Record<string, string>> | undefined,
): string[] => {
  if (!env) return [];
  return Object.keys(env).filter((key) => SENSITIVE_ENV_KEYS.has(key.toUpperCase()));
};

const ENV_REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;
const LITERAL_TOKEN_PATTERN = /^[\x21-\x7e]{32,512}$/;
const SECRET_KEY_NAME_PATTERN = /(?:key|token|secret|password|authorization)/i;
const WELL_KNOWN_SECRET_PREFIX_PATTERN =
  /(?:^|[\s=:])(?:Bearer\s+\S{8,}|Basic\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{16,})/i;
const URL_SECRET_QUERY_PATTERN =
  /[?&](?:token|api_key|apikey|key|secret|access_token|password)=([^&#\s]+)/i;
const ARG_SECRET_PATTERN =
  /(?:^|--?)(?:[a-z0-9_-]*?(?:api[-_]?key|token|secret|password|authorization))(?:=([^\s]+))?$/i;

const isUnexpandedLiteral = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && !ENV_REFERENCE_PATTERN.test(value);

const isLiteralTokenSlot = (slot: unknown): boolean =>
  isRecord(slot) &&
  slot.tokenRef === undefined &&
  isUnexpandedLiteral(slot.token) &&
  LITERAL_TOKEN_PATTERN.test(slot.token);

const hasLiteralSecretValue = (key: string, value: unknown): boolean => {
  if (!isUnexpandedLiteral(value)) return false;
  if (WELL_KNOWN_SECRET_PREFIX_PATTERN.test(value)) return true;
  return SECRET_KEY_NAME_PATTERN.test(key) && value.trim().length >= 8;
};

const hasUrlLiteralSecret = (url: unknown): boolean => {
  if (!isUnexpandedLiteral(url)) return false;
  const match = URL_SECRET_QUERY_PATTERN.exec(url);
  if (!match?.[1]) return false;
  return !ENV_REFERENCE_PATTERN.test(match[1]);
};

const hasArgsLiteralSecret = (args: unknown): boolean => {
  if (!Array.isArray(args)) return false;
  for (let i = 0; i < args.length; i++) {
    const item = args[i];
    if (typeof item !== 'string') continue;
    if (
      isUnexpandedLiteral(item) &&
      (WELL_KNOWN_SECRET_PREFIX_PATTERN.test(item) || hasUrlLiteralSecret(item))
    ) {
      return true;
    }
    const match = ARG_SECRET_PATTERN.exec(item);
    if (match) {
      if (match[1] !== undefined) {
        if (isUnexpandedLiteral(match[1])) return true;
      } else {
        const next = args[i + 1];
        if (isUnexpandedLiteral(next) && !next.startsWith('-')) return true;
      }
    }
  }
  return false;
};

/** Inspects unexpanded configuration text or a pre-parsed syntax tree for literal tokens and embedded secret values. */
export const hasUnmigratedSecretLiterals = (
  source: string | Node,
  format: ConfigFormat = 'json',
): { gateway: boolean; servers: string[]; warnings: string[] } => {
  let root: Node | undefined;
  if (typeof source === 'string') {
    const parsed = parseConfigTree(source, format);
    root = parsed.ok ? parsed.root : undefined;
  } else {
    root = source;
  }
  const value: unknown = root ? getNodeValue(root) : undefined;
  if (!isRecord(value) || !isRecord(value.mcpServers))
    return { gateway: false, servers: [], warnings: [] };
  const gateway = isLiteralTokenSlot(value.gateway);
  const servers: string[] = [];
  const warnings: string[] = [];
  if (gateway) warnings.push('gateway.token');
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (!isRecord(server)) continue;
    let flagged = false;
    if (isLiteralTokenSlot(server)) {
      flagged = true;
      warnings.push(`${name}.token`);
    }
    if (isRecord(server.env)) {
      for (const [key, envVal] of Object.entries(server.env)) {
        if (hasLiteralSecretValue(key, envVal)) {
          flagged = true;
          warnings.push(`${name}.env.${key}`);
        }
      }
    }
    if (isRecord(server.headers)) {
      for (const [key, headerVal] of Object.entries(server.headers)) {
        if (hasLiteralSecretValue(key, headerVal)) {
          flagged = true;
          warnings.push(`${name}.headers.${key}`);
        }
      }
    }
    if (hasArgsLiteralSecret(server.args)) {
      flagged = true;
      warnings.push(`${name}.args`);
    }
    if (hasUrlLiteralSecret(server.url)) {
      flagged = true;
      warnings.push(`${name}.url`);
    }
    if (flagged) servers.push(name);
  }
  return { gateway, servers, warnings };
};

// Fixed messages only: parser diagnostics must not echo configuration credentials.
const syntaxError = (): Error =>
  new Error('Configuration syntax is invalid or contains duplicate keys.');

const SYNTAX_MESSAGE = 'Configuration syntax is invalid.';
const DUPLICATE_MESSAGE = 'Duplicate property names are not allowed.';
const DEPTH_MESSAGE = 'Configuration is nested too deeply.';
// The schema nests four levels; the parser recurses per level and overflows on unbounded depth.
const MAX_CONFIG_DEPTH = 64;

interface ConfigSourceRange {
  offset: number;
  length: number;
}

/** A fixed problem message with a source range when the parser can locate one. */
export interface ConfigIssue {
  message: string;
  offset?: number;
  length?: number;
}

interface ConfigTextIssue extends ConfigSourceRange {
  message: string;
}

type ConfigTree = { ok: true; root: Node } | { ok: false; issue: ConfigTextIssue };

const duplicateKey = (node: Node): Node | undefined => {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0];
      if (!key) continue;
      if (keys.has(key.value)) return key;
      keys.add(key.value);
    }
  }
  for (const child of node.children ?? []) {
    const duplicate = duplicateKey(child);
    if (duplicate) return duplicate;
  }
  return undefined;
};

/** The first bracket nested beyond the limit, found without recursion. */
const tooDeep = (text: string): ConfigTextIssue | undefined => {
  const scanner = createScanner(text, true);
  const open: SyntaxKind[] = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      if (open.push(token) > MAX_CONFIG_DEPTH)
        return { message: DEPTH_MESSAGE, offset: scanner.getTokenOffset(), length: 1 };
    } else if (
      // The parser skips a mismatched closer without leaving its level, so only a match pops.
      (token === SyntaxKind.CloseBraceToken && open.at(-1) === SyntaxKind.OpenBraceToken) ||
      (token === SyntaxKind.CloseBracketToken && open.at(-1) === SyntaxKind.OpenBracketToken)
    )
      open.pop();
  }
  return undefined;
};

/** Parses once and reports the first depth, syntax or duplicate-key problem with its range. */
export const parseConfigTree = (text: string, format: ConfigFormat = 'json'): ConfigTree => {
  const deep = tooDeep(text);
  if (deep) return { ok: false, issue: deep };
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    disallowComments: format === 'json',
    allowTrailingComma: format === 'jsonc',
    allowEmptyContent: false,
  });
  const error = errors[0];
  if (error)
    return {
      ok: false,
      issue: { message: SYNTAX_MESSAGE, offset: error.offset, length: error.length },
    };
  if (!root) return { ok: false, issue: { message: SYNTAX_MESSAGE, offset: 0, length: 0 } };
  const duplicate = duplicateKey(root);
  if (duplicate)
    return {
      ok: false,
      issue: { message: DUPLICATE_MESSAGE, offset: duplicate.offset, length: duplicate.length },
    };
  return { ok: true, root };
};

/** Source range of the value at `path`, or of its property name when `key` is set. */
export const configRange = (
  root: Node,
  path: JSONPath,
  key = false,
): ConfigSourceRange | undefined => {
  const node = findNodeAtLocation(root, path);
  if (!node) return undefined;
  if (key && node.parent?.type === 'property') {
    const name = node.parent.children?.[0];
    return name ? { offset: name.offset, length: name.length } : undefined;
  }
  return { offset: node.offset, length: node.length };
};

const checkedTree = (text: string, format: ConfigFormat): Node => {
  const parsed = parseConfigTree(text, format);
  if (!parsed.ok) throw syntaxError();
  return parsed.root;
};

/** Two-space indentation, the document's existing newline, and preserved comments and lexemes. */
export const formatConfigDocument = (text: string, format: ConfigFormat = 'json'): string => {
  checkedTree(text, format);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return applyEdits(text, formatText(text, undefined, { tabSize: 2, insertSpaces: true, eol }));
};

export const parseConfigDocument = (
  source: string | Node,
  format: ConfigFormat = 'json',
): unknown => {
  return getNodeValue(typeof source === 'string' ? checkedTree(source, format) : source);
};

/** Plain-object check shared with the runtime schemas. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

interface Rename {
  path: JSONPath;
  from: string;
  to: string;
}

/** Change only differing leaves. Retained blocks and source environment references stay intact. */
export const editConfigDocument = (
  text: string,
  next: unknown,
  format: ConfigFormat = 'json',
  rename?: Rename,
): string => {
  let root = checkedTree(text, format);
  if (rename && rename.from !== rename.to) {
    const source = findNodeAtLocation(root, [...rename.path, rename.from]);
    if (!source?.parent || findNodeAtLocation(root, [...rename.path, rename.to]))
      throw syntaxError();
    const key = source.parent.children?.[0];
    if (!key) throw syntaxError();
    text = applyEdits(text, [
      { offset: key.offset, length: key.length, content: JSON.stringify(rename.to) },
    ]);
    root = checkedTree(text, format);
  }
  const original: unknown = getNodeValue(root);
  // No formatting pass: jsonc-parser's edit ranges include neighboring comments/lines.
  // Direct value edits and unformatted structural edits leave retained trivia byte-identical.
  const change = (path: JSONPath, before: unknown, after: unknown): void => {
    if (Object.is(before, after)) return;
    if (isRecord(before) && isRecord(after)) {
      for (const key of Object.keys(before)) {
        if (!Object.hasOwn(after, key)) set([...path, key], undefined);
      }
      for (const [key, value] of Object.entries(after))
        change([...path, key], Object.hasOwn(before, key) ? before[key] : undefined, value);
    } else if (Array.isArray(before) && Array.isArray(after)) {
      for (let index = before.length - 1; index >= after.length; index--)
        set([...path, index], undefined);
      for (let index = 0; index < after.length; index++)
        change([...path, index], before[index], after[index]);
    } else set(path, after);
  };
  const set = (path: JSONPath, value: unknown): void => {
    const edits = modify(text, path, value, {});
    text = applyEdits(text, edits);
    if (value === undefined && edits.length > 0) {
      // A line left holding only indentation would remain as a blank line; remove it as well.
      const at = edits[0]?.offset ?? 0;
      const lineStart = text.lastIndexOf('\n', at - 1) + 1;
      const lineEnd = text.indexOf('\n', at);
      if (lineEnd >= 0 && /^[ \t]*\r?$/.test(text.slice(lineStart, lineEnd)))
        text = text.slice(0, lineStart) + text.slice(lineEnd + 1);
    }
  };
  change([], original, next);
  checkedTree(text, format);
  return text;
};
