import { describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';

import { fireEvent, waitFor } from '@testing-library/react';

import { MODERN_VERSION } from '@mcp-gateway/core/adapter';
import { bootFullStackApp, reserveLoopbackPort, STDIO_MCP_SERVER_SCRIPT } from '../helpers/e2e';
import { modernMeta, parseSseMessages } from '../helpers/http-mount';
import { setInputValue } from '../helpers/mainview';

interface CopiedClientConfig {
  mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
}

const parseJsonRpcResponse = async (response: Response): Promise<Record<string, unknown>> => {
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

const postJsonRpc = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });

const postModernJsonRpc = (
  url: string,
  headers: Record<string, string>,
  body: { jsonrpc: '2.0'; id: number | string; method: string; params?: Record<string, unknown> },
): Promise<Response> => {
  const toolName = typeof body.params?.name === 'string' ? body.params.name : undefined;
  return postJsonRpc(
    url,
    {
      'mcp-protocol-version': MODERN_VERSION,
      'mcp-method': body.method,
      ...(toolName ? { 'mcp-name': toolName } : {}),
      ...headers,
    },
    body,
  );
};

describe('Full-stack E2E: onboarding & stdio server lifecycle', () => {
  test('E2E-01/02/03: first-run onboarding, stdio server creation, gateway toggle, test connection, copy config, and live MCP TCP traffic', async () => {
    const app = await bootFullStackApp();
    const { view } = app;

    // E2E-01: First-run onboarding & disk initialization
    await view.findByText('No servers configured');
    expect(view.getAllByText('Gateway stopped').length).toBeGreaterThan(0);
    expect(view.getByText(`127.0.0.1:${app.port}`)).toBeTruthy();

    const fileStat = await stat(app.configPath);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const initialDiskConfig = JSON.parse(await readFile(app.configPath, 'utf8')) as {
      gateway: { host: string; port: number; token: string };
      mcpServers: Record<string, unknown>;
    };
    expect(initialDiskConfig.gateway.host).toBe('127.0.0.1');
    expect(initialDiskConfig.gateway.port).toBe(app.port);
    expect(initialDiskConfig.gateway.token).toMatch(/^[a-f0-9]{64}$/);
    expect(initialDiskConfig.mcpServers).toEqual({});

    // E2E-02: Add a stdio server through <ServerEditor />
    fireEvent.click(view.getByRole('button', { name: 'Add server' }));
    await view.findByRole('button', { name: 'Apply to draft' });

    setInputValue(view.getByLabelText('Server name'), 'alpha-stdio');
    setInputValue(view.getByLabelText('Command'), process.execPath);

    const addArgButton = view.getByRole('button', { name: /Add Argument/i });
    fireEvent.click(addArgButton);
    fireEvent.click(addArgButton);
    fireEvent.click(addArgButton);
    fireEvent.click(addArgButton);
    setInputValue(view.getByPlaceholderText('--arg-1'), '-e');
    setInputValue(view.getByPlaceholderText('--arg-2'), STDIO_MCP_SERVER_SCRIPT);
    setInputValue(view.getByPlaceholderText('--arg-3'), '--');
    setInputValue(view.getByPlaceholderText('--arg-4'), '--custom-flag');

    fireEvent.click(view.getByRole('button', { name: /Add Row/i }));
    setInputValue(view.getByPlaceholderText('KEY'), 'E2E_MODE');
    setInputValue(view.getByPlaceholderText(/^value or \$\{ENV_VAR\}$/), 'stdio-e2e-live');

    fireEvent.click(view.getByRole('button', { name: 'Apply to draft' }));

    await waitFor(() => {
      const alertText = view.queryByRole('alert')?.textContent ?? null;
      expect(alertText).toBeNull();
      expect(view.queryByRole('button', { name: 'Apply to draft' }) === null).toBe(true);
    });
    await view.findByText('alpha-stdio');
    expect(view.getByText('STDIO')).toBeTruthy();
    expect(view.getByText('/mcp/alpha-stdio')).toBeTruthy();

    const savedDiskConfig = JSON.parse(await readFile(app.configPath, 'utf8')) as {
      mcpServers: Record<
        string,
        { command: string; args?: string[]; env?: Record<string, string> }
      >;
    };
    expect(savedDiskConfig.mcpServers['alpha-stdio']).toMatchObject({
      command: process.execPath,
      args: ['-e', STDIO_MCP_SERVER_SCRIPT, '--', '--custom-flag'],
      env: { E2E_MODE: 'stdio-e2e-live' },
    });

    // Start gateway via <GatewayToggle />
    fireEvent.click(view.getByRole('button', { name: 'Start gateway' }));
    await view.findByRole('button', { name: 'Stop gateway' });
    expect(view.getAllByText('Gateway running').length).toBeGreaterThan(0);
    expect(view.getByTitle('Mounted')).toBeTruthy();
    // Default first-run config leaves keepAwake disabled until toggled on in Settings.
    expect(app.sleepAssertions.active).toBe(0);

    // Enable "Keep the Mac awake while the gateway runs" in Settings and confirm live assertion
    fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    const keepAwakeText = await view.findByText('Keep the Mac awake while the gateway runs');
    const keepAwakeControl = keepAwakeText.closest('label')?.querySelector('[role="switch"]');
    if (!keepAwakeControl) throw new Error('Expected keep-awake switch inside toggle label.');
    fireEvent.click(keepAwakeControl);
    await waitFor(() => {
      expect(app.sleepAssertions.active).toBe(1);
    });
    fireEvent.click(view.getByRole('button', { name: 'Overview' }));
    await view.findByText('alpha-stdio');

    // E2E-03: Live Test connection, Copy client configuration, and real TCP MCP traffic
    fireEvent.click(view.getByRole('button', { name: 'Test connection for alpha-stdio' }));
    await view.findByText(
      'Server answered through the gateway (MCP 2026-07-28).',
      {},
      { timeout: 10_000 },
    );

    fireEvent.click(view.getByRole('button', { name: 'Copy client configuration' }));
    await waitFor(() => {
      expect(app.clipboard() !== null).toBe(true);
    });
    const copied = JSON.parse(app.clipboard() ?? '') as CopiedClientConfig;
    expect(copied).toEqual({
      mcpServers: {
        'alpha-stdio': {
          url: `http://127.0.0.1:${app.port}/mcp/alpha-stdio`,
          headers: {
            Authorization: `Bearer ${initialDiskConfig.gateway.token}`,
          },
        },
      },
    });

    const endpoint = copied.mcpServers['alpha-stdio'];
    const listRes = await postModernJsonRpc(endpoint.url, endpoint.headers, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: modernMeta() },
    });
    expect(listRes.status).toBe(200);
    const listPayload = (await parseJsonRpcResponse(listRes)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listPayload.result.tools[0]?.name).toBe('echo_stdio');

    const callRes = await postModernJsonRpc(endpoint.url, endpoint.headers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'echo_stdio',
        arguments: { text: 'ping-from-e2e' },
        _meta: modernMeta(),
      },
    });
    expect(callRes.status).toBe(200);
    const callPayload = (await parseJsonRpcResponse(callRes)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(JSON.parse(callPayload.result.content[0]?.text ?? '{}')).toEqual({
      text: 'ping-from-e2e',
      env: 'stdio-e2e-live',
      argv: ['--custom-flag'],
    });

    // Stop and restart gateway via <GatewayToggle />, verifying TCP teardown and re-bind
    fireEvent.click(view.getByRole('button', { name: 'Stop gateway' }));
    await view.findByRole('button', { name: 'Start gateway' });
    expect(app.sleepAssertions.active).toBe(0);
    await expect(
      postModernJsonRpc(endpoint.url, endpoint.headers, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
        params: { _meta: modernMeta() },
      }),
    ).rejects.toThrow();

    fireEvent.click(view.getByRole('button', { name: 'Start gateway' }));
    await view.findByRole('button', { name: 'Stop gateway' });
    expect(app.sleepAssertions.active).toBe(1);

    const postRestartRes = await postModernJsonRpc(endpoint.url, endpoint.headers, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: { _meta: modernMeta() },
    });
    expect(postRestartRes.status).toBe(200);
    await postRestartRes.text();
  }, 20_000);

  test('E2E-04: editing stdio server (custom token + legacy protocol), toggling, restarting, and deleting while running', async () => {
    const port = await reserveLoopbackPort();
    const globalToken = 'g'.repeat(64);
    const initialConfigText = JSON.stringify(
      {
        gateway: {
          host: '127.0.0.1',
          port,
          token: globalToken,
          autoStart: false,
          launchAtLogin: false,
        },
        mcpServers: {
          'alpha-stdio': {
            command: process.execPath,
            args: ['-e', STDIO_MCP_SERVER_SCRIPT, '--', '--initial'],
            env: { E2E_MODE: 'edit-lifecycle' },
          },
        },
      },
      null,
      2,
    );

    const app = await bootFullStackApp({ initialConfigText });
    const { view } = app;
    await view.findByText('alpha-stdio');

    fireEvent.click(view.getByRole('button', { name: 'Start gateway' }));
    await view.findByRole('button', { name: 'Stop gateway' });
    expect(view.getByTitle('Mounted')).toBeTruthy();

    // Edit alpha-stdio: switch to custom server key + enable legacyProtocol
    fireEvent.click(view.getByRole('button', { name: 'Edit server' }));
    await view.findByRole('button', { name: 'Apply to draft' });

    fireEvent.change(view.getByLabelText('Authentication'), {
      target: { value: 'custom' },
    });
    fireEvent.click(view.getByRole('button', { name: 'Generate secure key' }));
    const legacyCheckbox = view
      .getByText('Allow session-based clients (MCP 2025-11-25 and earlier)')
      .closest('.checkbox-row')
      ?.querySelector('[role="checkbox"]');
    if (!legacyCheckbox) throw new Error('Expected legacy protocol checkbox.');
    fireEvent.click(legacyCheckbox);
    fireEvent.click(view.getByRole('button', { name: 'Apply to draft' }));

    await waitFor(() => {
      const alertText = view.queryByRole('alert')?.textContent ?? null;
      expect(alertText).toBeNull();
      expect(view.queryByRole('button', { name: 'Apply to draft' }) === null).toBe(true);
    });

    const endpointUrl = `http://127.0.0.1:${port}/mcp/alpha-stdio`;

    // Old global bearer token is now rejected with HTTP 401
    const rejectedRes = await postModernJsonRpc(
      endpointUrl,
      { Authorization: `Bearer ${globalToken}` },
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: modernMeta() },
      },
    );
    expect(rejectedRes.status).toBe(401);
    await rejectedRes.text();

    // Copy client config to obtain the newly generated per-server token
    fireEvent.click(view.getByRole('button', { name: 'Copy client configuration' }));
    await waitFor(() => {
      expect(app.clipboard() !== null).toBe(true);
    });
    const copied = JSON.parse(app.clipboard() ?? '') as CopiedClientConfig;
    const serverHeaders = copied.mcpServers['alpha-stdio'].headers;
    expect(serverHeaders.Authorization).not.toBe(`Bearer ${globalToken}`);

    // Legacy stateful 2025-11-25 initialize -> mcp-session-id -> notifications/initialized -> tools/call
    const initRes = await postJsonRpc(endpointUrl, serverHeaders, {
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e-legacy-client', version: '1.0.0' },
      },
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await parseJsonRpcResponse(initRes);

    const sessionHeaders = {
      ...serverHeaders,
      'mcp-session-id': sessionId ?? '',
      'mcp-protocol-version': '2025-11-25',
    };

    const notifyRes = await postJsonRpc(endpointUrl, sessionHeaders, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(notifyRes.status).toBe(202);
    await notifyRes.text();

    const legacyCallRes = await postJsonRpc(endpointUrl, sessionHeaders, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'echo_stdio',
        arguments: { text: 'legacy-session-ok' },
      },
    });
    expect(legacyCallRes.status).toBe(200);
    const legacyCallPayload = (await parseJsonRpcResponse(legacyCallRes)) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(JSON.parse(legacyCallPayload.result.content[0]?.text ?? '{}')).toEqual({
      text: 'legacy-session-ok',
      env: 'edit-lifecycle',
      argv: ['--initial'],
    });

    // Toggle server off via row <Switch /> -> 404 while gateway stays running
    fireEvent.click(view.getByRole('switch', { name: 'Stop' }));
    await view.findByRole('switch', { name: 'Start' });
    const disabledRes = await postModernJsonRpc(endpointUrl, serverHeaders, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/list',
      params: { _meta: modernMeta() },
    });
    expect(disabledRes.status).toBe(404);
    await disabledRes.text();

    // Toggle server back on -> remounted and returns 200
    fireEvent.click(view.getByRole('switch', { name: 'Start' }));
    await view.findByRole('switch', { name: 'Stop' });
    await waitFor(() => {
      expect(view.getByTitle('Mounted')).toBeTruthy();
    });
    const remountedRes = await postModernJsonRpc(endpointUrl, serverHeaders, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/list',
      params: { _meta: modernMeta() },
    });
    expect(remountedRes.status).toBe(200);
    await remountedRes.text();

    // Restart alpha-stdio from Overview and wait for the backend restart to finish
    fireEvent.click(view.getByRole('button', { name: 'Restart alpha-stdio' }));
    await waitFor(
      () => {
        const restarted = app.controller
          .readLogs({ after: 0 })
          .entries.some((entry) => entry.text === 'A backend endpoint was restarted.');
        const toggleButton = view.getByRole('button', {
          name: 'Stop gateway',
        }) as HTMLButtonElement;
        expect(restarted && !toggleButton.disabled).toBe(true);
      },
      { timeout: 10_000 },
    );
    const postRestartRes = await postModernJsonRpc(endpointUrl, serverHeaders, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/list',
      params: { _meta: modernMeta() },
    });
    expect(postRestartRes.status).toBe(200);
    await postRestartRes.text();

    // Delete alpha-stdio (confirmed via native dialog mock) -> removed from disk & 404
    fireEvent.click(view.getByRole('button', { name: 'Delete alpha-stdio' }));
    await view.findByText('No servers configured');

    const afterDeleteConfig = JSON.parse(await readFile(app.configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(afterDeleteConfig.mcpServers).toEqual({});

    // Once deleted, the old per-server token is rejected (401) and the global token sees 404.
    const deletedWithOldKey = await postModernJsonRpc(endpointUrl, serverHeaders, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/list',
      params: { _meta: modernMeta() },
    });
    expect(deletedWithOldKey.status).toBe(401);
    await deletedWithOldKey.text();

    const deletedWithGlobalKey = await postModernJsonRpc(
      endpointUrl,
      { Authorization: `Bearer ${globalToken}` },
      {
        jsonrpc: '2.0',
        id: 16,
        method: 'tools/list',
        params: { _meta: modernMeta() },
      },
    );
    expect(deletedWithGlobalKey.status).toBe(404);
    await deletedWithGlobalKey.text();
  }, 20_000);
});
