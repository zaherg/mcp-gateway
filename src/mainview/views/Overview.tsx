import {
  ArrowUpRight,
  CircleHelp,
  Code2,
  Copy,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { Badge } from '@mcp-gateway/mainview/components/mac/badge';
import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { bearPreset, type Editor, emptyEditor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import type { AppClient, AppResult, AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { GatewayConfig, GatewaySnapshot } from '@mcp-gateway/shared/types';

type Run = (
  operation: () => Promise<AppResult<AppSnapshot | null>>,
  message: string,
  saved?: boolean,
) => Promise<boolean>;

const SERVER_STATUS = {
  mounted: { label: 'Mounted', variant: 'accent' },
  error: { label: 'Error', variant: 'danger' },
  disabled: { label: 'Disabled', variant: 'secondary' },
  stopped: { label: 'Stopped', variant: 'secondary' },
} as const;

export const Overview = ({
  gateway,
  config,
  dirty,
  configurationLocked,
  run,
  client,
  openEditor,
  toggleEndpoint,
  setDeleting,
  setEditor,
  setEditorError,
}: {
  gateway: GatewaySnapshot | undefined;
  config: GatewayConfig | null;
  dirty: boolean;
  configurationLocked: boolean;
  run: Run;
  client: AppClient;
  openEditor: (name?: string) => void;
  toggleEndpoint: (name: string, disabled: boolean) => Promise<void>;
  setDeleting: (name: string | null) => void;
  setEditor: (editor: Editor | null) => void;
  setEditorError: (error: string | null) => void;
}) => {
  return (
    <>
      <section aria-labelledby="servers-heading">
        <div className="section-heading">
          <div>
            <h2 id="servers-heading">
              Your servers{' '}
              <Badge variant="secondary">
                {config ? Object.keys(config.mcpServers).length : '?'}
              </Badge>
            </h2>
            <p>A separate endpoint for each configured MCP server.</p>
          </div>
          <Button
            variant="default"
            disabled={configurationLocked || !config}
            onClick={() => openEditor()}
          >
            <Plus /> Add server
          </Button>
        </div>
        <div className="server-grid">
          {config &&
            Object.entries(config.mcpServers).map(([name, server]) => {
              const live = gateway?.servers.find((item) => item.name === name);
              const status = live?.status ?? (server.disabled ? 'disabled' : 'stopped');
              const badge = SERVER_STATUS[status];
              const http = 'url' in server;
              return (
                <article className="server-card panel" key={name}>
                  <div className="card-heading">
                    <h3>{name}</h3>
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  </div>
                  <p className="transport">{http ? 'STREAMABLE HTTP' : 'LOCAL STDIO'}</p>
                  <p className="server-detail mono" title={http ? server.url : server.command}>
                    {http ? server.url : server.command}
                  </p>
                  <div className="endpoint">
                    <span className="mono">/mcp/{name}</span>
                    <Button
                      variant="ghost"
                      size="icon-lg"
                      aria-label={`Copy endpoint for ${name}`}
                      disabled={!live || dirty}
                      onClick={() =>
                        void run(
                          () => client.copyEndpoint({ name }),
                          'Endpoint copied to clipboard.',
                        )
                      }
                    >
                      <Copy />
                    </Button>
                  </div>
                  {live?.error && <p className="inline-error">{live.error.message}</p>}
                  <div className="card-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={configurationLocked}
                      onClick={() => openEditor(name)}
                    >
                      Edit server
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={configurationLocked || dirty || !!gateway?.configError}
                      onClick={() => void toggleEndpoint(name, !server.disabled)}
                    >
                      {server.disabled ? 'Start' : 'Stop'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-lg"
                      aria-label={`Restart ${name}`}
                      disabled={
                        configurationLocked ||
                        dirty ||
                        !gateway?.running ||
                        server.disabled ||
                        !!gateway?.configError
                      }
                      onClick={() =>
                        void run(() => client.restartServer({ name }), `${name} restarted.`)
                      }
                    >
                      <RefreshCw />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-lg"
                      aria-label={`Delete ${name}`}
                      disabled={configurationLocked}
                      onClick={() => {
                        if (!configurationLocked) setDeleting(name);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <button
                    type="button"
                    className="client-copy"
                    disabled={!live || dirty}
                    onClick={() =>
                      void run(
                        () => client.copyClientConfig({ name }),
                        'Client configuration copied. It contains your bearer token; keep it private.',
                      )
                    }
                  >
                    <Code2 size={14} /> Copy client configuration <ArrowUpRight size={13} />
                  </button>
                </article>
              );
            })}
        </div>
        {config && Object.keys(config.mcpServers).length === 0 && (
          <div className="empty-state panel">
            <div className="empty-icon">
              <Server size={29} />
            </div>
            <h3>No servers configured</h3>
            <p>
              Add a local command or an existing HTTP server.
              <br />
              Each gets its own shareable MCP endpoint.
            </p>
            <Button
              disabled={configurationLocked}
              onClick={() => {
                if (configurationLocked) return;
                setEditorError(null);
                setEditor({ ...emptyEditor(), ...bearPreset() });
              }}
            >
              Use macOS Bear preset <ArrowUpRight />
            </Button>
            <small>Optional, macOS only. Bear can expose all accessible notes and tools.</small>
          </div>
        )}
        {!config && (
          <div className="panel empty-state">
            <Code2 size={26} />
            <h3>Repair configuration to continue</h3>
            <p>
              No defaults have been substituted. Your original configuration text remains available
              below.
            </p>
          </div>
        )}
        <p className="fine-print">
          <CircleHelp size={14} /> Mounted means the route is available, not that a backend
          handshake has succeeded. Endpoint Start/Stop saves its enabled state; starting the gateway
          is separate.
        </p>
      </section>
      <section className="network-note">
        <ShieldCheck size={22} />
        <div>
          <h3>A local network, not a private tunnel.</h3>
          <p>
            LAN traffic uses unencrypted HTTP, including the bearer token and tool data. Use only a
            trusted network. Keep this computer awake for access; DHCP can change its address.
            Remote-device reachability is not verified here.
          </p>
        </div>
      </section>
    </>
  );
};
