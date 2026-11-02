import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  getNodeValue,
  type JSONPath,
  modify,
  type Node,
  type ParseError,
  parseTree,
  SyntaxKind,
} from "jsonc-parser";

export type ConfigFormat = "json" | "jsonc";
export const configFormat = (path: string): ConfigFormat =>
  path.endsWith(".jsonc") ? "jsonc" : "json";

// Fixed messages only: parser diagnostics must not echo configuration credentials.
export class ConfigSyntaxError extends Error {
  constructor() {
    super("Configuration syntax is invalid or contains duplicate keys.");
  }
}

function checkedTree(text: string, format: ConfigFormat): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    disallowComments: format === "json",
    allowTrailingComma: format === "jsonc",
    allowEmptyContent: false,
  });
  if (!root || errors.length) throw new ConfigSyntaxError();
  function check(node: Node): void {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key: string = property.children?.[0]?.value;
        if (keys.has(key)) throw new ConfigSyntaxError();
        keys.add(key);
      }
    }
    for (const child of node.children ?? []) check(child);
  }
  check(root);
  return root;
}

export function parseConfigDocument(text: string, format: ConfigFormat = "json"): unknown {
  return getNodeValue(checkedTree(text, format));
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Change only differing leaves. Retained blocks and source environment references stay intact. */
export function editConfigDocument(
  text: string,
  next: unknown,
  format: ConfigFormat = "json",
  rename?: { path: JSONPath; from: string; to: string },
): string {
  let root = checkedTree(text, format);
  if (rename && rename.from !== rename.to) {
    const parent = findNodeAtLocation(root, rename.path);
    const source = findNodeAtLocation(root, [...rename.path, rename.from]);
    if (!parent || !source?.parent || findNodeAtLocation(root, [...rename.path, rename.to]))
      throw new ConfigSyntaxError();
    const key = source.parent.children?.[0];
    if (!key) throw new ConfigSyntaxError();
    text = applyEdits(text, [
      { offset: key.offset, length: key.length, content: JSON.stringify(rename.to) },
    ]);
    root = checkedTree(text, format);
  }
  const original: unknown = getNodeValue(root);
  // No formatting pass: jsonc-parser's edit ranges include neighboring comments/lines.
  // Direct value edits and unformatted structural edits leave retained trivia byte-identical.
  function change(path: JSONPath, before: unknown, after: unknown): void {
    if (Object.is(before, after)) return;
    if (record(before) && record(after)) {
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
  }
  function set(path: JSONPath, value: unknown): void {
    if (value !== undefined) {
      text = applyEdits(text, modify(text, path, value, {}));
      return;
    }
    const tree = checkedTree(text, format);
    const valueNode = findNodeAtLocation(tree, path);
    if (!valueNode) return;
    const node = valueNode.parent?.type === "property" ? valueNode.parent : valueNode;
    const parent = node.parent;
    if (!parent?.children) throw new ConfigSyntaxError();
    const index = parent.children.indexOf(node);
    const scanner = createScanner(text, true);
    const end = node.offset + node.length;
    // Delete syntax, not the trivia belonging to retained neighboring values.
    scanner.setPosition(end);
    let comma = scanner.scan() === SyntaxKind.CommaToken ? scanner.getTokenOffset() : undefined;
    if (comma === undefined && index > 0) {
      const previous = parent.children[index - 1];
      if (!previous) throw new ConfigSyntaxError();
      scanner.setPosition(previous.offset + previous.length);
      if (scanner.scan() === SyntaxKind.CommaToken) comma = scanner.getTokenOffset();
    }
    text = applyEdits(text, [
      { offset: node.offset, length: node.length, content: "" },
      ...(comma === undefined ? [] : [{ offset: comma, length: 1, content: "" }]),
    ]);
  }
  change([], original, next);
  checkedTree(text, format);
  return text;
}
