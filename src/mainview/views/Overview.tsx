import {
  ArrowUpRight,
  CircleHelp,
  Code2,
  Copy,
  Globe,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import type { AppClient, AppResult, AppSnapshot } from "../../shared/rpc";
import type { GatewayConfig, GatewaySnapshot } from "../../shared/types";
import { type Editor, emptyEditor } from "../dialogs/ServerEditor";

type Run = (
  operation: () => Promise<AppResult<AppSnapshot | null>>,
  message: string,
  saved?: boolean,
) => Promise<boolean>;

export function Overview({
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
}) {
  return (
    <>
      <section aria-labelledby="servers-heading">
        <div className="section-heading">
          <div>
            <h2 id="servers-heading">
              Your servers{" "}
              <span className="count">{config ? Object.keys(config.mcpServers).length : "?"}</span>
            </h2>
            <p>A separate endpoint for each configured MCP server.</p>
          </div>
          <button
            type="button"
            className="button primary"
            disabled={configurationLocked || !config}
            onClick={() => openEditor()}
          >
            <Plus size={16} /> Add server
          </button>
        </div>
        <div className="server-grid">
          {config &&
            Object.entries(config.mcpServers).map(([name, server]) => {
              const live = gateway?.servers.find((item) => item.name === name);
              const status = live?.status ?? (server.disabled ? "disabled" : "stopped");
              const http = "url" in server;
              return (
                <article className="server-card panel" key={name}>
                  <div className="card-top">
                    <span className={`server-icon ${http ? "blue" : ""}`}>
                      {http ? <Globe size={21} /> : <Terminal size={21} />}
                    </span>
                    <span
                      className={`badge ${status === "mounted" ? "teal" : status === "error" ? "red" : ""}`}
                    >
                      {status === "mounted"
                        ? "Mounted"
                        : status === "disabled"
                          ? "Disabled"
                          : status === "error"
                            ? "Error"
                            : "Stopped"}
                    </span>
                  </div>
                  <h3>{name}</h3>
                  <p className="transport">{http ? "STREAMABLE HTTP" : "LOCAL STDIO"}</p>
                  <p className="server-detail mono" title={http ? server.url : server.command}>
                    {http ? server.url : server.command}
                  </p>
                  <div className="endpoint">
                    <span className="mono">/mcp/{name}</span>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Copy endpoint for ${name}`}
                      disabled={!live || dirty}
                      onClick={() =>
                        void run(
                          () => client.copyEndpoint({ name }),
                          "Endpoint copied to clipboard.",
                        )
                      }
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                  {live?.error && <p className="inline-error">{live.error.message}</p>}
                  <div className="card-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={configurationLocked}
                      onClick={() => openEditor(name)}
                    >
                      Edit server
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={configurationLocked || dirty || !!gateway?.configError}
                      onClick={() => void toggleEndpoint(name, !server.disabled)}
                    >
                      {server.disabled ? "Start" : "Stop"}
                    </button>
                    <button
                      type="button"
                      className="icon-button"
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
                      <RefreshCw size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete ${name}`}
                      disabled={configurationLocked}
                      onClick={() => {
                        if (!configurationLocked) setDeleting(name);
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="client-copy"
                    disabled={!live || dirty}
                    onClick={() =>
                      void run(
                        () => client.copyClientConfig({ name }),
                        "Client configuration copied. It contains your bearer token; keep it private.",
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
            <button
              type="button"
              className="button"
              disabled={configurationLocked}
              onClick={() => {
                if (configurationLocked) return;
                const preset = emptyEditor();
                preset.name = "bear";
                preset.command = "/Applications/Bear.app/Contents/MacOS/bearcli";
                preset.args = '["mcp-server"]';
                setEditorError(null);
                setEditor(preset);
              }}
            >
              Use macOS Bear preset <ArrowUpRight size={14} />
            </button>
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
}
