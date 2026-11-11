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

// Fixed messages only: parser diagnostics must not echo configuration credentials.
const syntaxError = (): Error =>
  new Error('Configuration syntax is invalid or contains duplicate keys.');

const SYNTAX_MESSAGE = 'Configuration syntax is invalid.';
const DUPLICATE_MESSAGE = 'Duplicate property names are not allowed.';
const DEPTH_MESSAGE = 'Configuration is nested too deeply.';
// The schema nests four levels; the parser recurses per level and overflows on unbounded depth.
const MAX_CONFIG_DEPTH = 64;

export interface ConfigSourceRange {
  offset: number;
  length: number;
}

/** A fixed problem message with a source range when the parser can locate one. */
export interface ConfigIssue {
  message: string;
  offset?: number;
  length?: number;
}

export interface ConfigTextIssue extends ConfigSourceRange {
  message: string;
}

export type ConfigTree = { ok: true; root: Node } | { ok: false; issue: ConfigTextIssue };

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

export const parseConfigDocument = (text: string, format: ConfigFormat = 'json'): unknown => {
  return getNodeValue(checkedTree(text, format));
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
      for (const [key, value] of Object.entries(after)) change([...path, key], before[key], value);
    } else if (Array.isArray(before) && Array.isArray(after)) {
      for (let index = before.length - 1; index >= after.length; index--)
        set([...path, index], undefined);
      for (let index = 0; index < after.length; index++)
        change([...path, index], before[index], after[index]);
    } else set(path, after);
  };
  const set = (path: JSONPath, value: unknown): void => {
    if (value !== undefined) {
      text = applyEdits(text, modify(text, path, value, {}));
      return;
    }
    const tree = checkedTree(text, format);
    const valueNode = findNodeAtLocation(tree, path);
    if (!valueNode) return;
    const node = valueNode.parent?.type === 'property' ? valueNode.parent : valueNode;
    const parent = node.parent;
    if (!parent?.children) throw syntaxError();
    const index = parent.children.indexOf(node);
    const scanner = createScanner(text, true);
    const end = node.offset + node.length;
    // Delete syntax, not the trivia belonging to retained neighboring values.
    scanner.setPosition(end);
    let comma = scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() : undefined;
    if (comma === undefined && index > 0) {
      const previous = parent.children[index - 1];
      if (!previous) throw syntaxError();
      scanner.setPosition(previous.offset + previous.length);
      if (scanner.scan() === SyntaxKind.CommaToken) comma = scanner.getTokenOffset();
    }
    text = applyEdits(text, [
      { offset: node.offset, length: node.length, content: '' },
      ...(comma === undefined ? [] : [{ offset: comma, length: 1, content: '' }]),
    ]);
  };
  change([], original, next);
  checkedTree(text, format);
  return text;
};
