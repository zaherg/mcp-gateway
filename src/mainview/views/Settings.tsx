import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import { Field, Toggle } from '@mcp-gateway/mainview/components/ui';
import { generateToken } from '@mcp-gateway/mainview/lib/token';
import type { AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { GatewayConfig, GatewaySnapshot, NetworkKind } from '@mcp-gateway/shared/types';

const NETWORK_LABELS: Record<NetworkKind, string> = {
  loopback: 'this computer only',
  lan: 'LAN',
  tailscale: 'Tailscale',
  tunnel: 'VPN tunnel',
};

/** Comma-separated field text as a list of ranges; an empty field removes the property. */
const peerList = (text: string): string[] | undefined => {
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
};

interface Settings {
  config: GatewayConfig | null;
  gateway: GatewaySnapshot | undefined;
  snapshot: AppSnapshot;
  configurationLocked: boolean;
  update: (config: GatewayConfig) => void;
  showToken: boolean;
  setShowToken: (show: boolean) => void;
  filename: string;
}

export const Settings = ({
  config,
  gateway,
  snapshot,
  configurationLocked,
  update,
  showToken,
  setShowToken,
  filename,
}: Settings) => {
  const setGateway = (patch: Partial<GatewayConfig['gateway']>) => {
    if (config) update({ ...config, gateway: { ...config.gateway, ...patch } });
  };
  const [peersText, setPeersText] = useState('');
  const peers = config?.gateway.allowedPeers;
  // The typed text stays while it still means the configured list, so separators are not
  // rewritten under the caret; a discard, reset or raw edit shows the configured list.
  const peersShown =
    JSON.stringify(peerList(peersText)) === JSON.stringify(peers)
      ? peersText
      : (peers?.join(', ') ?? '');
  return (
    <section className="panel settings-panel">
      <div className="section-heading">
        <div>
          <h2>Gateway preferences</h2>
          <p>Changes take effect after saving the full {filename}</p>
        </div>
      </div>
      {config ? (
        <>
          <div className="form-grid">
            <Field
              label="Interface / address"
              help="A LAN, Tailscale or WireGuard address on this Mac. Loopback is local only."
            >
              <Input
                aria-label="Interface / address"
                readOnly={configurationLocked}
                list="interfaces"
                value={config.gateway.host}
                onChange={(event) => setGateway({ host: event.target.value })}
              />
              <datalist id="interfaces">
                {gateway?.interfaces.map((item) => (
                  <option key={`${item.name}-${item.address}`} value={item.address}>
                    {item.name} · {NETWORK_LABELS[item.kind]}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label="Port">
              <Input
                type="number"
                readOnly={configurationLocked}
                min="1"
                max="65535"
                value={config.gateway.port === 0 ? '' : config.gateway.port}
                // Keep an empty port editable; zero is explicitly rejected by native validation.
                onChange={(event) =>
                  setGateway({ port: event.target.value === '' ? 0 : event.target.valueAsNumber })
                }
              />
            </Field>
          </div>
          <Field
            label="Allowed client ranges"
            help="IPv4 ranges, comma separated, such as 100.64.0.0/10. Required for a 100.64.0.0/10 address. When set, only these clients are accepted."
          >
            <Input
              autoComplete="off"
              readOnly={configurationLocked}
              spellCheck={false}
              placeholder="Selected interface's subnet"
              value={peersShown}
              // Native validation checks every entry on save.
              onChange={(event) => {
                setPeersText(event.target.value);
                setGateway({ allowedPeers: peerList(event.target.value) });
              }}
            />
          </Field>
          <Field
            label="Global bearer token"
            help="Used by servers without their own key. 32 to 512 printable ASCII characters without spaces. Client configurations include this secret."
          >
            <div className="token-input">
              <Input
                autoComplete="off"
                readOnly={configurationLocked}
                spellCheck={false}
                type={showToken ? 'text' : 'password'}
                value={config.gateway.token}
                onChange={(event) => setGateway({ token: event.target.value })}
              />
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label={showToken ? 'Hide bearer token' : 'Show bearer token'}
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </Field>
          <Button
            size="lg"
            disabled={configurationLocked}
            onClick={() => setGateway({ token: generateToken() })}
          >
            Generate secure token
          </Button>
          <div className="startup-settings">
            <Toggle
              label="Launch app at login"
              description="Opens in the background at launch. Open the window from the menu bar."
              disabled={configurationLocked}
              checked={config.gateway.launchAtLogin ?? false}
              onChange={(value) => setGateway({ launchAtLogin: value })}
            />
            <div className="login-status">
              <p className="login-state">
                <span
                  className={`led ${snapshot.login.supported && snapshot.login.enabled ? 'on' : ''}`}
                />
                macOS login item:{' '}
                {snapshot.login.supported
                  ? snapshot.login.enabled
                    ? 'Enabled'
                    : 'Disabled'
                  : 'Unsupported'}
              </p>
              {snapshot.login.error && <p className="inline-error">{snapshot.login.error}</p>}
              <small>
                The setting above is a request; this is the registration macOS has in effect.
              </small>
            </div>
            <Toggle
              label="Start gateway when the app opens"
              disabled={configurationLocked}
              description="Begin listening automatically, independently of login startup."
              checked={config.gateway.autoStart ?? false}
              onChange={(value) => setGateway({ autoStart: value })}
            />
          </div>
        </>
      ) : (
        <p>Structured preferences are paused until the configuration is repaired.</p>
      )}
    </section>
  );
};
