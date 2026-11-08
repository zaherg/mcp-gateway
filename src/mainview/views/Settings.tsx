import { Eye, EyeOff, Settings2 } from "lucide-react";
import type { AppSnapshot } from "../../shared/rpc";
import type { GatewayConfig, GatewaySnapshot } from "../../shared/types";
import { Field, Toggle } from "../components/ui";

export function Settings({
  config,
  gateway,
  snapshot,
  configurationLocked,
  update,
  showToken,
  setShowToken,
  filename,
}: {
  config: GatewayConfig | null;
  gateway: GatewaySnapshot | undefined;
  snapshot: AppSnapshot;
  configurationLocked: boolean;
  update: (config: GatewayConfig) => void;
  showToken: boolean;
  setShowToken: (show: boolean) => void;
  filename: string;
}) {
  return (
    <section className="panel settings-panel">
      <div className="section-heading">
        <div>
          <h2>Gateway preferences</h2>
          <p>Changes take effect after saving the full {filename}.</p>
        </div>
        <Settings2 size={20} />
      </div>
      {config ? (
        <>
          <div className="form-grid">
            <Field
              label="Interface / address"
              help="Select a local IPv4 interface. Loopback is available only on this computer."
            >
              <input
                aria-label="Interface / address"
                readOnly={configurationLocked}
                list="interfaces"
                value={config.gateway.host}
                onChange={(event) =>
                  update({
                    ...config,
                    gateway: { ...config.gateway, host: event.target.value },
                  })
                }
              />
              <datalist id="interfaces">
                {gateway?.interfaces.map((item) => (
                  <option key={`${item.name}-${item.address}`} value={item.address}>
                    {item.name}
                    {item.loopback ? " · this computer only" : " · LAN"}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="Port">
              <input
                type="number"
                readOnly={configurationLocked}
                min="1"
                max="65535"
                value={config.gateway.port === 0 ? "" : config.gateway.port}
                onChange={(event) =>
                  update({
                    ...config,
                    // Keep an empty port editable; zero is explicitly rejected by native validation.
                    gateway: {
                      ...config.gateway,
                      port: event.target.value === "" ? 0 : event.target.valueAsNumber,
                    },
                  })
                }
              />
            </Field>
          </div>
          <Field
            label="Bearer token"
            help="32–512 non-space ASCII characters. Client configurations include this secret."
          >
            <div className="token-input">
              <input
                autoComplete="off"
                readOnly={configurationLocked}
                spellCheck={false}
                type={showToken ? "text" : "password"}
                value={config.gateway.token}
                onChange={(event) =>
                  update({
                    ...config,
                    gateway: { ...config.gateway, token: event.target.value },
                  })
                }
              />
              <button
                type="button"
                className="icon-button"
                aria-label={showToken ? "Hide bearer token" : "Show bearer token"}
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </Field>
          <button
            type="button"
            className="button small"
            disabled={configurationLocked}
            onClick={() => {
              const bytes = crypto.getRandomValues(new Uint8Array(32));
              update({
                ...config,
                gateway: {
                  ...config.gateway,
                  token: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
                },
              });
            }}
          >
            Generate secure token
          </button>
          <div className="startup-settings">
            <Toggle
              label="Launch app at login"
              description="Open MCP Gateway in the background when you sign in to macOS."
              disabled={configurationLocked}
              checked={config.gateway.launchAtLogin ?? false}
              onChange={(value) =>
                update({
                  ...config,
                  gateway: { ...config.gateway, launchAtLogin: value },
                })
              }
            />
            <div className="login-status">
              <span className="badge">
                Actual login registration:{" "}
                {snapshot.login.supported
                  ? snapshot.login.enabled
                    ? "Enabled"
                    : "Disabled"
                  : "Unsupported"}
              </span>
              {snapshot.login.error && <p className="inline-error">{snapshot.login.error}</p>}
              <small>
                Desired setting above is separate from the actual macOS registration shown here.
              </small>
            </div>
            <Toggle
              label="Start gateway when the app opens"
              disabled={configurationLocked}
              description="Begin listening automatically, independently of login startup."
              checked={config.gateway.autoStart ?? false}
              onChange={(value) =>
                update({ ...config, gateway: { ...config.gateway, autoStart: value } })
              }
            />
          </div>
        </>
      ) : (
        <p>Structured preferences are paused until the configuration is repaired.</p>
      )}
    </section>
  );
}
