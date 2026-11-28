import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@mcp-gateway/mainview/components/mac/native-select';
import { Alert, Field, Toggle } from '@mcp-gateway/mainview/components/ui';
import { useGatewayView } from '@mcp-gateway/mainview/context/GatewayViewContext';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import { generateToken } from '@mcp-gateway/mainview/lib/token';
import {
  languageName,
  localeTag,
  type MessageKey,
  parseLanguagePreference,
} from '@mcp-gateway/shared/i18n';
import { needsLoginRetry, parseAppearancePreference } from '@mcp-gateway/shared/rpc';
import type { ConfigFile, NetworkKind } from '@mcp-gateway/shared/types';

const NETWORK_LABELS: Record<NetworkKind, MessageKey> = {
  loopback: 'settings.networkKind.loopback',
  lan: 'settings.networkKind.lan',
  tailscale: 'settings.networkKind.tailscale',
  tunnel: 'settings.networkKind.tunnel',
};

/**
 * Comma-separated field text as a list of ranges. A blank field removes the property; text
 * with no ranges, such as ", ,", stays an empty list so saving reports it instead of
 * silently dropping the restriction.
 */
const peerList = (text: string) => {
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return text.trim() ? entries : undefined;
};

export const Settings = () => {
  const {
    config,
    gateway,
    snapshot,
    dirty,
    busy,
    error,
    operationalError,
    clearError,
    dismissOperationalError,
    configurationLocked,
    commitConfig,
    showToken,
    setShowToken,
    filename,
    openKeyMigration,
    changeLanguage,
    changeAppearance,
    revealConfig,
    openConfigInEditor,
    importExternalServers,
  } = useGatewayView();
  const { t } = useI18n();
  const movable = gateway?.keyMigration;
  const setGateway = (patch: Partial<ConfigFile['gateway']>) => {
    if (config) void commitConfig({ ...config, gateway: { ...config.gateway, ...patch } });
  };
  const [hostInput, setHostInput] = useState(config?.gateway.host ?? '');
  const [portInput, setPortInput] = useState(
    config ? (config.gateway.port === 0 ? '' : String(config.gateway.port)) : '',
  );
  const [peersText, setPeersText] = useState(config?.gateway.allowedPeers?.join(', ') ?? '');
  const [tokenInput, setTokenInput] = useState(config?.gateway.token ?? '');
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const revision = gateway?.revision;
  const savedHost = config?.gateway.host ?? '';
  const savedPort = config ? (config.gateway.port === 0 ? '' : String(config.gateway.port)) : '';
  const savedPeers = config?.gateway.allowedPeers?.join(', ') ?? '';
  const savedToken = config?.gateway.token ?? '';

  // Sync local input drafts whenever the authoritative config revision or saved fields advance.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` triggers resync even if a field matches a previous revision.
  useEffect(() => {
    setHostInput(savedHost);
    setPortInput(savedPort);
    setPeersText(savedPeers);
    setTokenInput(savedToken);
  }, [revision, savedHost, savedPort, savedPeers, savedToken]);

  if (!snapshot) return null;

  const commitHost = () => {
    if (!config || configurationLocked || hostInput === config.gateway.host) return;
    setGateway({ host: hostInput });
  };

  const commitPort = () => {
    if (!config || configurationLocked) return;
    const nextPort = portInput.trim() === '' ? 0 : Number(portInput);
    if (Number.isNaN(nextPort) || nextPort === config.gateway.port) return;
    setGateway({ port: nextPort });
  };

  const commitPeers = () => {
    if (!config || configurationLocked) return;
    const nextPeers = peerList(peersText);
    if (JSON.stringify(nextPeers) === JSON.stringify(config.gateway.allowedPeers)) return;
    setGateway({ allowedPeers: nextPeers });
  };

  const commitToken = () => {
    if (!config || configurationLocked || tokenInput === (config.gateway.token ?? '')) return;
    setGateway({ token: tokenInput });
  };

  const handleImportExternal = async () => {
    if (configurationLocked || busy || dirty) return;
    const count = await importExternalServers();
    if (count === null) return;
    setImportStatus(
      count > 0
        ? `Imported ${count} server${count === 1 ? '' : 's'} from Claude Desktop / Cursor.`
        : 'No new servers found in Claude Desktop or Cursor.',
    );
  };

  const retryLogin = Boolean(
    config &&
      !gateway?.configError &&
      needsLoginRetry(snapshot.login, config.gateway.launchAtLogin ?? false),
  );

  return (
    <section className="panel settings-panel">
      {error && <Alert onDismiss={clearError}>{error}</Alert>}
      {operationalError && (
        <Alert onDismiss={dismissOperationalError}>
          {operationalError.code}: {operationalError.message}
        </Alert>
      )}
      <div className="section-heading">
        <div>
          <h2>{t('settings.preferences')}</h2>
          <p>{t('settings.preferencesIntro', { filename })}</p>
        </div>
      </div>
      {config ? (
        <div className="grid gap-4">
          <div className="settings-group">
            <h3>General</h3>
            <Toggle
              label={t('settings.launchAtLogin')}
              description={t('settings.launchAtLoginDescription')}
              disabled={configurationLocked}
              checked={config.gateway.launchAtLogin ?? false}
              onChange={(value) => setGateway({ launchAtLogin: value })}
            />
            <div className="login-status">
              <div className="min-w-0 flex-1">
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
              {retryLogin && (
                <Button
                  size="lg"
                  disabled={configurationLocked}
                  onClick={() =>
                    setGateway({ launchAtLogin: config.gateway.launchAtLogin ?? false })
                  }
                >
                  {t('draft.retryLogin')}
                </Button>
              )}
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
            <Field label={t('shell.appearanceLabel')} help={t('shell.appearanceHelp')} layout="row">
              <NativeSelect
                size="md"
                className="w-fit max-w-56 shrink-0"
                value={snapshot.appearance}
                disabled={configurationLocked || busy}
                onChange={(event) => {
                  const preference = parseAppearancePreference(event.target.value);
                  if (preference) changeAppearance(preference);
                }}
              >
                <NativeSelectOption value="system">
                  {t('shell.appearanceSystem')}
                </NativeSelectOption>
                <NativeSelectOption value="light">{t('shell.appearanceLight')}</NativeSelectOption>
                <NativeSelectOption value="dark">{t('shell.appearanceDark')}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field label={t('shell.languageLabel')} help={t('shell.languageHelp')} layout="row">
              <NativeSelect
                size="md"
                className="w-fit max-w-56 shrink-0"
                value={snapshot.language.preference}
                disabled={configurationLocked || busy}
                onChange={(event) => {
                  const preference = parseLanguagePreference(
                    event.target.value,
                    snapshot.language.available,
                  );
                  if (preference) changeLanguage(preference);
                }}
              >
                <NativeSelectOption value="system">{t('shell.languageSystem')}</NativeSelectOption>
                {snapshot.language.available.map((locale) => (
                  <NativeSelectOption key={locale} value={locale} lang={localeTag(locale)}>
                    {languageName(locale)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <div className="settings-group">
            <h3>Network</h3>
            <div className="form-grid">
              <Field label={t('settings.address')} help={t('settings.addressHelp')}>
                <Input
                  aria-label={t('settings.address')}
                  readOnly={configurationLocked}
                  list="interfaces"
                  value={hostInput}
                  onChange={(event) => setHostInput(event.target.value)}
                  onBlur={commitHost}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitHost();
                    }
                  }}
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
                  value={portInput}
                  // Keep an empty port editable; zero is explicitly rejected by native validation.
                  onChange={(event) => setPortInput(event.target.value)}
                  onBlur={commitPort}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitPort();
                    }
                  }}
                />
              </Field>
            </div>
            <Field label={t('settings.peers')} help={t('settings.peersHelp')}>
              <Input
                autoComplete="off"
                readOnly={configurationLocked}
                spellCheck={false}
                placeholder={t('settings.peersPlaceholder')}
                value={peersText}
                // Native validation checks every entry on save.
                onChange={(event) => setPeersText(event.target.value)}
                onBlur={commitPeers}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitPeers();
                  }
                }}
              />
            </Field>
          </div>
          <div className="settings-group">
            <h3>Security</h3>
            <Field label={t('settings.token')} help={t('settings.tokenHelp')}>
              {config.gateway.tokenRef !== undefined ? (
                <p className="m-0 text-[13px]">{t('keys.stored')}</p>
              ) : (
                <div className="token-input">
                  <Input
                    autoComplete="off"
                    readOnly={configurationLocked}
                    spellCheck={false}
                    type={showToken ? 'text' : 'password'}
                    value={tokenInput}
                    onChange={(event) => setTokenInput(event.target.value)}
                    onBlur={commitToken}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitToken();
                      }
                    }}
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
              )}
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                size="lg"
                disabled={configurationLocked}
                // A new literal replaces a Keychain reference; that is also the repair for an unreadable item.
                onClick={() => {
                  const nextToken = generateToken();
                  setTokenInput(nextToken);
                  setGateway({ token: nextToken, tokenRef: undefined });
                }}
              >
                {t('settings.generateToken')}
              </Button>
              {/* Removed, not disabled, once no literal key remains. */}
              {movable && (movable.gateway || movable.servers.length > 0) && (
                <Button size="lg" disabled={configurationLocked} onClick={openKeyMigration}>
                  {t('keys.title')}
                </Button>
              )}
            </div>
          </div>
          <div className="settings-group">
            <h3>Advanced</h3>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={configurationLocked || busy}
                onClick={revealConfig}
              >
                {t('raw.showInFinder')}
              </Button>
              <Button
                variant="secondary"
                disabled={configurationLocked || busy}
                onClick={openConfigInEditor}
              >
                Open in External Editor
              </Button>
              <Button
                variant="secondary"
                disabled={configurationLocked || busy || dirty}
                onClick={() => void handleImportExternal()}
              >
                Import Servers from Claude Desktop / Cursor
              </Button>
            </div>
            {importStatus && (
              <p role="status" className="m-0 mt-2 text-[12px] text-mac-label-secondary">
                {importStatus}
              </p>
            )}
          </div>
        </div>
      ) : (
        <p>{t('settings.paused')}</p>
      )}
    </section>
  );
};
