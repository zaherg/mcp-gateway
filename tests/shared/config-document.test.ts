import { describe, expect, test } from 'bun:test';

import {
  configFormat,
  configRange,
  editConfigDocument,
  formatConfigDocument,
  hasUnmigratedSecretLiterals,
  isRecord,
  parseConfigDocument,
  parseConfigTree,
  SAFE_NAME,
  sensitiveEnvOverrides,
} from '@mcp-gateway/shared/config-document';

const VALID_TOKEN_32 = 'a'.repeat(32);
const VALID_TOKEN_512 = 'z'.repeat(512);
const SYNTAX_OR_DUPLICATE_ERROR = 'Configuration syntax is invalid or contains duplicate keys.';
const envRef = (name: string) => `\${${name}}`;

describe('configFormat', () => {
  test('returns jsonc only for .jsonc paths and json otherwise', () => {
    expect(configFormat('/path/mcp.json')).toBe('json');
    expect(configFormat('/path/mcp.jsonc')).toBe('jsonc');
    expect(configFormat('/path/mcp.JSONC')).toBe('json');
    expect(configFormat('/path/config.txt')).toBe('json');
  });
});

describe('isRecord', () => {
  test('returns true only for non-null, non-array objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('str')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

describe('SAFE_NAME', () => {
  test('accepts valid 1..64 character names starting with alphanumeric', () => {
    for (const name of ['a', '0', 'bear-mcp_1', 'A'.repeat(64)]) {
      expect(SAFE_NAME.test(name)).toBe(true);
    }
  });

  test('rejects empty, overly long, bad leading characters, and path separators', () => {
    for (const name of ['', 'A'.repeat(65), '-lead', '_lead', 'a.b', 'a/b', 'a b']) {
      expect(SAFE_NAME.test(name)).toBe(false);
    }
  });

  test('rejects every Object.prototype property name', () => {
    const prototypeNames = [
      'constructor',
      'toString',
      'toLocaleString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      '__proto__',
      '__defineGetter__',
      '__defineSetter__',
      '__lookupGetter__',
      '__lookupSetter__',
    ];
    for (const name of prototypeNames) {
      expect(SAFE_NAME.test(name)).toBe(false);
    }
  });
});

describe('sensitiveEnvOverrides', () => {
  test('returns empty array for undefined or safe keys', () => {
    expect(sensitiveEnvOverrides(undefined)).toEqual([]);
    expect(sensitiveEnvOverrides({})).toEqual([]);
    expect(sensitiveEnvOverrides({ API_KEY: '1', NODE_ENV: 'production' })).toEqual([]);
  });

  test('detects all sensitive env keys case-insensitively while preserving key casing', () => {
    const overrides = sensitiveEnvOverrides({
      PATH: '/usr/bin',
      path: '/custom/bin',
      HOME: '/tmp/home',
      PYTHONSTARTUP: '/tmp/startup.py',
      PYTHONPATH: '/tmp/py',
      NODE_EXTRA_CA_CERTS: '/tmp/ca.pem',
      GIT_SSH_COMMAND: 'ssh -i key',
      BASH_ENV: '/tmp/env.sh',
      ZDOTDIR: '/tmp/zsh',
      SAFE_KEY: 'ok',
    });
    expect(overrides).toEqual([
      'PATH',
      'path',
      'HOME',
      'PYTHONSTARTUP',
      'PYTHONPATH',
      'NODE_EXTRA_CA_CERTS',
      'GIT_SSH_COMMAND',
      'BASH_ENV',
      'ZDOTDIR',
    ]);
  });
});

describe('hasUnmigratedSecretLiterals', () => {
  test('detects literal gateway.token and ignores tokenRef, env references, and out-of-range lengths', () => {
    const cases: Array<[Record<string, unknown>, boolean]> = [
      [{ token: VALID_TOKEN_32 }, true],
      [{ token: VALID_TOKEN_512 }, true],
      [{ token: VALID_TOKEN_32, tokenRef: 'keychain:gw' }, false],
      [{ tokenRef: 'keychain:gw' }, false],
      [{ token: envRef('GATEWAY_TOKEN') }, false],
      [{ token: 'a'.repeat(31) }, false],
      [{ token: 'a'.repeat(513) }, false],
    ];

    for (const [gateway, flagged] of cases) {
      expect(hasUnmigratedSecretLiterals(JSON.stringify({ gateway, mcpServers: {} }))).toEqual({
        gateway: flagged,
        servers: [],
        warnings: flagged ? ['gateway.token'] : [],
      });
    }
  });

  test('detects server token, secret-named env/headers, and ignores short or env-expanded values', () => {
    const config = {
      mcpServers: {
        alpha: {
          token: VALID_TOKEN_32,
          env: {
            OPENAI_API_KEY: '12345678',
            password: 'my-secret-password',
            SHORT_SECRET: '1234567',
            EXPANDED_TOKEN: envRef('MY_TOKEN'),
            BENIGN: 'normal-value-long-enough',
          },
          headers: {
            Authorization: 'custom-auth-value',
            'X-Secret': 'abcdefgh',
            'X-Expanded-Key': envRef('HEADER_KEY'),
          },
        },
        clean: {
          tokenRef: 'keychain:clean',
          token: VALID_TOKEN_32,
        },
      },
    };

    expect(hasUnmigratedSecretLiterals(JSON.stringify(config))).toEqual({
      gateway: false,
      servers: ['alpha'],
      warnings: [
        'alpha.token',
        'alpha.env.OPENAI_API_KEY',
        'alpha.env.password',
        'alpha.headers.Authorization',
        'alpha.headers.X-Secret',
      ],
    });
  });

  test('detects well-known secret prefixes even under innocuous env and header keys', () => {
    const prefixes = [
      'Bearer abcdefgh',
      'Basic abcdefgh',
      'sk-1234567890abcdef',
      'ghp_1234567890123456',
      'github_pat_1234567890123456',
      'xoxb-123456789012',
      'AIza1234567890123456',
    ];

    for (const secret of prefixes) {
      const envResult = hasUnmigratedSecretLiterals(
        JSON.stringify({ mcpServers: { s: { env: { INNOCUOUS: secret } } } }),
      );
      expect(envResult).toEqual({
        gateway: false,
        servers: ['s'],
        warnings: ['s.env.INNOCUOUS'],
      });

      const headerResult = hasUnmigratedSecretLiterals(
        JSON.stringify({ mcpServers: { s: { headers: { 'X-Custom': secret } } } }),
      );
      expect(headerResult).toEqual({
        gateway: false,
        servers: ['s'],
        warnings: ['s.headers.X-Custom'],
      });
    }
  });

  test('detects secret CLI flags, embedded URLs, and prefixes in args while ignoring flags, trailing flags, and env refs', () => {
    const cases: Array<[string[], boolean]> = [
      [['--api-key=secretval'], true],
      [['--token', 'nextArgValue'], true],
      [['-password=my-secret-password'], true],
      [['-apikey', 'my-secret-key'], true],
      [['https://example.com/mcp?token=abc'], true],
      [['sk-1234567890abcdef'], true],
      [['--token'], false],
      [['-token'], false],
      [['--token', '--verbose'], false],
      [
        ['--token', '--other', `--api-key=${envRef('ENV_VAR')}`, '--secret', envRef('ENV_SECRET')],
        false,
      ],
    ];

    for (const [args, flagged] of cases) {
      expect(hasUnmigratedSecretLiterals(JSON.stringify({ mcpServers: { s: { args } } }))).toEqual({
        gateway: false,
        servers: flagged ? ['s'] : [],
        warnings: flagged ? ['s.args'] : [],
      });
    }
  });

  test('detects URL query secrets and ignores env-referenced query values', () => {
    for (const url of [
      'https://example.com/mcp?api_key=secret',
      'https://example.com/mcp?foo=1&token=secret',
      'https://example.com/mcp?access_token=secret',
    ]) {
      expect(
        hasUnmigratedSecretLiterals(JSON.stringify({ mcpServers: { remote: { url } } })),
      ).toEqual({
        gateway: false,
        servers: ['remote'],
        warnings: ['remote.url'],
      });
    }

    expect(
      hasUnmigratedSecretLiterals(
        JSON.stringify({
          mcpServers: {
            remote: { url: `https://example.com/mcp?token=${envRef('ENV_TOKEN')}` },
            plain: { url: 'https://example.com/mcp?page=2' },
          },
        }),
      ),
    ).toEqual({ gateway: false, servers: [], warnings: [] });
  });

  test('returns identical results for raw JSONC text and a pre-parsed Node', () => {
    const jsonc = `{
      // gateway section
      "gateway": { "token": "${VALID_TOKEN_32}" },
      "mcpServers": {
        "api": {
          "url": "https://example.com/mcp?token=literal123",
          "headers": { "X-Custom": "Bearer abcdefgh", },
        },
      },
    }`;
    const parsed = parseConfigTree(jsonc, 'jsonc');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Expected JSONC parse to succeed');

    const fromText = hasUnmigratedSecretLiterals(jsonc, 'jsonc');
    const fromNode = hasUnmigratedSecretLiterals(parsed.root, 'jsonc');
    expect(fromText).toEqual({
      gateway: true,
      servers: ['api'],
      warnings: ['gateway.token', 'api.headers.X-Custom', 'api.url'],
    });
    expect(fromNode).toEqual(fromText);
  });

  test('returns empty result on invalid JSON or missing mcpServers', () => {
    expect(hasUnmigratedSecretLiterals('{ invalid')).toEqual({
      gateway: false,
      servers: [],
      warnings: [],
    });
    expect(
      hasUnmigratedSecretLiterals(JSON.stringify({ gateway: { token: VALID_TOKEN_32 } })),
    ).toEqual({
      gateway: false,
      servers: [],
      warnings: [],
    });
  });
});

describe('parseConfigTree', () => {
  test('enforces MAX_CONFIG_DEPTH of 64 for nested objects and arrays', () => {
    const nestedObjects64 = `${'{"a":'.repeat(63)}{}${'}'.repeat(63)}`;
    expect(parseConfigTree(nestedObjects64).ok).toBe(true);

    const nestedObjects65 = `${'{"a":'.repeat(64)}{}${'}'.repeat(64)}`;
    expect(parseConfigTree(nestedObjects65)).toEqual({
      ok: false,
      issue: {
        message: 'Configuration is nested too deeply.',
        offset: 64 * '{"a":'.length,
        length: 1,
      },
    });

    const nestedArrays64 = `${'['.repeat(64)}${']'.repeat(64)}`;
    expect(parseConfigTree(nestedArrays64).ok).toBe(true);

    const nestedArrays65 = `${'['.repeat(65)}${']'.repeat(65)}`;
    expect(parseConfigTree(nestedArrays65)).toEqual({
      ok: false,
      issue: {
        message: 'Configuration is nested too deeply.',
        offset: 64,
        length: 1,
      },
    });
  });

  test('handles mismatched closing tokens without underflowing depth or crashing tooDeep', () => {
    for (const mismatched of ['{"a": [}', '[{"a": 1]}', '}']) {
      const result = parseConfigTree(mismatched);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issue.message).toBe('Configuration syntax is invalid.');
      }
    }
  });

  test('rejects comments and trailing commas in json mode with exact source range', () => {
    const withLineComment = '{\n  // line comment\n  "a": 1\n}';
    expect(parseConfigTree(withLineComment, 'json')).toEqual({
      ok: false,
      issue: {
        message: 'Configuration syntax is invalid.',
        offset: withLineComment.indexOf('// line comment'),
        length: '// line comment'.length,
      },
    });

    const withBlockComment = '{\n  /* block comment */\n  "a": 1\n}';
    expect(parseConfigTree(withBlockComment, 'json')).toEqual({
      ok: false,
      issue: {
        message: 'Configuration syntax is invalid.',
        offset: withBlockComment.indexOf('/* block comment */'),
        length: '/* block comment */'.length,
      },
    });

    const withTrailingComma = '{"a": 1,}';
    expect(parseConfigTree(withTrailingComma, 'json')).toEqual({
      ok: false,
      issue: {
        message: 'Configuration syntax is invalid.',
        offset: withTrailingComma.indexOf('}'),
        length: 1,
      },
    });
  });

  test('accepts line comments, block comments, and trailing commas in jsonc mode', () => {
    const text = `{
      // line comment
      "a": 1,
      /* block comment */
      "b": [1, 2,],
    }`;
    const parsed = parseConfigTree(text, 'jsonc');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Expected JSONC parse to succeed');
    expect(parseConfigDocument(parsed.root)).toEqual({ a: 1, b: [1, 2] });
  });

  test('rejects empty and whitespace-only input', () => {
    for (const empty of ['', '   ', '\n\t  \r\n']) {
      const result = parseConfigTree(empty);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issue.message).toBe('Configuration syntax is invalid.');
      }
    }
  });

  test('detects duplicate keys at top-level and deeply nested objects with exact source range', () => {
    const topLevel = '{"a": 1, "b": 2, "a": 3}';
    expect(parseConfigTree(topLevel)).toEqual({
      ok: false,
      issue: {
        message: 'Duplicate property names are not allowed.',
        offset: topLevel.lastIndexOf('"a"'),
        length: '"a"'.length,
      },
    });

    const nested = '{"mcpServers": {"alpha": {"env": {"KEY": "1", "KEY": "2"}}}}';
    expect(parseConfigTree(nested)).toEqual({
      ok: false,
      issue: {
        message: 'Duplicate property names are not allowed.',
        offset: nested.lastIndexOf('"KEY"'),
        length: '"KEY"'.length,
      },
    });
  });
});

describe('configRange', () => {
  test('returns value range by default, property key range when key=true, falls back to value range for root or array elements, and returns undefined when missing', () => {
    const text =
      '{\n  "gateway": {\n    "port": 8080,\n    "host": "127.0.0.1",\n    "allowedPeers": ["10.0.0.0/8"]\n  }\n}';
    const parsed = parseConfigTree(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Expected parse to succeed');

    const valueRange = configRange(parsed.root, ['gateway', 'port']);
    expect(valueRange).toEqual({
      offset: text.indexOf('8080'),
      length: '8080'.length,
    });
    expect(configRange(parsed.root, ['gateway', 'port'], false)).toEqual(valueRange);

    const keyRange = configRange(parsed.root, ['gateway', 'port'], true);
    expect(keyRange).toEqual({
      offset: text.indexOf('"port"'),
      length: '"port"'.length,
    });

    expect(configRange(parsed.root, [], true)).toEqual({
      offset: 0,
      length: text.length,
    });

    expect(configRange(parsed.root, ['gateway', 'allowedPeers', 0], true)).toEqual({
      offset: text.indexOf('"10.0.0.0/8"'),
      length: '"10.0.0.0/8"'.length,
    });

    expect(configRange(parsed.root, ['gateway', 'missing'])).toBeUndefined();
    expect(configRange(parsed.root, ['missing'], true)).toBeUndefined();
  });
});

describe('formatConfigDocument & parseConfigDocument', () => {
  test('formats with 2-space indentation, preserves LF vs CRLF, and keeps JSONC comments intact', () => {
    const lfInput =
      '{\n// header\n"gateway":{"host":"127.0.0.1","port":3000},\n/* trailing */\n"mcpServers":{}\n}';
    const lfFormatted = formatConfigDocument(lfInput, 'jsonc');
    expect(lfFormatted).toBe(
      '{\n  // header\n  "gateway": {\n    "host": "127.0.0.1",\n    "port": 3000\n  },\n  /* trailing */\n  "mcpServers": {}\n}',
    );
    expect(lfFormatted.includes('\r\n')).toBe(false);

    const crlfInput = '{\r\n"gateway":{"host":"127.0.0.1","port":3000}\r\n}';
    const crlfFormatted = formatConfigDocument(crlfInput, 'json');
    expect(crlfFormatted).toBe(
      '{\r\n  "gateway": {\r\n    "host": "127.0.0.1",\r\n    "port": 3000\r\n  }\r\n}',
    );
  });

  test('parses valid documents and throws fixed message on invalid syntax or duplicate keys', () => {
    expect(parseConfigDocument('{"a": 1, "b": [true, "x"]}')).toEqual({ a: 1, b: [true, 'x'] });

    for (const bad of ['{', '{"a": 1,}', '{"a": 1, "a": 2}']) {
      expect(() => formatConfigDocument(bad, 'json')).toThrow(SYNTAX_OR_DUPLICATE_ERROR);
      expect(() => parseConfigDocument(bad, 'json')).toThrow(SYNTAX_OR_DUPLICATE_ERROR);
    }
  });
});

describe('editConfigDocument', () => {
  test('surgically updates changed leaves while preserving JSONC comments and unedited env refs byte-for-byte', () => {
    const gatewayRef = envRef('GATEWAY_TOKEN');
    const docsRef = envRef('DOCS_TOKEN');
    const source = [
      '{',
      '  // Gateway settings',
      '  "gateway": {',
      '    "host": "127.0.0.1",',
      '    "port": 3000,',
      `    "token": "${gatewayRef}" // kept intact`,
      '  },',
      '  /* Server registry */',
      '  "mcpServers": {',
      '    "docs": {',
      '      "url": "http://127.0.0.1:4000/mcp",',
      '      "headers": {',
      `        "Authorization": "Bearer ${docsRef}"`,
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const next = {
      gateway: {
        host: '127.0.0.1',
        port: 4040,
        token: gatewayRef,
      },
      mcpServers: {
        docs: {
          url: 'http://127.0.0.1:5000/mcp',
          headers: {
            Authorization: `Bearer ${docsRef}`,
          },
        },
      },
    };

    const edited = editConfigDocument(source, next, 'jsonc');
    expect(parseConfigDocument(edited, 'jsonc')).toEqual(next);
    expect(edited).toContain('// Gateway settings');
    expect(edited).toContain(`"token": "${gatewayRef}" // kept intact`);
    expect(edited).toContain('/* Server registry */');
    expect(edited).toContain(`"Authorization": "Bearer ${docsRef}"`);
    expect(edited).toContain('"port": 4040,');
    expect(edited).toContain('"url": "http://127.0.0.1:5000/mcp",');
  });

  test('removes deleted object keys and strips indentation-only lines in both LF and CRLF documents', () => {
    const lfSource = [
      '{',
      '  "gateway": {',
      '    "host": "127.0.0.1",',
      '    "legacy": true,',
      '    "port": 3000',
      '  }',
      '}',
    ].join('\n');

    const next = { gateway: { host: '127.0.0.1', port: 3000 } };
    const lfEdited = editConfigDocument(lfSource, next, 'json');
    expect(parseConfigDocument(lfEdited, 'json')).toEqual(next);
    expect(lfEdited).not.toContain('legacy');
    expect(lfEdited).not.toMatch(/\n[ \t]*\n/);
    expect(lfEdited).toBe(
      ['{', '  "gateway": {', '    "host": "127.0.0.1",', '    "port": 3000', '  }', '}'].join(
        '\n',
      ),
    );

    const crlfSource = lfSource.replaceAll('\n', '\r\n');
    const crlfEdited = editConfigDocument(crlfSource, next, 'json');
    expect(parseConfigDocument(crlfEdited, 'json')).toEqual(next);
    expect(crlfEdited).not.toContain('legacy');
    expect(crlfEdited).not.toMatch(/\r\n[ \t]*\r\n/);
    expect(crlfEdited).toBe(
      ['{', '  "gateway": {', '    "host": "127.0.0.1",', '    "port": 3000', '  }', '}'].join(
        '\r\n',
      ),
    );
  });

  test('grows and shrinks arrays in place', () => {
    const source = JSON.stringify(
      {
        gateway: { allowedPeers: ['a', 'b'] },
        mcpServers: { tool: { command: 'node', args: ['--one', '--two', '--three'] } },
      },
      null,
      2,
    );

    const next = {
      gateway: { allowedPeers: ['a', 'b', 'c', 'd'] },
      mcpServers: { tool: { command: 'node', args: ['--one'] } },
    };

    const edited = editConfigDocument(source, next, 'json');
    expect(parseConfigDocument(edited, 'json')).toEqual(next);
  });

  test('adds a brand-new server entry and replaces a nested object with a primitive value while preserving JSONC comments', () => {
    const source = [
      '{',
      '  // top comment',
      '  "gateway": {',
      '    "nested": { "flag": true }',
      '  },',
      '  "mcpServers": {',
      '    // alpha comment',
      '    "alpha": { "url": "http://127.0.0.1:4000/mcp" }',
      '  }',
      '}',
    ].join('\n');

    const next = {
      gateway: {
        nested: 'replaced-primitive',
      },
      mcpServers: {
        alpha: { url: 'http://127.0.0.1:4000/mcp' },
        beta: { command: 'node', args: ['server.js'] },
      },
    };

    const edited = editConfigDocument(source, next, 'jsonc');
    expect(parseConfigDocument(edited, 'jsonc')).toEqual(next);
    expect(edited).toContain('// top comment');
    expect(edited).toContain('// alpha comment');
  });

  test('renames keys in place while preserving position and comments, handles no-op renames, and rejects missing or colliding targets', () => {
    const source = [
      '{',
      '  "mcpServers": {',
      '    // first server',
      '    "first": { "url": "http://127.0.0.1:1/mcp" },',
      '    // renamed server comment',
      '    "oldName": {',
      '      "url": "http://127.0.0.1:2/mcp"',
      '    },',
      '    // third server',
      '    "third": { "url": "http://127.0.0.1:3/mcp" }',
      '  }',
      '}',
    ].join('\n');

    const next = {
      mcpServers: {
        first: { url: 'http://127.0.0.1:1/mcp' },
        newName: { url: 'http://127.0.0.1:2222/mcp' },
        third: { url: 'http://127.0.0.1:3/mcp' },
      },
    };

    const renamed = editConfigDocument(source, next, 'jsonc', {
      path: ['mcpServers'],
      from: 'oldName',
      to: 'newName',
    });

    expect(parseConfigDocument(renamed, 'jsonc')).toEqual(next);
    expect(renamed).toContain('// renamed server comment');
    expect(renamed.indexOf('"first"')).toBeLessThan(renamed.indexOf('"newName"'));
    expect(renamed.indexOf('"newName"')).toBeLessThan(renamed.indexOf('"third"'));
    expect(renamed).not.toContain('"oldName"');

    const noOpNext = {
      mcpServers: {
        first: { url: 'http://127.0.0.1:1/mcp' },
        oldName: { url: 'http://127.0.0.1:2/mcp' },
        third: { url: 'http://127.0.0.1:3/mcp' },
      },
    };
    const noOpRenamed = editConfigDocument(source, noOpNext, 'jsonc', {
      path: ['mcpServers'],
      from: 'oldName',
      to: 'oldName',
    });
    expect(noOpRenamed).toBe(source);
    expect(parseConfigDocument(noOpRenamed, 'jsonc')).toEqual(noOpNext);

    expect(() =>
      editConfigDocument(source, next, 'jsonc', {
        path: ['mcpServers'],
        from: 'missing',
        to: 'newName',
      }),
    ).toThrow(SYNTAX_OR_DUPLICATE_ERROR);

    expect(() =>
      editConfigDocument(source, next, 'jsonc', {
        path: ['mcpServers'],
        from: 'oldName',
        to: 'third',
      }),
    ).toThrow(SYNTAX_OR_DUPLICATE_ERROR);
  });
});
