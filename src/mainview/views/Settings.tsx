import { Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import { Field, Toggle } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import { generateToken } from '@mcp-gateway/mainview/lib/token';
import type { MessageKey } from '@mcp-gateway/shared/i18n';
import type { AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { GatewayConfig, GatewaySnapshot, NetworkKind } from '@mcp-gateway/shared/types';

const NETWORK_LABELS: Record<NetworkKind, MessageKey> = {
  loopback: 'settings.networkKind.loopback',
  lan: 'settings.networkKind.lan',
  tailscale: 'settings.networkKind.tailscale',
  tunnel: 'settings.networkKind.tunnel',
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
  const { t } = useI18n();
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
          <h2>{t('settings.preferences')}</h2>
          <p>{t('settings.preferencesIntro', { filename })}</p>
        </div>
      </div>
      {config ? (
        <>
          <div className="form-grid">
            <Field label={t('settings.address')} help={t('settings.addressHelp')}>
              <Input
                aria-label={t('settings.address')}
                readOnly={configurationLocked}
                list="interfaces"
                value={config.gateway.host}
                onChange={(event) => setGateway({ host: event.target.value })}
              />
              <datalist id="interfaces">
                {gateway?.interfaces.map((item) => (
                  <option key={`${item.name}-${item.address}`} value={item.address}>
                    {item.name} · {t(NETWORK_LABELS[item.kind])}
                  </option>
                ))}
              </datalist>
            </Field>
            <Field label={t('settings.port')}>
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
          <Field label={t('settings.peers')} help={t('settings.peersHelp')}>
            <Input
              autoComplete="off"
              readOnly={configurationLocked}
              spellCheck={false}
              placeholder={t('settings.peersPlaceholder')}
              value={peersShown}
              // Native validation checks every entry on save.
              onChange={(event) => {
                setPeersText(event.target.value);
                setGateway({ allowedPeers: peerList(event.target.value) });
              }}
            />
          </Field>
          <Field label={t('settings.token')} help={t('settings.tokenHelp')}>
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
                aria-label={showToken ? t('settings.hideToken') : t('settings.showToken')}
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
            {t('settings.generateToken')}
          </Button>
          <div className="startup-settings">
            <Toggle
              label={t('settings.launchAtLogin')}
              description={t('settings.launchAtLoginDescription')}
              disabled={configurationLocked}
              checked={config.gateway.launchAtLogin ?? false}
              onChange={(value) => setGateway({ launchAtLogin: value })}
            />
            <div className="login-status">
              <p className="login-state">
                <span
                  className={`led ${snapshot.login.supported && snapshot.login.enabled ? 'on' : ''}`}
                />
                {!snapshot.login.supported
                  ? t('settings.loginItemUnsupported')
                  : snapshot.login.enabled
                    ? t('settings.loginItemEnabled')
                    : t('settings.loginItemDisabled')}
              </p>
              {snapshot.login.error && <p className="inline-error">{snapshot.login.error}</p>}
              <small>{t('settings.loginItemNote')}</small>
            </div>
            <Toggle
              label={t('settings.autoStart')}
              disabled={configurationLocked}
              description={t('settings.autoStartDescription')}
              checked={config.gateway.autoStart ?? false}
              onChange={(value) => setGateway({ autoStart: value })}
            />
            <Toggle
              label={t('settings.keepAwake')}
              description={t('settings.keepAwakeDescription')}
              disabled={configurationLocked}
              checked={config.gateway.keepAwake ?? false}
              onChange={(value) => setGateway({ keepAwake: value || undefined })}
            />
          </div>
        </>
      ) : (
        <p>{t('settings.paused')}</p>
      )}
    </section>
  );
};
