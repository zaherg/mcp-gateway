import { describe, expect, test } from "bun:test";
import { newConfigText, parseConfig } from "../../src/core/config";
import { editConfigDocument, parseConfigDocument } from "../../src/shared/config-document";
import type { GatewayConfig } from "../../src/shared/types";
import { jsoncFixture } from "../fixtures/config-document";

describe("configuration documents", () => {
  test("strict JSON remains the default; JSONC permits only checked comments/trailing commas", () => {
    const config = parseConfig(newConfigText());
    const text = jsoncFixture(config);
    expect(parseConfig(text, {}, "jsonc")).toEqual(config);
    expect(() => parseConfig(text)).toThrow();
    for (const format of ["json", "jsonc"] as const) {
      for (const invalid of [
        "",
        "{",
        '{"a":1',
        '{"a":1} true',
        '{"a":1,,}',
        '{"a":}',
        '{"a":1,"\\u0061":2}',
        '{"nested":{"x":1,"x":2}}',
        '{"a":1} /* unfinished',
        '{"x":"unterminated}',
        '{"a":01}',
      ]) {
        expect(() => parseConfigDocument(invalid, format)).toThrow();
        expect(() => parseConfig(invalid, {}, format)).toThrow();
      }
      expect(() => parseConfig('{"gateway":{},"mcpServers":{},"SECRET":1}', {}, format)).toThrow();
    }
    expect(() => parseConfigDocument('{"a":1,}', "json")).toThrow();
    expect(() => parseConfigDocument('{/*comment*/"a":1}', "json")).toThrow();
    expect(parseConfigDocument('{"s":"// not a comment /* either */",}', "jsonc")).toEqual({
      s: "// not a comment /* either */",
    });
  });

  test("leaf edits, rename and byte-exact no-ops preserve retained trivia and env sources", () => {
    const config: GatewayConfig = {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Preserve a source environment reference, not an expanded secret.
      gateway: { host: "127.0.0.1", port: 8765, token: "${DOCUMENT_TOKEN}" },
      mcpServers: {
        remote: {
          url: "https://synthetic.example/mcp",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Preserve a source environment reference, not an expanded secret.
          headers: { Authorization: "Bearer ${DOCUMENT_TOKEN}" },
        },
      },
    };
    for (const format of ["json", "jsonc"] as const) {
      const text = format === "jsonc" ? jsoncFixture(config) : `  ${JSON.stringify(config)}\n\n`;
      expect(editConfigDocument(text, structuredClone(config), format)).toBe(text);
      const next = structuredClone(config);
      next.gateway.port = 9876;
      expect(editConfigDocument(text, next, format)).toBe(text.replace("8765", "9876"));
      const remote = next.mcpServers.remote;
      if (!remote) throw new Error("Missing fixture server");
      next.mcpServers.renamed = remote;
      delete next.mcpServers.remote;
      const renamed = editConfigDocument(text, next, format, {
        path: ["mcpServers"],
        from: "remote",
        to: "renamed",
      });
      expect(renamed).toBe(text.replace("8765", "9876").replace('"remote":', '"renamed":'));
      expect(
        parseConfig(
          renamed,
          { DOCUMENT_TOKEN: "synthetic-secret-0123456789abcdef0123456789" },
          format,
        ).gateway.port,
      ).toBe(9876);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Preserve a source environment reference, not an expanded secret.
      expect(renamed).toContain("${DOCUMENT_TOKEN}");
    }
  });

  test("add/delete/array edits preserve comments on every retained value", () => {
    const text =
      '{\n // first\n "a":1,\n /* retained block */ "b":{"x":2, /* keep y */ "y":3},\n "args":["one", /* keep second */ "two", /* delete value */ "three",],\n // last retained\n "z":true,\n}\n';
    const next = { b: { y: 4 }, args: ["one", "two"], z: true, added: { value: 1 } };
    const edited = editConfigDocument(text, next, "jsonc");
    expect(parseConfigDocument(edited, "jsonc")).toEqual(next);
    for (const comment of [
      "/* retained block */",
      "/* keep y */",
      "/* keep second */",
      "// last retained",
    ])
      expect(edited).toContain(comment);
    expect(editConfigDocument(edited, next, "jsonc")).toBe(edited);
    expect(editConfigDocument('{"a":1,"b":2}', { a: 1 }, "json")).toBe('{"a":1}');
  });
});
