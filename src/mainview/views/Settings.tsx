import { Eye, EyeOff, Settings2 } from 'lucide-react';

import { Badge } from '@mcp-gateway/mainview/components/mac/badge';
import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import { Field, Toggle } from '@mcp-gateway/mainview/components/ui';
import type { AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { GatewayConfig, GatewaySnapshot } from '@mcp-gateway/shared/types';

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
                    {item.name}
                    {item.loopback ? ' · this computer only' : ' · LAN'}
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
            label="Bearer token"
            help="32–512 non-space ASCII characters. Client configurations include this secret."
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
            onClick={() => {
              const bytes = crypto.getRandomValues(new Uint8Array(32));
              setGateway({
                token: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
              });
            }}
          >
            Generate secure token
          </Button>
          <div className="startup-settings">
            <Toggle
              label="Launch app at login"
              description="While this is on, MCP Gateway opens in the background at every launch; open the window from the menu-bar icon."
              disabled={configurationLocked}
              checked={config.gateway.launchAtLogin ?? false}
              onChange={(value) => setGateway({ launchAtLogin: value })}
            />
            <div className="login-status">
              <Badge variant="secondary">
                Actual login registration:{' '}
                {snapshot.login.supported
                  ? snapshot.login.enabled
                    ? 'Enabled'
                    : 'Disabled'
                  : 'Unsupported'}
              </Badge>
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
