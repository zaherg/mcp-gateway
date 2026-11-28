import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { MODERN_VERSION } from '@mcp-gateway/core/adapter';
import { fireEvent, flushDom, waitFor } from '../helpers/dom';
import {
  bootFullStackApp,
  reserveLoopbackPort,
  STDIO_MCP_SERVER_SCRIPT,
  startUpstreamHttpMcpServer,
} from '../helpers/e2e';
import { modernMeta, parseSseMessages } from '../helpers/http-mount';
import { setInputValue } from '../helpers/mainview';

interface CopiedClientConfig {
  mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseJsonRpcResponse = async (response: Response) => {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (contentType.includes('text/event-stream')) {
    const messages = parseSseMessages(text);
    const reply = messages.find(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null && ('result' in item || 'error' in item),
    );
    if (!reply) throw new Error(`No JSON-RPC reply found in SSE stream: ${text}`);
    return reply;
  }
  return JSON.parse(text) as Record<string, unknown>;
};

const postModernJsonRpc = (
  url: string,
  headers: Record<string, string>,
  body: { jsonrpc: '2.0'; id: number | string; method: string; params?: Record<string, unknown> },
) => {
  const toolName = typeof body.params?.name === 'string' ? body.params.name : undefined;
  return fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': MODERN_VERSION,
      'mcp-method': body.method,
      ...(toolName ? { 'mcp-name': toolName } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
};

describe('Full-stack E2E: Streamable HTTP upstream, multi-server isolation, and Keychain migration', () => {
  test('E2E-05: adding a Streamable HTTP server with custom headers, test connection, credential redaction on copy, and live MCP forwarding', async () => {
    const upstream = await startUpstreamHttpMcpServer();
    const app = await bootFullStackApp();
    const { view } = app;

    await view.findByText('No servers configured');
    fireEvent.click(view.getByRole('button', { name: 'Add server' }));
    await view.findByRole('button', { name: 'Apply to draft' });

    setInputValue(view.getByLabelText('Server name'), 'remote-http');
    fireEvent.change(view.getByLabelText('Transport'), { target: { value: 'http' } });
    setInputValue(await view.findByLabelText('Upstream URL'), upstream.url);

    fireEvent.click(view.getByRole('button', { name: /Add Row/i }));
    setInputValue(await view.findByPlaceholderText('KEY'), 'X-Upstream-Key');
    setInputValue(view.getByPlaceholderText(/^value or \$\{ENV_VAR\}$/), 'upstream-secret-token');
    await flushDom();

    fireEvent.click(view.getByRole('button', { name: 'Apply to draft' }));
    await waitFor(() => {
      const alertText = view.queryByRole('alert')?.textContent ?? null;
      expect(alertText).toBeNull();
      expect(view.queryByRole('button', { name: 'Apply to draft' }) === null).toBe(true);
    });

    await view.findByText('remote-http');
    expect(view.getByText('HTTP')).toBeTruthy();
    expect(view.getByText(upstream.url)).toBeTruthy();

    fireEvent.click(view.getByRole('button', { name: 'Start gateway' }));
    await view.findByRole('button', { name: 'Stop gateway' });
    expect(view.getAllByText('Gateway running').length).toBeGreaterThan(0);

    fireEvent.click(view.getByRole('button', { name: 'Test connection for remote-http' }));
    await view.findByText(
      'Server answered through the gateway (MCP 2026-07-28).',
      {},
      { timeout: 10_000 },
    );

    fireEvent.click(view.getByRole('button', { name: 'Copy client configuration' }));
    await waitFor(() => {
      expect(app.clipboard() !== null).toBe(true);
    });

    const diskConfig = JSON.parse(await readFile(app.configPath, 'utf8')) as {
      gateway: { token: string };
    };
    const copied = JSON.parse(app.clipboard() ?? '') as CopiedClientConfig;
    const remoteClient = copied.mcpServers['remote-http'];
    expect(remoteClient.url).toBe(`http://127.0.0.1:${app.port}/mcp/remote-http`);
    expect(remoteClient.url).not.toBe(upstream.url);
    expect(Object.keys(remoteClient.headers)).toEqual(['Authorization']);
    expect(remoteClient.headers.Authorization).toBe(`Bearer ${diskConfig.gateway.token}`);
    expect(app.clipboard()).not.toContain('X-Upstream-Key');
    expect(app.clipboard()).not.toContain('upstream-secret-token');

    const listRes = await postModernJsonRpc(remoteClient.url, remoteClient.headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: modernMeta() },
    });
    expect(listRes.status).toBe(200);
    const listPayload = (await parseJsonRpcResponse(listRes)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listPayload.result.tools[0]?.name).toBe('echo_http');

    const callRes = await postModernJsonRpc(remoteClient.url, remoteClient.headers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'echo_http',
        arguments: { text: 'hello-upstream' },
        _meta: modernMeta(),
      },
    });
    expect(callRes.status).toBe(200);
    const callPayload = (await parseJsonRpcResponse(callRes)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(JSON.parse(callPayload.result.content[0]?.text ?? '{}')).toEqual({
      text: 'hello-upstream',
      upstreamKey: 'upstream-secret-token',
    });
    expect(
      upstream.requests.some((req) => req.headers['x-upstream-key'] === 'upstream-secret-token'),
    ).toBe(true);
  }, 20_000);

  test('E2E-06: multi-server coexistence, per-server token isolation, live Keychain migration, and Logs verification', async () => {
    const upstream = await startUpstreamHttpMcpServer();
    const port = await reserveLoopbackPort();
    const globalToken = 'a'.repeat(64);
    const serverToken = 'b'.repeat(64);

    const initialConfigText = JSON.stringify(
      {
        gateway: {
          host: '127.0.0.1',
          port,
          token: globalToken,
          autoStart: false,
          keepAwake: true,
          launchAtLogin: false,
        },
        mcpServers: {
          'local-stdio': {
            command: process.execPath,
            args: ['-e', STDIO_MCP_SERVER_SCRIPT],
          },
          'remote-http': {
            url: upstream.url,
            token: serverToken,
          },
        },
      },
      null,
      2,
    );

    const app = await bootFullStackApp({
      initialConfigText,
      withKeyStore: true,
      existingInstall: true,
    });
    const { view } = app;

    await view.findByText('local-stdio');
    await view.findByText('remote-http');
    expect(view.getByText('STDIO')).toBeTruthy();
    expect(view.getByText('HTTP')).toBeTruthy();
    await view.findByText('You have keys stored in the configuration file.');

    fireEvent.click(view.getByRole('button', { name: 'Start gateway' }));
    await view.findByRole('button', { name: 'Stop gateway' });
    expect(view.getAllByText('Gateway running').length).toBeGreaterThan(0);
    expect(app.sleepAssertions.active).toBe(1);

    const stdioUrl = `http://127.0.0.1:${port}/mcp/local-stdio`;
    const httpUrl = `http://127.0.0.1:${port}/mcp/remote-http`;

    // Verify Plan 001 exclusive auth isolation before migration
    const stdioWithGlobal = await postModernJsonRpc(
      stdioUrl,
      { Authorization: `Bearer ${globalToken}` },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: modernMeta() } },
    );
    expect(stdioWithGlobal.status).toBe(200);
    await stdioWithGlobal.text();

    const stdioWithServer = await postModernJsonRpc(
      stdioUrl,
      { Authorization: `Bearer ${serverToken}` },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: modernMeta() } },
    );
    expect(stdioWithServer.status).toBe(401);
    await stdioWithServer.text();

    const httpWithServer = await postModernJsonRpc(
      httpUrl,
      { Authorization: `Bearer ${serverToken}` },
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: modernMeta() } },
    );
    expect(httpWithServer.status).toBe(200);
    await httpWithServer.text();

    const httpWithGlobal = await postModernJsonRpc(
      httpUrl,
      { Authorization: `Bearer ${globalToken}` },
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: { _meta: modernMeta() } },
    );
    expect(httpWithGlobal.status).toBe(401);
    await httpWithGlobal.text();

    // Run live KeyMigration dialog flow while gateway is running
    fireEvent.click(view.getByRole('button', { name: 'Review keys' }));
    fireEvent.click(await view.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await view.findByRole('button', { name: 'Move 2 keys to Keychain' }));
    await view.findByText('Keys moved to Keychain.');
    fireEvent.click(view.getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(view.queryByRole('button', { name: 'Done' }) === null).toBe(true);
    });

    // Verify plaintext secrets are removed from disk and stored in KeyStore by UUID tokenRef
    const migratedRaw = await readFile(app.configPath, 'utf8');
    expect(migratedRaw).not.toContain(globalToken);
    expect(migratedRaw).not.toContain(serverToken);

    const migratedConfig = JSON.parse(migratedRaw) as {
      gateway: { token?: string; tokenRef?: string };
      mcpServers: {
        'remote-http': { token?: string; tokenRef?: string };
      };
    };
    expect(migratedConfig.gateway.token).toBeUndefined();
    expect(migratedConfig.gateway.tokenRef).toMatch(UUID_PATTERN);
    expect(migratedConfig.mcpServers['remote-http'].token).toBeUndefined();
    expect(migratedConfig.mcpServers['remote-http'].tokenRef).toMatch(UUID_PATTERN);

    const gatewayRef = migratedConfig.gateway.tokenRef ?? '';
    const remoteRef = migratedConfig.mcpServers['remote-http'].tokenRef ?? '';
    expect(app.keyStore?.entries.get(gatewayRef)).toBe(globalToken);
    expect(app.keyStore?.entries.get(remoteRef)).toBe(serverToken);

    // Verify both live endpoints still answer with their respective bearer tokens after migration
    const postMigrateStdio = await postModernJsonRpc(
      stdioUrl,
      { Authorization: `Bearer ${globalToken}` },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'echo_stdio',
          arguments: { text: 'after-keychain-stdio' },
          _meta: modernMeta(),
        },
      },
    );
    expect(postMigrateStdio.status).toBe(200);
    const postMigrateStdioPayload = (await parseJsonRpcResponse(postMigrateStdio)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(JSON.parse(postMigrateStdioPayload.result.content[0]?.text ?? '{}')).toMatchObject({
      text: 'after-keychain-stdio',
    });

    const postMigrateHttp = await postModernJsonRpc(
      httpUrl,
      { Authorization: `Bearer ${serverToken}` },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'echo_http',
          arguments: { text: 'after-keychain-http' },
          _meta: modernMeta(),
        },
      },
    );
    expect(postMigrateHttp.status).toBe(200);
    const postMigrateHttpPayload = (await parseJsonRpcResponse(postMigrateHttp)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(JSON.parse(postMigrateHttpPayload.result.content[0]?.text ?? '{}')).toMatchObject({
      text: 'after-keychain-http',
    });

    // Switch to Logs view and verify controller.readLogs entries render
    fireEvent.click(view.getByRole('button', { name: 'Logs' }));
    await view.findByText('Configuration loaded.');

    // Stop gateway and verify sleep assertion release and TCP teardown
    fireEvent.click(view.getByRole('button', { name: 'Stop gateway' }));
    await view.findByRole('button', { name: 'Start gateway' });
    expect(app.sleepAssertions.active).toBe(0);
    await expect(
      postModernJsonRpc(
        stdioUrl,
        { Authorization: `Bearer ${globalToken}` },
        { jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: modernMeta() } },
      ),
    ).rejects.toThrow();
  }, 20_000);
});
