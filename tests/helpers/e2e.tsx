import { afterEach } from 'bun:test';
import { chmod, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import { type RenderResult, render } from '@testing-library/react';

import { MODERN_VERSION } from '@mcp-gateway/core/adapter';
import { McpGatewayController } from '@mcp-gateway/core/controller';
import type { PreventIdleSleep } from '@mcp-gateway/core/ingress';
import type { UpdateRuntime } from '@mcp-gateway/main/app-updater';
import { AppearanceStore } from '@mcp-gateway/main/appearance';
import { KeyReminderStore } from '@mcp-gateway/main/key-reminder';
import { LanguageStore } from '@mcp-gateway/main/language';
import { AppService, type LoginManager } from '@mcp-gateway/main/service';
import { WhatsNewStore } from '@mcp-gateway/main/whats-new';
import { I18nProvider } from '@mcp-gateway/mainview/i18n';
import { isRecord } from '@mcp-gateway/shared/config-document';
import { CATALOG_LOCALES } from '@mcp-gateway/shared/i18n';
import type {
  AppClient,
  AppSnapshot,
  LoginStatus,
  MenuCommand,
  QuitStatus,
} from '@mcp-gateway/shared/rpc';
import type { KeyStore } from '@mcp-gateway/shared/types';
import { registerTempDirLifecycle } from './core';
import { installDomEnvironment } from './dom';
import { closeServer, listen, readBodyText } from './http-mount';
import { makeUpdateStatus, setNavigatorLanguages } from './mainview';

const activeCleanups: Array<() => Promise<void> | void> = [];

// Registered before `registerTempDirLifecycle` so DOM, controllers, and HTTP fixtures close
// before temp directories are removed (no lingering FSWatchers, sockets, or child processes).
afterEach(async () => {
  while (activeCleanups.length > 0) {
    const cleanup = activeCleanups.pop();
    if (cleanup) await cleanup();
  }
});

const { makeTempDir } = registerTempDirLifecycle('mcp-gateway-e2e-');

export const reserveLoopbackPort = async () => {
  const server = createServer();
  try {
    return await listen(server);
  } finally {
    await closeServer(server);
  }
};

// Single-line script (no newlines or `//` comments) so HTML `<input>` fields preserve it verbatim.
export const STDIO_MCP_SERVER_SCRIPT = [
  "let b='';",
  "process.stdin.setEncoding('utf8');",
  "const w=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');",
  "process.stdin.on('data',(c)=>{",
  'b+=c;let i;',
  "while((i=b.indexOf('\\n'))>=0){",
  'const l=b.slice(0,i).trim();b=b.slice(i+1);if(!l)continue;',
  'const m=JSON.parse(l);',
  `if(m.method==='server/discover'){w({jsonrpc:'2.0',id:m.id,result:{supportedVersions:['${MODERN_VERSION}'],protocolVersion:'${MODERN_VERSION}',capabilities:{tools:{}},serverInfo:{name:'e2e-stdio',version:'1.0.0'}}});}`,
  `else if(m.method==='initialize'){w({jsonrpc:'2.0',id:m.id,result:{protocolVersion:m.params?.protocolVersion??'${MODERN_VERSION}',capabilities:{tools:{}},serverInfo:{name:'e2e-stdio',version:'1.0.0'}}});}`,
  "else if(m.method==='notifications/initialized'){}",
  "else if(m.method==='ping'){w({jsonrpc:'2.0',id:m.id,result:{}});}",
  "else if(m.method==='tools/list'){w({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo_stdio',description:'Echo stdio input and env',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}});}",
  "else if(m.method==='tools/call'){w({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify({text:m.params?.arguments?.text??null,env:process.env.E2E_MODE??null,argv:process.argv.slice(1)})}]}});}",
  "else if(m.id!==undefined){w({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Method not found'}});}",
  '}',
  '});',
].join(' ');

export interface RecordedUpstreamRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface UpstreamHttpMcpServer {
  url: string;
  requests: RecordedUpstreamRequest[];
  close: () => Promise<void>;
}

const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

export const startUpstreamHttpMcpServer = async () => {
  const requests: RecordedUpstreamRequest[] = [];
  const handlePost = async (req: IncomingMessage, res: ServerResponse) => {
    const raw = await readBodyText(req);
    const body: unknown = raw.length > 0 ? JSON.parse(raw) : null;
    requests.push({ method: req.method ?? 'POST', headers: { ...req.headers }, body });
    if (!isRecord(body)) {
      res.writeHead(400).end();
      return;
    }
    const method = typeof body.method === 'string' ? body.method : '';
    const params = isRecord(body.params) ? body.params : undefined;
    if (method === 'server/discover') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          supportedVersions: [MODERN_VERSION],
          protocolVersion: MODERN_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'e2e-http', version: '1.0.0' },
        },
      });
    } else if (method === 'initialize') {
      const requested =
        typeof params?.protocolVersion === 'string' ? params.protocolVersion : MODERN_VERSION;
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: 'e2e-http', version: '1.0.0' },
        },
      });
    } else if (method === 'notifications/initialized') {
      res.writeHead(202).end();
    } else if (method === 'ping') {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: {} });
    } else if (method === 'tools/list') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            {
              name: 'echo_http',
              description: 'Echo HTTP input and upstream key header',
              inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
            },
          ],
        },
      });
    } else if (method === 'tools/call') {
      const args = isRecord(params?.arguments) ? params.arguments : undefined;
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                text: args?.text ?? null,
                upstreamKey: req.headers['x-upstream-key'] ?? null,
              }),
            },
          ],
        },
      });
    } else {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: 'Method not found' },
      });
    }
  };

  const server = createServer((req, res) => {
    if (req.method === 'DELETE') {
      requests.push({ method: 'DELETE', headers: { ...req.headers }, body: null });
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    void handlePost(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  const port = await listen(server);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await closeServer(server);
  };
  activeCleanups.push(close);

  return { url: `http://127.0.0.1:${port}/mcp`, requests, close };
};

export const createMemoryKeyStore = () => {
  const entries = new Map<string, string>();
  const store: KeyStore = {
    get: async (refs) => {
      const resolved = new Map<string, string>();
      for (const ref of refs) {
        const value = entries.get(ref);
        if (value !== undefined) resolved.set(ref, value);
      }
      return resolved;
    },
    set: async (ref, value) => {
      if (value.length === 0) throw new Error('Keychain value cannot be empty.');
      entries.set(ref, value);
    },
  };
  return { store, entries };
};

export interface BootFullStackOptions {
  initialConfigText?: string;
  withKeyStore?: boolean;
  confirmDeleteResult?: boolean;
  confirmDiscardResult?: boolean;
  existingInstall?: boolean;
}

export interface FullStackAppHarness {
  view: RenderResult;
  dataDirectory: string;
  configPath: string;
  port: number;
  controller: McpGatewayController;
  service: AppService;
  client: AppClient;
  keyStore: { store: KeyStore; entries: Map<string, string> } | undefined;
  clipboard: () => string | null;
  sleepAssertions: { active: number; total: number };
  setConfirmDelete: (value: boolean) => void;
  setConfirmDiscard: (value: boolean) => void;
  emitMenuCommand: (command: MenuCommand) => void;
}

export const bootFullStackApp = async (
  options: BootFullStackOptions = {},
): Promise<FullStackAppHarness> => {
  const dataDirectory = await makeTempDir();
  await chmod(dataDirectory, 0o700);
  const configPath = join(dataDirectory, 'mcp.json');
  if (options.initialConfigText !== undefined) {
    await writeFile(configPath, options.initialConfigText, { mode: 0o600 });
    await chmod(configPath, 0o600);
  }

  const reservedPort = await reserveLoopbackPort();
  const keyStore = options.withKeyStore ? createMemoryKeyStore() : undefined;
  const sleepAssertions = { active: 0, total: 0 };
  const preventIdleSleep: PreventIdleSleep = () => {
    let released = false;
    sleepAssertions.active += 1;
    sleepAssertions.total += 1;
    return () => {
      if (released) return;
      released = true;
      sleepAssertions.active -= 1;
    };
  };

  const controller = await McpGatewayController.open(
    configPath,
    preventIdleSleep,
    keyStore?.store,
    reservedPort,
  );
  activeCleanups.push(() => controller.close());

  const existingInstall = options.existingInstall ?? false;
  const keyReminder = await KeyReminderStore.open(dataDirectory, existingInstall);
  const language = await LanguageStore.open(dataDirectory, 'en_US', [...CATALOG_LOCALES]);
  const appearance = await AppearanceStore.open(dataDirectory);
  // Pass `false` so `<WhatsNew />` never covers `<Overview />` when `existingInstall` is used
  // to test the plaintext key reminder banner.
  const whatsNew = await WhatsNewStore.open(dataDirectory, '0.9.0', false);

  let lastCopiedText: string | null = null;
  let confirmDeleteResult = options.confirmDeleteResult ?? true;
  let confirmDiscardResult = options.confirmDiscardResult ?? true;
  let loginStatus: LoginStatus = { enabled: false, supported: true, error: null };
  const idleQuit: QuitStatus = { attempt: 0, phase: 'idle', error: null };
  let updateStatus = makeUpdateStatus();

  const login: LoginManager = {
    status: () => ({ ...loginStatus }),
    setEnabled: (enabled) => {
      loginStatus = { ...loginStatus, enabled };
      return { ...loginStatus };
    },
  };

  const updates: UpdateRuntime = {
    status: () => ({ ...updateStatus }),
    check: async () => ({ ...updateStatus }),
    download: async () => ({ ...updateStatus }),
    installUpdate: async () => ({ ...updateStatus }),
    setAutomatic: async (automatic) => {
      updateStatus = { ...updateStatus, automaticUpdates: automatic };
      return { ...updateStatus };
    },
    restart: async () => idleQuit,
    start: async () => ({ ...updateStatus }),
    stop: () => undefined,
    subscribe: () => () => undefined,
  };

  const service = new AppService(
    controller,
    login,
    (text) => {
      lastCopiedText = text;
    },
    {
      requestQuit: () => idleQuit,
      quitStatus: () => idleQuit,
      openExternal: () => true,
      showItemInFolder: () => undefined,
      openPath: () => true,
      confirmDiscard: async () => confirmDiscardResult,
      confirmDeleteServer: async () => confirmDeleteResult,
      whatsNew: () => whatsNew.pending,
      dismissWhatsNew: () => whatsNew.dismiss(),
      keyReminderRetired: () => keyReminder.retired,
      retireKeyReminder: () => keyReminder.retire(),
      language: () => language.state,
      setLanguage: (preference) => language.set(preference),
      appearance: () => appearance.preference,
      setAppearance: (preference) => appearance.set(preference),
    },
    updates,
  );

  const snapshotListeners = new Set<(snapshot: AppSnapshot) => void>();
  const menuListeners = new Set<(command: MenuCommand) => void>();
  const pushSnapshot = () => {
    const next = service.currentSnapshot();
    for (const listener of snapshotListeners) listener(next);
  };
  const wrapHandler = <Args extends unknown[], Res>(handler: (...args: Args) => Promise<Res>) => {
    return async (...args: Args) => {
      const result = await handler(...args);
      pushSnapshot();
      return result;
    };
  };

  const { handlers } = service;
  const client: AppClient = {
    readLogs: (params) => handlers.readLogs(params),
    clearLogs: () => handlers.clearLogs(),
    snapshot: () => handlers.snapshot(),
    quit: () => handlers.quit(),
    quitStatus: () => handlers.quitStatus(),
    start: wrapHandler(() => handlers.start()),
    stop: wrapHandler(() => handlers.stop()),
    testServer: (params) => handlers.testServer(params),
    saveConfig: wrapHandler((params) => handlers.saveConfig(params)),
    migrateKeys: wrapHandler((params) => handlers.migrateKeys(params)),
    dismissKeyReminder: wrapHandler(() => handlers.dismissKeyReminder()),
    validateConfig: (params) => handlers.validateConfig(params),
    confirmDiscard: () => handlers.confirmDiscard(),
    confirmDeleteServer: (params) => handlers.confirmDeleteServer(params),
    copyEndpoint: (params) => handlers.copyEndpoint(params),
    copyClientConfig: (params) => handlers.copyClientConfig(params),
    openSocialLink: (params) => handlers.openSocialLink(params),
    revealConfig: () => handlers.revealConfig(),
    openConfigInEditor: () => handlers.openConfigInEditor(),
    importExternalServers: wrapHandler((params) => handlers.importExternalServers(params)),
    dismissWhatsNew: wrapHandler(() => handlers.dismissWhatsNew()),
    updatesCheck: wrapHandler(() => handlers.updatesCheck()),
    updatesDownload: wrapHandler(() => handlers.updatesDownload()),
    updatesInstall: wrapHandler(() => handlers.updatesInstall()),
    updatesSetAutomatic: wrapHandler((params) => handlers.updatesSetAutomatic(params)),
    setLanguage: wrapHandler((params) => handlers.setLanguage(params)),
    setAppearance: wrapHandler((params) => handlers.setAppearance(params)),
    updatesRestart: wrapHandler(() => handlers.updatesRestart()),
    onSnapshotChanged: (listener) => {
      snapshotListeners.add(listener);
      return () => {
        snapshotListeners.delete(listener);
      };
    },
    onMenuCommand: (listener) => {
      menuListeners.add(listener);
      return () => {
        menuListeners.delete(listener);
      };
    },
  };

  // Install Happy-DOM before importing `<App />` so `electrobun/view` sees `window.__electrobun`
  // and Base UI primitives (`<Switch />`, `<Checkbox />`) see `requestAnimationFrame`.
  const teardownDom = installDomEnvironment();
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: window.requestAnimationFrame.bind(window),
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: window.cancelAnimationFrame.bind(window),
  });
  setNavigatorLanguages(['en-US']);
  document.title = 'MCP Gateway';
  (window as unknown as Record<string, unknown>).__electrobun ??= {};
  const { App } = await import('@mcp-gateway/mainview/App');
  const view = render(
    <I18nProvider>
      <App client={client} />
    </I18nProvider>,
  );
  activeCleanups.push(() => teardownDom());

  return {
    view,
    dataDirectory,
    configPath,
    port: controller.activeConfig()?.gateway.port ?? reservedPort,
    controller,
    service,
    client,
    keyStore,
    clipboard: () => lastCopiedText,
    sleepAssertions,
    setConfirmDelete: (value) => {
      confirmDeleteResult = value;
    },
    setConfirmDiscard: (value) => {
      confirmDiscardResult = value;
    },
    emitMenuCommand: (command) => {
      for (const listener of menuListeners) listener(command);
    },
  };
};
