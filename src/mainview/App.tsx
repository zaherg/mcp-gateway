import { Activity } from 'lucide-react';

import { ConfigBlockerBar } from '@mcp-gateway/mainview/components/ConfigBlockerBar';
import { GatewayToggle } from '@mcp-gateway/mainview/components/GatewayToggle';
import { Shell } from '@mcp-gateway/mainview/components/Shell';
import { SidebarUpdates } from '@mcp-gateway/mainview/components/SidebarUpdates';
import { Modal } from '@mcp-gateway/mainview/components/ui';
import {
  type ActiveModal,
  GatewayViewProvider,
  useGatewayView,
} from '@mcp-gateway/mainview/context/GatewayViewContext';
import { KeyMigration } from '@mcp-gateway/mainview/dialogs/KeyMigration';
import { ServerEditor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { WhatsNew } from '@mcp-gateway/mainview/dialogs/WhatsNew';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import { Logs } from '@mcp-gateway/mainview/Logs';
import { Overview } from '@mcp-gateway/mainview/views/Overview';
import { RawConfig } from '@mcp-gateway/mainview/views/RawConfig';
import { Settings } from '@mcp-gateway/mainview/views/Settings';
import { Updates } from '@mcp-gateway/mainview/views/Updates';
import type { AppClient } from '@mcp-gateway/shared/rpc';

export type { ActiveModal };

interface AppProps {
  client: AppClient;
}

const AppWorkspace = () => {
  const {
    client,
    snapshot,
    gateway,
    doc,
    dirty,
    stale,
    filename,
    tab,
    activeModal,
    editorError,
    existingNames,
    busy,
    updateBusy,
    error,
    configurationLocked,
    quitting,
    updateState,
    updateRestarting,
    whatsNewPending,
    updatesTriggerDisabled,
    fallbackFocus,
    updatesTrigger,
    setTab,
    setRawOpen,
    setEditorError,
    changeEditor,
    reloadFromDisk,
    applyServer,
    closeModal,
    openUpdatesModal,
    requestUpdateRestart,
    closeWhatsNew,
    dismissKeyReminder,
    migrateKeys,
    run,
  } = useGatewayView();
  const { t } = useI18n();

  const activeDialog = (() => {
    switch (activeModal?.kind) {
      case 'serverEditor':
        return (
          <ServerEditor
            editor={activeModal.editor}
            existingNames={existingNames}
            editorError={editorError}
            configurationLocked={configurationLocked}
            fallbackFocus={fallbackFocus}
            onChange={changeEditor}
            onClose={closeModal}
            onSubmit={applyServer}
            onDismissError={() => setEditorError(null)}
          />
        );
      case 'keyMigration':
        return snapshot ? (
          <KeyMigration
            slots={snapshot.gateway.keyMigration}
            dirty={dirty}
            busy={busy || configurationLocked}
            error={error}
            filename={filename}
            fallbackFocus={fallbackFocus}
            onKeep={() => {
              closeModal();
              dismissKeyReminder();
            }}
            onClose={closeModal}
            onMove={migrateKeys}
          />
        ) : null;
      case 'updates':
        return updateState?.supported && !quitting && !updateRestarting ? (
          <Modal
            title={t('common.updates')}
            onClose={closeModal}
            fallbackFocus={fallbackFocus}
            busy={busy || updateBusy}
          >
            <Updates />
          </Modal>
        ) : null;
      default:
        return whatsNewPending && snapshot?.whatsNew ? (
          <WhatsNew
            version={snapshot.whatsNew}
            fallbackFocus={fallbackFocus}
            onClose={closeWhatsNew}
          />
        ) : null;
    }
  })();

  return (
    <Shell
      sidebarUpdates={
        <SidebarUpdates
          updateState={updateState}
          disabled={updatesTriggerDisabled}
          onOpen={openUpdatesModal}
          onRestart={() => void requestUpdateRestart()}
          triggerRef={updatesTrigger}
        />
      }
      gatewayToggle={
        snapshot &&
        doc && (
          <GatewayToggle
            gateway={gateway}
            dirty={dirty}
            configurationLocked={configurationLocked || busy}
            run={run}
            client={client}
          />
        )
      }
      dialogs={activeDialog}
    >
      <ConfigBlockerBar
        configError={gateway?.configError}
        stale={stale}
        disabled={configurationLocked || busy}
        onOpenRawConfig={() => {
          setTab('settings');
          setRawOpen(true);
        }}
        onReloadFromDisk={reloadFromDisk}
      />
      {(!snapshot || !doc) && tab === 'logs' ? (
        <Logs client={client} servers={[]} />
      ) : !snapshot || !doc ? (
        <section className="panel loading" aria-busy="true">
          <Activity size={22} />
          <h2>{t('app.connecting')}</h2>
          <p>{t('app.waiting')}</p>
        </section>
      ) : (
        <fieldset disabled={busy} className="workspace">
          {tab === 'logs' ? (
            <Logs client={client} servers={gateway?.servers.map((server) => server.name) ?? []} />
          ) : tab === 'overview' ? (
            <Overview />
          ) : (
            <Settings />
          )}
          <RawConfig visible={tab === 'settings'} />
        </fieldset>
      )}
    </Shell>
  );
};

export const App = ({ client }: AppProps) => (
  <GatewayViewProvider client={client}>
    <AppWorkspace />
  </GatewayViewProvider>
);
