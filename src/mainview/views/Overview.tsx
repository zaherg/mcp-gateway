import { Check, Code2, Copy, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Switch } from '@mcp-gateway/mainview/components/mac/switch';
import { Alert } from '@mcp-gateway/mainview/components/ui';
import { useGatewayView } from '@mcp-gateway/mainview/context/GatewayViewContext';
import { bearPreset, emptyEditor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { MessageKey } from '@mcp-gateway/shared/i18n';

// The LED carries the state; the word names it.
const SERVER_STATUS = {
  mounted: { label: 'overview.status.mounted', led: 'on' },
  error: { label: 'overview.status.error', led: 'error' },
  disabled: { label: 'overview.status.disabled', led: '' },
  stopped: { label: 'overview.status.stopped', led: '' },
} as const satisfies Record<string, { label: MessageKey; led: string }>;

/** The latest manual test, tied to the saved revision it ran against. */
interface ServerTest {
  name: string;
  revision: string;
  state: 'testing' | 'passed' | 'failed' | 'cancelled';
  message: string;
}

export const Overview = () => {
  const {
    gateway,
    config,
    snapshot,
    dirty,
    error,
    clearError,
    openKeyMigration,
    dismissKeyReminder,
    configurationLocked,
    run,
    client,
    openServerEditor,
    toggleServer,
    deleteServer,
    setEditor,
    setEditorError,
  } = useGatewayView();
  const { t } = useI18n();
  const serverCount = config ? Object.keys(config.mcpServers).length : 0;
  const [test, setTest] = useState<ServerTest | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [dismissedOpErrorId, setDismissedOpErrorId] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A reply that arrives after a newer test or after leaving Overview is dropped.
  const testGeneration = useRef(0);
  useEffect(
    () => () => {
      testGeneration.current++;
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );
  const markCopied = (key: string) => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    setCopiedKey(key);
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null;
      setCopiedKey((previous) => (previous === key ? null : previous));
    }, 1_500);
  };
  const copyEndpoint = async (name: string) => {
    const ok = await run(() => client.copyEndpoint({ name }), '');
    if (ok) markCopied(`endpoint:${name}`);
  };
  const copyClientConfig = async (name: string) => {
    const ok = await run(() => client.copyClientConfig({ name }), '');
    if (ok) markCopied(`client:${name}`);
  };
  const revision = gateway?.revision;
  const testing = test?.state === 'testing';
  const testedStatus = gateway?.servers.find((item) => item.name === test?.name)?.status;
  // A pass or failure describes the mount it ran against, so it ends when the gateway stops
  // or the server unmounts. A cancellation stays: it explains why the test stopped.
  const outdated =
    (test?.state === 'passed' || test?.state === 'failed') &&
    !(gateway?.running && testedStatus === 'mounted');
  useEffect(() => {
    if (outdated) setTest(null);
  }, [outdated]);
  const testServer = async (name: string) => {
    if (!revision || testing) return;
    const generation = ++testGeneration.current;
    setTest({ name, revision, state: 'testing', message: t('overview.testing') });
    let next: ServerTest;
    try {
      const result = await client.testServer({ name, expectedRevision: revision });
      next = result.ok
        ? {
            name,
            revision,
            state: 'passed',
            message: t('overview.testPassed', { version: result.value.protocolVersion }),
          }
        : {
            name,
            revision,
            state: result.error.code === 'Cancelled' ? 'cancelled' : 'failed',
            message: result.error.message,
          };
    } catch {
      next = { name, revision, state: 'failed', message: t('overview.testUnavailable') };
    }
    if (generation === testGeneration.current) setTest(next);
  };
  const operationalError =
    gateway?.operationalError &&
    gateway.operationalError.occurrenceId !== dismissedOpErrorId &&
    !error
      ? gateway.operationalError
      : null;

  const listenerAddress = config ? `${config.gateway.host}:${config.gateway.port}` : null;

  return (
    <>
      {error && <Alert onDismiss={clearError}>{error}</Alert>}
      {operationalError && (
        <Alert onDismiss={() => setDismissedOpErrorId(operationalError.occurrenceId)}>
          {operationalError.code}: {operationalError.message}
        </Alert>
      )}
      {snapshot?.keyReminder && (
        <Alert
          kind="warning"
          role="status"
          label={t('keys.dismiss')}
          onDismiss={dismissKeyReminder}
        >
          {t('keys.reminder')}{' '}
          <Button variant="link" disabled={configurationLocked} onClick={openKeyMigration}>
            {t('keys.review')}
          </Button>
        </Alert>
      )}
      <section aria-labelledby="servers-heading">
        <div className="section-heading">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="servers-heading" className="flex items-center gap-1.5">
              {t('overview.servers')}
              {config && <span className="count">{serverCount}</span>}
            </h2>
            <span className="inline-flex items-center gap-2 rounded-full border border-mac-border bg-mac-group px-2.5 py-1 text-[12px] text-mac-label">
              <span className={`led ${gateway?.running ? 'on' : ''}`} />
              <span>
                {gateway?.running ? t('common.gatewayRunning') : t('common.gatewayStopped')}
              </span>
              {listenerAddress && (
                <span className="mono text-mac-label-secondary">{listenerAddress}</span>
              )}
            </span>
          </div>
          <Button
            variant="default"
            disabled={configurationLocked || !config}
            onClick={() => openServerEditor()}
          >
            {t('overview.addServer')}
          </Button>
        </div>
        {config && serverCount > 0 && (
          <div className="server-table panel">
            {Object.entries(config.mcpServers).map(([name, server]) => {
              const live = gateway?.servers.find((item) => item.name === name);
              const status = live?.status ?? (server.disabled ? 'disabled' : 'stopped');
              const state = SERVER_STATUS[status];
              const http = 'url' in server;
              // A result for an older revision no longer describes this entry.
              const shown =
                !outdated && test?.name === name && test.revision === revision ? test : null;
              const testBlocked = dirty
                ? t('toggle.saveFirst')
                : gateway?.configError
                  ? t('toggle.repairFirst')
                  : !gateway?.running
                    ? t('overview.testStartGateway')
                    : status !== 'mounted'
                      ? t('overview.testNotMounted')
                      : test?.state === 'testing' && test.name !== name
                        ? t('overview.testBusy')
                        : undefined;
              const testReason = configurationLocked ? undefined : testBlocked;
              const testReasonId = `test-reason-${name}`;
              const endpointCopied = copiedKey === `endpoint:${name}`;
              const clientCopied = copiedKey === `client:${name}`;
              return (
                <article
                  className={status === 'error' ? 'server-row error' : 'server-row'}
                  key={name}
                >
                  <div className="server-row-main">
                    <div className="server-cell-name">
                      <span className={`led ${state.led}`} title={t(state.label)} />
                      <strong>{name}</strong>
                      <span className="server-transport-badge">{http ? 'HTTP' : 'STDIO'}</span>
                    </div>
                    <div className="server-cell-target">
                      <div className="server-endpoint-line">
                        <span className="mono">/mcp/{name}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('overview.copyEndpoint', { name })}
                          disabled={!live || dirty}
                          onClick={() => void copyEndpoint(name)}
                        >
                          {endpointCopied ? <Check /> : <Copy />}
                        </Button>
                      </div>
                      <p className="server-detail mono" title={http ? server.url : server.command}>
                        {http ? server.url : server.command}
                      </p>
                    </div>
                    <div className="server-cell-switch">
                      <Switch
                        size="sm"
                        aria-label={server.disabled ? t('overview.start') : t('overview.stop')}
                        checked={!server.disabled}
                        disabled={configurationLocked || dirty || !!gateway?.configError}
                        onCheckedChange={(enabled) => void toggleServer(name, !enabled)}
                      />
                    </div>
                    <div className="server-cell-actions">
                      <Button
                        variant="outline"
                        aria-label={t('overview.testConnectionFor', { name })}
                        aria-describedby={testReason ? testReasonId : undefined}
                        title={testReason}
                        disabled={configurationLocked || testBlocked !== undefined || testing}
                        onClick={() => void testServer(name)}
                      >
                        {t('overview.testConnection')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('overview.restart', { name })}
                        disabled={
                          configurationLocked ||
                          dirty ||
                          !gateway?.running ||
                          server.disabled ||
                          !!gateway?.configError
                        }
                        onClick={() => {
                          if (!testing && test?.name === name) setTest(null);
                          void run(
                            () => client.restartServer({ name }),
                            t('overview.restarted', { name }),
                          );
                        }}
                      >
                        <RefreshCw />
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={!live || dirty}
                        onClick={() => void copyClientConfig(name)}
                      >
                        {clientCopied ? <Check /> : <Copy />}
                        {clientCopied ? 'Copied' : t('overview.copyClientConfig')}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={configurationLocked}
                        onClick={() => openServerEditor(name)}
                      >
                        {t('common.editServer')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('overview.delete', { name })}
                        disabled={configurationLocked}
                        onClick={() => {
                          if (!configurationLocked) void deleteServer(name);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {(live?.error || shown || testReason) && (
                    <div className="server-row-detail">
                      {live?.error && <p className="inline-error">{live.error.message}</p>}
                      {shown && (
                        <p
                          role="status"
                          className={
                            shown.state === 'failed'
                              ? 'm-0 text-[12px] text-mac-red-ink'
                              : 'm-0 text-[12px] text-mac-label-secondary'
                          }
                        >
                          {shown.message}
                        </p>
                      )}
                      {testReason && !shown && (
                        <p id={testReasonId} className="m-0 text-[11px] text-mac-label-secondary">
                          {testReason}
                        </p>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {config && serverCount === 0 && (
          <div className="empty-state panel">
            <Server size={24} />
            <h3>{t('overview.emptyTitle')}</h3>
            <p>
              {t('overview.emptyLine1')}
              <br />
              {t('overview.emptyLine2')}
            </p>
            <Button
              disabled={configurationLocked}
              onClick={() => {
                if (configurationLocked) return;
                setEditorError(null);
                setEditor({ ...emptyEditor(), ...bearPreset() });
              }}
            >
              {t('overview.bearPreset')}
            </Button>
            <small>{t('overview.bearNote')}</small>
          </div>
        )}
        {/* A first-run Keychain failure has no file to repair; its banner gives the remedy. */}
        {!config && gateway?.configError?.code !== 'KeySetupFailed' && (
          <div className="panel empty-state">
            <Code2 size={24} />
            <h3>{t('overview.repairTitle')}</h3>
            <p>{t('overview.repairBody')}</p>
          </div>
        )}
      </section>
    </>
  );
};
