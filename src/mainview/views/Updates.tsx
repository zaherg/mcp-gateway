import { CircleHelp } from 'lucide-react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Alert, Toggle } from '@mcp-gateway/mainview/components/ui';
import type { Editor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { Translate } from '@mcp-gateway/shared/i18n';
import type { AppClient, AppResult, QuitStatus, UpdateStatus } from '@mcp-gateway/shared/rpc';

// The clock format follows the macOS region, not the interface language, as it did before.
const updateCheckedLabel = (value: string | null, t: Translate): string => {
  if (!value) return t('updates.notChecked');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('updates.checkTimeUnavailable');
  return t('updates.lastChecked', {
    time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  });
};

const updateStatusText = (update: UpdateStatus, t: Translate): string => {
  switch (update.phase) {
    case 'checking':
      return t('updates.status.checking');
    case 'downloading':
      return update.availableVersion
        ? t('updates.status.downloadingVersion', { version: update.availableVersion })
        : t('updates.status.downloading');
    case 'available':
      return update.availableVersion
        ? t('updates.status.availableVersion', { version: update.availableVersion })
        : t('updates.status.available');
    case 'ready':
      return update.availableVersion
        ? t('updates.status.readyVersion', { version: update.availableVersion })
        : t('updates.status.ready');
    case 'restarting':
      return t('updates.status.restarting');
    case 'error':
      return update.error ?? t('common.updateOperationFailed');
    case 'idle':
      return update.checkedAt ? t('updates.status.upToDate') : t('updates.status.neverChecked');
  }
};

interface Updates {
  updateState: UpdateStatus;
  updateBusy: boolean;
  configurationLocked: boolean;
  busy: boolean;
  quitStatusKnown: boolean;
  quitStatus: QuitStatus;
  editor: Editor | null;
  deleting: string | null;
  error: string | null;
  onDismissError: () => void;
  runUpdate: (
    operation: () => Promise<AppResult<UpdateStatus>>,
    message: string,
  ) => Promise<boolean>;
  client: AppClient;
  onRequestRestart: () => void;
}

export const Updates = ({
  updateState,
  updateBusy,
  configurationLocked,
  busy,
  quitStatusKnown,
  quitStatus,
  editor,
  deleting,
  error,
  onDismissError,
  runUpdate,
  client,
  onRequestRestart,
}: Updates) => {
  const { t } = useI18n();
  const updateReady = updateState.phase === 'ready';
  const inProgress = updateState.phase === 'checking' || updateState.phase === 'downloading';
  const toggleDisabled =
    busy || updateBusy || configurationLocked || updateState.phase === 'restarting';
  const actionsDisabled = toggleDisabled || inProgress;
  const restartDisabled =
    toggleDisabled ||
    !quitStatusKnown ||
    editor !== null ||
    deleting !== null ||
    quitStatus.phase === 'pending' ||
    quitStatus.phase === 'ready';
  return (
    <div className="updates-content">
      <p className="dialog-intro">{t('updates.intro')}</p>
      {error && <Alert onDismiss={onDismissError}>{error}</Alert>}
      {!updateState.supported ? (
        <p className="update-unavailable">{t('updates.unsupported')}</p>
      ) : (
        <>
          <div className="update-summary">
            <div>
              <span className="update-label">{t('updates.installed')}</span>
              <strong>{updateState.installedVersion ?? t('updates.unknown')}</strong>
            </div>
            <div>
              <span className="update-label">{t('updates.statusLabel')}</span>
              <strong role="status">{updateStatusText(updateState, t)}</strong>
            </div>
            {updateState.availableVersion && (
              <div>
                <span className="update-label">{t('updates.availableLabel')}</span>
                <strong>{updateState.availableVersion}</strong>
              </div>
            )}
          </div>
          {inProgress && (
            <div
              className="update-progress"
              role="progressbar"
              aria-label={t('updates.progress')}
              aria-valuetext={updateStatusText(updateState, t)}
              aria-busy="true"
            >
              <span />
            </div>
          )}
          <p className="fine-print">{updateCheckedLabel(updateState.checkedAt, t)}</p>
          <Toggle
            label={t('updates.automatic')}
            description={t('updates.automaticDescription')}
            disabled={toggleDisabled}
            checked={updateState.automaticUpdates}
            onChange={(value) =>
              void runUpdate(
                () => client.updatesSetAutomatic({ automatic: value }),
                value ? t('updates.automaticEnabled') : t('updates.automaticDisabled'),
              )
            }
          />
          <div className="update-actions">
            <Button
              disabled={actionsDisabled}
              onClick={() =>
                void runUpdate(() => client.updatesCheck(), t('updates.checkCompleted'))
              }
            >
              {updateState.phase === 'checking' ? t('updates.checkingButton') : t('updates.check')}
            </Button>
            {updateState.availableVersion && !updateReady && (
              <Button
                disabled={actionsDisabled}
                onClick={() =>
                  void runUpdate(() => client.updatesDownload(), t('updates.downloadStarted'))
                }
              >
                {updateState.phase === 'downloading'
                  ? t('updates.downloadingButton')
                  : t('updates.download')}
              </Button>
            )}
            {updateReady && (
              <Button variant="default" disabled={restartDisabled} onClick={onRequestRestart}>
                {t('updates.restart')}
              </Button>
            )}
          </div>
          {(editor || deleting) && updateReady && (
            <p className="fine-print" role="status">
              {t('updates.closeDialogFirst')}
            </p>
          )}
          <p className="fine-print">
            <CircleHelp size={16} /> {t('updates.restartNote')}
          </p>
        </>
      )}
    </div>
  );
};
