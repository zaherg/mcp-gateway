import { CircleHelp, Code2, Copy, RefreshCw, Server, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Alert } from '@mcp-gateway/mainview/components/ui';
import { bearPreset, type Editor, emptyEditor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { MessageKey } from '@mcp-gateway/shared/i18n';
import type { AppClient, AppResult, AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { ConfigFile, GatewaySnapshot } from '@mcp-gateway/shared/types';

type Run = (
  operation: () => Promise<AppResult<AppSnapshot | null>>,
  message: string,
  saved?: boolean,
) => Promise<boolean>;

// The LED carries the state; the word names it.
const SERVER_STATUS = {
  mounted: { label: 'overview.status.mounted', led: 'on' },
  error: { label: 'overview.status.error', led: 'error' },
  disabled: { label: 'overview.status.disabled', led: '' },
  stopped: { label: 'overview.status.stopped', led: '' },
} as const satisfies Record<string, { label: MessageKey; led: string }>;

interface Overview {
  gateway: GatewaySnapshot | undefined;
  config: ConfigFile | null;
  dirty: boolean;
  keyReminder: boolean;
  onReviewKeys: () => void;
  onDismissKeys: () => void;
  configurationLocked: boolean;
  run: Run;
  client: AppClient;
  openEditor: (name?: string) => void;
  toggleEndpoint: (name: string, disabled: boolean) => Promise<void>;
  setDeleting: (name: string | null) => void;
  setEditor: (editor: Editor | null) => void;
  setEditorError: (error: string | null) => void;
}

/** The latest manual test, tied to the saved revision it ran against. */
interface ServerTest {
  name: string;
  revision: string;
  state: 'testing' | 'passed' | 'failed' | 'cancelled';
  message: string;
}

export const Overview = ({
  gateway,
  config,
  dirty,
  keyReminder,
  onReviewKeys,
  onDismissKeys,
  configurationLocked,
  run,
  client,
  openEditor,
  toggleEndpoint,
  setDeleting,
  setEditor,
  setEditorError,
}: Overview) => {
  const { t } = useI18n();
  const serverCount = config ? Object.keys(config.mcpServers).length : 0;
  const [test, setTest] = useState<ServerTest | null>(null);
  // A reply that arrives after a newer test or after leaving Overview is dropped.
  const testGeneration = useRef(0);
  useEffect(
    () => () => {
      testGeneration.current++;
    },
    [],
  );
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
  return (
    <>
      {keyReminder && (
        <Alert kind="warning" role="status" label={t('keys.dismiss')} onDismiss={onDismissKeys}>
          {t('keys.reminder')}{' '}
          <Button variant="link" disabled={configurationLocked} onClick={onReviewKeys}>
            {t('keys.review')}
          </Button>
        </Alert>
      )}
      <section aria-labelledby="servers-heading">
        <div className="section-heading">
          <div>
            <h2 id="servers-heading">
              {t('overview.servers')}
              {config && <span className="count">{serverCount}</span>}
            </h2>
            <p>{t('overview.serversIntro')}</p>
          </div>
          <Button
            variant="default"
            disabled={configurationLocked || !config}
            onClick={() => openEditor()}
          >
            {t('overview.addServer')}
          </Button>
        </div>
        <div className="server-grid">
          {config &&
            Object.entries(config.mcpServers).map(([name, server]) => {
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
              // Visible text, not a tooltip, so keyboard and VoiceOver users get the reason too.
              const testReason = configurationLocked ? undefined : testBlocked;
              const testReasonId = `test-reason-${name}`;
              return (
                <article
                  className={status === 'error' ? 'server-card panel error' : 'server-card panel'}
                  key={name}
                >
                  <div className="card-heading">
                    <span className={`led ${state.led}`} />
                    <h3>{name}</h3>
                    <span className="card-meta">
                      {http ? t('common.streamableHttp') : t('overview.localStdio')} ·{' '}
                      <span className="card-status">{t(state.label)}</span>
                    </span>
                  </div>
                  <div className="endpoint">
                    <span className="mono">/mcp/{name}</span>
                    <Button
                      variant="ghost"
                      size="icon-lg"
                      aria-label={t('overview.copyEndpoint', { name })}
                      disabled={!live || dirty}
                      onClick={() =>
                        void run(() => client.copyEndpoint({ name }), t('overview.endpointCopied'))
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
                      {t('common.editServer')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="lg"
                      disabled={configurationLocked || dirty || !!gateway?.configError}
                      onClick={() => void toggleEndpoint(name, !server.disabled)}
                    >
                      {server.disabled ? t('overview.start') : t('overview.stop')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-lg"
                      aria-label={t('overview.restart', { name })}
                      disabled={
                        configurationLocked ||
                        dirty ||
                        !gateway?.running ||
                        server.disabled ||
                        !!gateway?.configError
                      }
                      onClick={() => {
                        // A restart remounts the server, so an earlier result no longer
                        // describes it. A running test reports its own cancellation.
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
                      size="icon-lg"
                      aria-label={t('overview.delete', { name })}
                      disabled={configurationLocked}
                      onClick={() => {
                        if (!configurationLocked) setDeleting(name);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="lg"
                      aria-label={t('overview.testConnectionFor', { name })}
                      aria-describedby={testReason ? testReasonId : undefined}
                      disabled={configurationLocked || testBlocked !== undefined || testing}
                      onClick={() => void testServer(name)}
                    >
                      {t('overview.testConnection')}
                    </Button>
                    <p
                      role="status"
                      className={
                        shown?.state === 'failed'
                          ? 'm-0 min-w-0 text-[12px] text-mac-red-ink'
                          : 'm-0 min-w-0 text-[12px] text-mac-label-secondary'
                      }
                    >
                      {shown?.message}
                    </p>
                    {/* Not a live region: a stopped gateway would announce it on every card. */}
                    {testReason && (
                      <p
                        id={testReasonId}
                        className="m-0 min-w-0 text-[12px] text-mac-label-secondary"
                      >
                        {testReason}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    className="client-copy"
                    disabled={!live || dirty}
                    onClick={() =>
                      void run(
                        () => client.copyClientConfig({ name }),
                        t('overview.clientConfigCopied'),
                      )
                    }
                  >
                    <Copy size={14} />
                    {t('overview.copyClientConfig')}
                  </button>
                </article>
              );
            })}
        </div>
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
        {!config && (
          <div className="panel empty-state">
            <Code2 size={24} />
            <h3>{t('overview.repairTitle')}</h3>
            <p>{t('overview.repairBody')}</p>
          </div>
        )}
        <p className="fine-print">
          <CircleHelp size={16} /> {t('overview.mountedNote')}
        </p>
      </section>
      <section className="network-note">
        <ShieldCheck size={16} />
        <div>
          <h3>{t('overview.httpTitle')}</h3>
          <p>{t('overview.httpBody')}</p>
          <p>{t('overview.awakeBody')}</p>
        </div>
      </section>
    </>
  );
};
