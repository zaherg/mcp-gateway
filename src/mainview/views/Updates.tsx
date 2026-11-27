import { CircleHelp } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Alert, Toggle } from '@mcp-gateway/mainview/components/ui';
import { useGatewayView } from '@mcp-gateway/mainview/context/GatewayViewContext';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { Translate } from '@mcp-gateway/shared/i18n';
import type { UpdateStatus } from '@mcp-gateway/shared/rpc';

// The clock format follows the macOS region, not the interface language, as it did before.
const updateCheckedLabel = (value: string | null, t: Translate) => {
  if (!value) return t('updates.notChecked');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('updates.checkTimeUnavailable');
  return t('updates.lastChecked', {
    time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  });
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const updateStatusText = (update: UpdateStatus, t: Translate) => {
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

export const Updates = () => {
  const {
    updateState,
    updateBusy,
    configurationLocked,
    busy,
    quitStatusKnown,
    quitStatus,
    error,
    clearError,
    runUpdate,
    client,
    requestUpdateRestart,
  } = useGatewayView();
  const { t } = useI18n();
  const autoChecked = useRef(false);
  useEffect(() => {
    if (autoChecked.current || !updateState?.supported || updateState.phase !== 'idle') return;
    autoChecked.current = true;
    void runUpdate(() => client.updatesCheck(), t('updates.checkCompleted'));
  }, [client, runUpdate, t, updateState?.phase, updateState?.supported]);

  if (!updateState) return null;

  const updateReady = updateState.phase === 'ready';
  const updateAvailable =
    updateState.phase === 'available' || Boolean(updateState.availableVersion);
  const inProgress = updateState.phase === 'checking' || updateState.phase === 'downloading';
  const toggleDisabled =
    busy || updateBusy || configurationLocked || updateState.phase === 'restarting';
  const actionsDisabled = toggleDisabled || inProgress;
  const restartDisabled =
    toggleDisabled ||
    !quitStatusKnown ||
    quitStatus.phase === 'pending' ||
    quitStatus.phase === 'ready';

  const progressPercent =
    updateState.progressPercent ?? updateState.downloadProgress?.percent ?? null;
  const downloadedBytes =
    updateState.downloadedBytes ?? updateState.downloadProgress?.bytesDownloaded ?? null;
  const totalBytes = updateState.totalBytes ?? updateState.downloadProgress?.totalBytes ?? null;
  const showProgress = inProgress || progressPercent !== null;
  const progressLabel = (() => {
    const parts: string[] = [];
    if (progressPercent !== null) parts.push(`${progressPercent}%`);
    if (downloadedBytes !== null && downloadedBytes > 0) {
      if (totalBytes !== null && totalBytes > 0) {
        parts.push(`${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`);
      } else {
        parts.push(formatBytes(downloadedBytes));
      }
    }
    return parts.join(' · ');
  })();

  const handleInstallAndRelaunch = () => {
    if (updateReady) {
      void requestUpdateRestart();
      return;
    }
    void runUpdate(() => client.updatesInstall(), t('updates.downloadStarted'));
  };

  return (
    <div className="updates-content">
      <p className="dialog-intro">{t('updates.intro')}</p>
      {error && <Alert onDismiss={clearError}>{error}</Alert>}
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
          {showProgress && (
            <div>
              <div
                className="update-progress"
                role="progressbar"
                aria-label={t('updates.progress')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent ?? undefined}
                aria-valuetext={progressLabel || updateStatusText(updateState, t)}
                aria-busy={inProgress}
              >
                <span
                  style={
                    progressPercent !== null
                      ? { width: `${Math.min(100, Math.max(0, progressPercent))}%` }
                      : undefined
                  }
                />
              </div>
              {progressLabel && (
                <p className="mt-1 text-[11px] text-mac-label-secondary">{progressLabel}</p>
              )}
            </div>
          )}
          <p className="mt-3 text-[11px] text-mac-label-secondary">
            {updateCheckedLabel(updateState.checkedAt, t)}
          </p>
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
            {(updateAvailable || updateReady) && (
              <Button
                variant="default"
                disabled={updateReady ? restartDisabled : actionsDisabled}
                onClick={handleInstallAndRelaunch}
              >
                {updateState.phase === 'downloading'
                  ? t('updates.downloadingButton')
                  : 'Install and Relaunch'}
              </Button>
            )}
          </div>
          <p className="mt-4 flex items-start gap-2 text-[11px] leading-[1.6] text-mac-label-secondary">
            <CircleHelp size={16} className="mt-0.5 shrink-0" /> {t('updates.restartNote')}
          </p>
        </>
      )}
    </div>
  );
};
