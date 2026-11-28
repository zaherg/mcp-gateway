import { assert, describe, it } from '@effect/vitest';

import {
  computeHostPatch,
  computePeersPatch,
  computePortPatch,
  computeTokenPatch,
  draftsFromSavedConfig,
  formatImportStatus,
  formatPeersDraft,
  formatPortDraft,
  parsePeerList,
  type SavedGatewaySnapshot,
} from '@mcp-gateway/mainview/effect-settings/logic';
import {
  applyGatewayMutation,
  GatewayMutation,
} from '@mcp-gateway/mainview/effect-settings/services';

const saved: SavedGatewaySnapshot = {
  host: '127.0.0.1',
  port: 8787,
  allowedPeers: ['192.168.1.0/24'],
  token: 'a'.repeat(64),
  tokenRef: null,
  launchAtLogin: false,
  autoStart: true,
  keepAwake: false,
};

describe('effect-settings pure logic', () => {
  it('parses comma-separated peer ranges and preserves separator-only empty lists', () => {
    assert.strictEqual(parsePeerList(''), undefined);
    assert.strictEqual(parsePeerList('   '), undefined);
    assert.deepStrictEqual(parsePeerList(', ,'), []);
    assert.deepStrictEqual(parsePeerList(' 10.0.0.0/8 , 192.168.1.10 , '), [
      '10.0.0.0/8',
      '192.168.1.10',
    ]);
  });

  it('formats drafts from saved gateway config', () => {
    assert.strictEqual(formatPortDraft(0), '');
    assert.strictEqual(formatPortDraft(8787), '8787');
    assert.strictEqual(formatPeersDraft(null), '');
    assert.strictEqual(formatPeersDraft(['10.0.0.1', '10.0.0.2']), '10.0.0.1, 10.0.0.2');
    assert.deepStrictEqual(draftsFromSavedConfig(saved), {
      hostInput: '127.0.0.1',
      portInput: '8787',
      peersText: '192.168.1.0/24',
      tokenInput: 'a'.repeat(64),
    });
    assert.deepStrictEqual(draftsFromSavedConfig(null), {
      hostInput: '',
      portInput: '',
      peersText: '',
      tokenInput: '',
    });
  });

  it('computes field patches and skips unchanged, invalid, or locked inputs', () => {
    assert.strictEqual(computeHostPatch('127.0.0.1', saved, false), null);
    assert.strictEqual(computeHostPatch('192.168.1.25', saved, true), null);
    assert.strictEqual(computeHostPatch('192.168.1.25', saved, false), '192.168.1.25');

    assert.strictEqual(computePortPatch('8787', saved, false), null);
    assert.strictEqual(computePortPatch('not-a-port', saved, false), null);
    assert.strictEqual(computePortPatch('', saved, false), 0);
    assert.strictEqual(computePortPatch('9090', saved, false), 9090);
    assert.strictEqual(computePortPatch('9090', saved, true), null);

    assert.strictEqual(computePeersPatch('192.168.1.0/24', saved, false), null);
    assert.deepStrictEqual(computePeersPatch(', ,', saved, false), { allowedPeers: [] });
    assert.deepStrictEqual(computePeersPatch('   ', saved, false), { allowedPeers: null });

    assert.strictEqual(computeTokenPatch('a'.repeat(64), saved, false), null);
    assert.strictEqual(computeTokenPatch('new-token', saved, false), 'new-token');
    assert.strictEqual(computeTokenPatch('new-token', saved, true), null);
  });

  it('applies GatewayMutation variants with exact undefined omission semantics', () => {
    const base = {
      host: '127.0.0.1',
      port: 8787,
      tokenRef: 'gateway:default',
      allowedPeers: ['192.168.1.0/24'],
      keepAwake: true,
    };
    assert.strictEqual(
      applyGatewayMutation(base, GatewayMutation.SetKeepAwake({ value: false })).keepAwake,
      undefined,
    );
    assert.strictEqual(
      applyGatewayMutation(base, GatewayMutation.SetKeepAwake({ value: true })).keepAwake,
      true,
    );
    assert.strictEqual(
      applyGatewayMutation(base, GatewayMutation.SetAllowedPeers({ allowedPeers: null }))
        .allowedPeers,
      undefined,
    );
    assert.deepStrictEqual(
      applyGatewayMutation(base, GatewayMutation.SetAllowedPeers({ allowedPeers: [] }))
        .allowedPeers,
      [],
    );
    const replaced = applyGatewayMutation(
      base,
      GatewayMutation.ReplaceTokenWithLiteral({ token: 'f'.repeat(64) }),
    );
    assert.strictEqual(replaced.token, 'f'.repeat(64));
    assert.strictEqual(replaced.tokenRef, undefined);
  });

  it('formats import status messages for singular, plural, and empty results', () => {
    assert.strictEqual(formatImportStatus(0), 'No new servers found in Claude Desktop or Cursor.');
    assert.strictEqual(formatImportStatus(1), 'Imported 1 server from Claude Desktop / Cursor.');
    assert.strictEqual(formatImportStatus(3), 'Imported 3 servers from Claude Desktop / Cursor.');
  });
});
