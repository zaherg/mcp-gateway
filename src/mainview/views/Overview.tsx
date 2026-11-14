import { CircleHelp, Code2, Copy, RefreshCw, Server, ShieldCheck, Trash2 } from 'lucide-react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { bearPreset, type Editor, emptyEditor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import type { AppClient, AppResult, AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { GatewayConfig, GatewaySnapshot } from '@mcp-gateway/shared/types';

type Run = (
  operation: () => Promise<AppResult<AppSnapshot | null>>,
  message: string,
  saved?: boolean,
) => Promise<boolean>;

// The LED carries the state; the word names it.
const SERVER_STATUS = {
  mounted: { label: 'Mounted', led: 'on' },
  error: { label: 'Error', led: 'error' },
  disabled: { label: 'Disabled', led: '' },
  stopped: { label: 'Stopped', led: '' },
} as const;

interface Overview {
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
}

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
}: Overview) => {
  const serverCount = config ? Object.keys(config.mcpServers).length : 0;
  return (
    <>
      <section aria-labelledby="servers-heading">
        <div className="section-heading">
          <div>
            <h2 id="servers-heading">
              Servers
              {config && <span className="count">{serverCount}</span>}
            </h2>
            <p>A separate endpoint for each configured MCP server</p>
          </div>
          <Button
            variant="default"
            disabled={configurationLocked || !config}
            onClick={() => openEditor()}
          >
            Add server
          </Button>
        </div>
        <div className="server-grid">
          {config &&
            Object.entries(config.mcpServers).map(([name, server]) => {
              const live = gateway?.servers.find((item) => item.name === name);
              const status = live?.status ?? (server.disabled ? 'disabled' : 'stopped');
              const state = SERVER_STATUS[status];
              const http = 'url' in server;
              return (
                <article
                  className={status === 'error' ? 'server-card panel error' : 'server-card panel'}
                  key={name}
                >
                  <div className="card-heading">
                    <span className={`led ${state.led}`} />
                    <h3>{name}</h3>
                    <span className="card-meta">
                      {http ? 'Streamable HTTP' : 'Local stdio'} ·{' '}
                      <span className="card-status">{state.label}</span>
                    </span>
                  </div>
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
                  <p className="server-detail mono" title={http ? server.url : server.command}>
                    {http ? server.url : server.command}
                  </p>
                  {live?.error && <p className="inline-error">{live.error.message}</p>}
                  <div className="card-actions">
                    <Button
                      variant="ghost"
                      size="lg"
                      disabled={configurationLocked}
                      onClick={() => openEditor(name)}
                    >
                      Edit server
                    </Button>
                    <Button
                      variant="ghost"
                      size="lg"
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
                    <Copy size={14} />
                    Copy client configuration
                  </button>
                </article>
              );
            })}
        </div>
        {config && serverCount === 0 && (
          <div className="empty-state panel">
            <Server size={24} />
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
              Use macOS Bear preset
            </Button>
            <small>Optional, macOS only. Bear can expose all accessible notes and tools.</small>
          </div>
        )}
        {!config && (
          <div className="panel empty-state">
            <Code2 size={24} />
            <h3>Repair configuration to continue</h3>
            <p>
              No defaults have been substituted. Your original configuration text remains available
              below.
            </p>
          </div>
        )}
        <p className="fine-print">
          <CircleHelp size={16} /> Mounted means the endpoint is served, not that the backend
          handshake succeeded. Start and Stop save the server's enabled state; the gateway starts
          separately.
        </p>
      </section>
      <section className="network-note">
        <ShieldCheck size={16} />
        <div>
          <h3>HTTP is not encrypted</h3>
          <p>
            The gateway sends the bearer token and tool data in plain HTTP. On a LAN, use only a
            network you trust. On a Tailscale or WireGuard address, the tunnel carries the traffic,
            and every device in the allowed client ranges can reach these endpoints.
          </p>
          <p>
            Keep this computer awake for access: sleep takes the endpoints offline, and DHCP can
            change a LAN address. Reachability from other devices is not verified here.
          </p>
        </div>
      </section>
    </>
  );
};
