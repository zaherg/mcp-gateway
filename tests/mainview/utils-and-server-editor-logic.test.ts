import { describe, expect, spyOn, test } from 'bun:test';

import { undoDepth } from '@codemirror/commands';
import { indentUnit, language, matchBrackets, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';

import {
  bearPreset,
  createKeyValueRow,
  emptyEditor,
  formConfig,
  type KeyValueRow,
  keyValueRowsToRecord,
  parseStringMap,
  recordToKeyValueRows,
} from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { jsonEditing } from '@mcp-gateway/mainview/lib/json-editing';
import { generateToken } from '@mcp-gateway/mainview/lib/token';
import { cn } from '@mcp-gateway/mainview/lib/utils';

describe('generateToken', () => {
  test('returns a 64-character lowercase hexadecimal string', () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('returns distinct tokens on consecutive calls', () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateToken()));
    expect(tokens.size).toBe(10);
  });

  test('zero-pads low byte values from crypto.getRandomValues', () => {
    const spy = spyOn(crypto, 'getRandomValues').mockImplementation(
      <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) {
          for (let i = 0; i < array.length; i += 1) {
            array[i] = i;
          }
        }
        return array;
      },
    );
    try {
      const token = generateToken();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(token).toBe('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('cn', () => {
  test('merges conditional class names and drops falsy inputs', () => {
    expect(
      cn('px-2', false && 'hidden', null, undefined, '', ['py-1', { flex: true, grid: false }]),
    ).toBe('px-2 py-1 flex');
  });

  test('resolves conflicting standard Tailwind utilities with last-wins semantics', () => {
    expect(cn('px-2 text-sm', 'px-4')).toBe('text-sm px-4');
  });

  test('preserves custom macOS typography scale tokens alongside text color classes', () => {
    expect(cn('text-mac-title-1', 'text-red-500')).toBe('text-mac-title-1 text-red-500');
    expect(cn('text-mac-headline', 'text-mac-text')).toBe('text-mac-headline text-mac-text');
    expect(cn('text-mac-body', 'text-mac-muted')).toBe('text-mac-body text-mac-muted');
    expect(cn('text-mac-muted', 'text-mac-subheadline')).toBe(
      'text-mac-muted text-mac-subheadline',
    );
  });

  test('deduplicates conflicting custom macOS typography tokens against each other and standard sizes', () => {
    expect(cn('text-mac-body', 'text-mac-headline')).toBe('text-mac-headline');
    expect(cn('text-sm', 'text-mac-subheadline')).toBe('text-mac-subheadline');
    expect(cn('text-mac-title-1', 'text-lg')).toBe('text-lg');
  });

  test('deduplicates custom macOS radius and shadow tokens', () => {
    expect(cn('rounded-md', 'rounded-mac-control')).toBe('rounded-mac-control');
    expect(cn('rounded-mac-control', 'rounded-mac-popover')).toBe('rounded-mac-popover');
    expect(cn('shadow-sm', 'shadow-mac-popover')).toBe('shadow-mac-popover');
  });
});

describe('jsonEditing', () => {
  test('exports a non-empty CodeMirror 6 extension array', () => {
    expect(Array.isArray(jsonEditing)).toBe(true);
    expect(jsonEditing.length).toBeGreaterThan(0);
  });

  test('creates an EditorState with JSON/JSONC language, 2-space indent, history, and bracket matching', () => {
    const doc = '{\n  // comment\n  "gateway": { "port": 3100 }\n}';
    const state = EditorState.create({
      doc,
      extensions: jsonEditing,
    });

    expect(state.tabSize).toBe(2);
    expect(state.facet(indentUnit)).toBe('  ');
    expect(state.facet(language)).not.toBeNull();
    expect(syntaxTree(state).length).toBeGreaterThan(0);

    const matched = matchBrackets(state, 0, 1);
    expect(matched?.matched).toBe(true);

    expect(undoDepth(state)).toBe(0);
    const updated = state.update({ changes: { from: doc.length, insert: '\n' } }).state;
    expect(undoDepth(updated)).toBe(1);
  });
});

describe('ServerEditor key-value row helpers', () => {
  test('createKeyValueRow assigns unique row IDs and defaults key, value, and secret', () => {
    const first = createKeyValueRow();
    const second = createKeyValueRow();

    expect(first.id).toMatch(/^kv-\d+$/);
    expect(second.id).toMatch(/^kv-\d+$/);
    expect(first.id).not.toBe(second.id);
    expect(first.key).toBe('');
    expect(first.value).toBe('');
    expect(first.secret).toBe(false);
  });

  test('createKeyValueRow detects secret-looking keys by default and excludes env references', () => {
    expect(createKeyValueRow('Authorization', 'Bearer raw-secret').secret).toBe(true);
    expect(createKeyValueRow('X-API-Key', 'sk-123').secret).toBe(true);
    expect(createKeyValueRow('api-key', 'abc').secret).toBe(true);
    expect(createKeyValueRow('custom-api-key', 'abc').secret).toBe(true);
    expect(createKeyValueRow('GITHUB_TOKEN', 'ghp_123').secret).toBe(true);
    expect(createKeyValueRow('CLIENT_SECRET', 'xyz').secret).toBe(true);
    expect(createKeyValueRow('DB_PASSWORD', 'pass').secret).toBe(true);
    expect(createKeyValueRow('SIGNING_KEY', 'k').secret).toBe(true);

    expect(createKeyValueRow('NODE_ENV', 'production').secret).toBe(false);
    expect(createKeyValueRow('Content-Type', 'application/json').secret).toBe(false);

    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal environment variable reference syntax.
    expect(createKeyValueRow('Authorization', 'Bearer ${API_TOKEN}').secret).toBe(false);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal environment variable reference syntax.
    expect(createKeyValueRow('GITHUB_TOKEN', '${GITHUB_TOKEN}').secret).toBe(false);

    expect(createKeyValueRow('NODE_ENV', 'production', true).secret).toBe(true);
    expect(createKeyValueRow('GITHUB_TOKEN', 'ghp_123', false).secret).toBe(false);
  });

  test('recordToKeyValueRows converts undefined and populated records into KeyValueRow arrays', () => {
    expect(recordToKeyValueRows(undefined)).toEqual([]);
    expect(recordToKeyValueRows({})).toEqual([]);

    const rows = recordToKeyValueRows({
      NODE_ENV: 'production',
      API_TOKEN: 'secret-value',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal environment variable reference syntax.
      Authorization: 'Bearer ${UPSTREAM_TOKEN}',
    });

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.map(({ key, value, secret }) => ({ key, value, secret }))).toEqual([
      { key: 'NODE_ENV', value: 'production', secret: false },
      { key: 'API_TOKEN', value: 'secret-value', secret: true },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal environment variable reference syntax.
      { key: 'Authorization', value: 'Bearer ${UPSTREAM_TOKEN}', secret: false },
    ]);
  });

  test('keyValueRowsToRecord trims keys, skips blank rows, and preserves values', () => {
    const rows: KeyValueRow[] = [
      createKeyValueRow('  FOO  ', ' bar '),
      createKeyValueRow('   ', ''),
      createKeyValueRow('', ''),
      createKeyValueRow('EMPTY_VALUE', ''),
    ];

    const record = keyValueRowsToRecord(rows, 'invalid rows');
    expect(record).toEqual({ FOO: ' bar ', EMPTY_VALUE: '' });
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
  });

  test('keyValueRowsToRecord rejects missing keys with values, duplicates, and forbidden prototype keys', () => {
    expect(() =>
      keyValueRowsToRecord([createKeyValueRow('   ', 'orphan-value')], 'env invalid'),
    ).toThrow('env invalid');

    expect(() =>
      keyValueRowsToRecord(
        [createKeyValueRow('API_KEY', 'one'), createKeyValueRow(' API_KEY ', 'two')],
        'duplicate key',
      ),
    ).toThrow('duplicate key');

    for (const forbidden of ['__proto__', ' __proto__ ', 'constructor', 'prototype']) {
      expect(() =>
        keyValueRowsToRecord([createKeyValueRow(forbidden, 'bad')], 'forbidden key'),
      ).toThrow('forbidden key');
    }
  });
});

describe('parseStringMap', () => {
  test('parses empty input and valid JSON string-to-string objects', () => {
    expect(parseStringMap('', 'must be string map')).toEqual({});
    expect(parseStringMap('{"FOO": "bar", "EMPTY": ""}', 'must be string map')).toEqual({
      FOO: 'bar',
      EMPTY: '',
    });
  });

  test('rejects arrays, primitives, non-string values, and __proto__ keys with the supplied message', () => {
    const invalidInputs = [
      '["a", "b"]',
      'null',
      '42',
      '"hello"',
      'true',
      '{"COUNT": 1}',
      '{"FLAG": true}',
      '{"EMPTY": null}',
      '{"NESTED": {"a": "b"}}',
      '{"__proto__": "polluted"}',
    ];

    for (const input of invalidInputs) {
      expect(() => parseStringMap(input, 'expected string map')).toThrow('expected string map');
    }
  });

  test('throws a SyntaxError on malformed JSON', () => {
    expect(() => parseStringMap('{not-json}', 'expected string map')).toThrow(SyntaxError);
  });
});

describe('emptyEditor and bearPreset', () => {
  test('emptyEditor initializes a clean default stdio editor state with fresh arrays', () => {
    const first = emptyEditor();
    const second = emptyEditor();

    expect(first).toEqual({
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
      token: undefined,
      tokenRef: undefined,
    });
    expect(first.args).not.toBe(second.args);
    expect(first.env).not.toBe(second.env);
    expect(first.headers).not.toBe(second.headers);
  });

  test('bearPreset populates the macOS Bear CLI preset and preserves a typed server name', () => {
    expect(bearPreset()).toEqual({
      name: 'bear',
      command: '/Applications/Bear.app/Contents/MacOS/bearcli',
      args: ['mcp-server'],
    });
    expect(bearPreset('')).toEqual({
      name: 'bear',
      command: '/Applications/Bear.app/Contents/MacOS/bearcli',
      args: ['mcp-server'],
    });
    expect(bearPreset('notes')).toEqual({
      name: 'notes',
      command: '/Applications/Bear.app/Contents/MacOS/bearcli',
      args: ['mcp-server'],
    });
  });
});

describe('formConfig', () => {
  test('parses valid JSON configs with stdio and http servers and preserves unknown fields', () => {
    const raw = JSON.stringify({
      gateway: {
        host: '127.0.0.1',
        port: 3100,
        token: 'a'.repeat(64),
        autoStart: true,
        launchAtLogin: false,
        keepAwake: true,
        allowedPeers: ['100.64.0.1'],
      },
      mcpServers: {
        bear: {
          command: '/Applications/Bear.app/Contents/MacOS/bearcli',
          args: ['mcp-server'],
          env: { BEAR_MODE: 'read' },
          cwd: '/Users/tester',
          disabled: false,
          legacyProtocol: false,
          token: 'server-token',
        },
        remote: {
          url: 'https://mcp.example/v1',
          headers: { Authorization: 'Bearer token' },
          disabled: true,
          legacyProtocol: true,
          tokenRef: 'server:remote',
        },
      },
      extraForNativeValidation: true,
    });

    const parsed = formConfig(raw, 'json');
    expect(parsed).not.toBeNull();
    expect(parsed?.gateway.host).toBe('127.0.0.1');
    expect(parsed?.gateway.port).toBe(3100);
    expect(parsed?.mcpServers.bear).toEqual({
      command: '/Applications/Bear.app/Contents/MacOS/bearcli',
      args: ['mcp-server'],
      env: { BEAR_MODE: 'read' },
      cwd: '/Users/tester',
      disabled: false,
      legacyProtocol: false,
      token: 'server-token',
    });
    expect(parsed?.mcpServers.remote).toEqual({
      url: 'https://mcp.example/v1',
      headers: { Authorization: 'Bearer token' },
      disabled: true,
      legacyProtocol: true,
      tokenRef: 'server:remote',
    });
    expect((parsed as unknown as Record<string, unknown>).extraForNativeValidation).toBe(true);
  });

  test('parses valid JSONC configs with comments, trailing commas, and gateway tokenRef', () => {
    const raw = `{
      // gateway settings
      "gateway": {
        "host": "127.0.0.1",
        "port": 3100,
        "tokenRef": "gateway",
      },
      /* backends */
      "mcpServers": {
        "local": {
          "command": "node",
        },
      },
    }`;

    const parsed = formConfig(raw, 'jsonc');
    expect(parsed).toEqual({
      gateway: {
        host: '127.0.0.1',
        port: 3100,
        tokenRef: 'gateway',
      },
      mcpServers: {
        local: {
          command: 'node',
        },
      },
    });
  });

  test('returns null on syntax errors or invalid top-level and gateway shapes', () => {
    const baseGateway = { host: '127.0.0.1', port: 3100, token: 'secret' };
    const cases = [
      '{ invalid json',
      '[]',
      JSON.stringify({ gateway: baseGateway }),
      JSON.stringify({ mcpServers: {} }),
      JSON.stringify({ gateway: { host: 123, port: 3100, token: 'secret' }, mcpServers: {} }),
      JSON.stringify({
        gateway: { host: '127.0.0.1', port: '3100', token: 'secret' },
        mcpServers: {},
      }),
      // Neither token nor tokenRef
      JSON.stringify({ gateway: { host: '127.0.0.1', port: 3100 }, mcpServers: {} }),
      // Both token and tokenRef
      JSON.stringify({
        gateway: { host: '127.0.0.1', port: 3100, token: 'secret', tokenRef: 'gateway' },
        mcpServers: {},
      }),
      JSON.stringify({ gateway: { ...baseGateway, token: 42 }, mcpServers: {} }),
      JSON.stringify({ gateway: { ...baseGateway, autoStart: 'yes' }, mcpServers: {} }),
      JSON.stringify({ gateway: { ...baseGateway, launchAtLogin: 1 }, mcpServers: {} }),
      JSON.stringify({ gateway: { ...baseGateway, keepAwake: null }, mcpServers: {} }),
      JSON.stringify({ gateway: { ...baseGateway, allowedPeers: ['ok', 42] }, mcpServers: {} }),
    ];

    for (const raw of cases) {
      expect(formConfig(raw, 'json')).toBeNull();
    }
  });

  test('returns null when any stdio or http server entry has invalid field types or __proto__ maps', () => {
    const gateway = { host: '127.0.0.1', port: 3100, token: 'secret' };
    const invalidServers: unknown[] = [
      null,
      'not-an-object',
      { command: 123 },
      { command: 'node', args: 'not-an-array' },
      { command: 'node', args: ['ok', 2] },
      { command: 'node', env: { PORT: 3000 } },
      { command: 'node', cwd: 123 },
      { command: 'node', disabled: 'false' },
      { command: 'node', legacyProtocol: 1 },
      { command: 'node', token: 99 },
      { command: 'node', tokenRef: false },
      { url: 123 },
      { url: 'https://example.com', headers: { 'X-Count': 1 } },
      { url: 'https://example.com', headers: ['bad'] },
    ];

    for (const server of invalidServers) {
      expect(
        formConfig(JSON.stringify({ gateway, mcpServers: { bad: server } }), 'json'),
      ).toBeNull();
    }

    const protoEnvRaw =
      '{"gateway":{"host":"127.0.0.1","port":3100,"token":"secret"},"mcpServers":{"s":{"command":"node","env":{"__proto__":"bad"}}}}';
    expect(formConfig(protoEnvRaw, 'json')).toBeNull();

    const protoHeadersRaw =
      '{"gateway":{"host":"127.0.0.1","port":3100,"token":"secret"},"mcpServers":{"s":{"url":"https://example.com","headers":{"__proto__":"bad"}}}}';
    expect(formConfig(protoHeadersRaw, 'json')).toBeNull();
  });
});
