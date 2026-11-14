import { CircleHelp } from 'lucide-react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Alert, Toggle } from '@mcp-gateway/mainview/components/ui';
import type { Editor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import type { AppClient, AppResult, QuitStatus, UpdateStatus } from '@mcp-gateway/shared/rpc';

const updateCheckedLabel = (value: string | null): string => {
  if (!value) return 'Not checked yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Last check time is unavailable.';
  return `Last checked ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

const updateStatusText = (update: UpdateStatus): string => {
  switch (update.phase) {
    case 'checking':
      return 'Checking the fixed GitHub stable feed…';
    case 'downloading':
      return update.availableVersion
        ? `Downloading and verifying version ${update.availableVersion}…`
        : 'Downloading and verifying the selected update…';
    case 'available':
      return update.availableVersion
        ? `Version ${update.availableVersion} is available.`
        : 'An update is available.';
    case 'ready':
      return update.availableVersion
        ? `Version ${update.availableVersion} is verified and ready to install.`
        : 'The update is verified and ready to install.';
    case 'restarting':
      return 'Restarting to apply the verified update.';
    case 'error':
      return update.error ?? 'The update operation failed.';
    case 'idle':
      return update.checkedAt ? 'You are up to date.' : 'No update check has run yet.';
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
      <p className="dialog-intro">
        Signed macOS arm64 builds only, from the fixed GitHub release feed
      </p>
      {error && <Alert onDismiss={onDismissError}>{error}</Alert>}
      {!updateState.supported ? (
        <p className="update-unavailable">
          This build does not support updates and never contacts the update feed.
        </p>
      ) : (
        <>
          <div className="update-summary">
            <div>
              <span className="update-label">Installed</span>
              <strong>{updateState.installedVersion ?? 'Unknown'}</strong>
            </div>
            <div>
              <span className="update-label">Status</span>
              <strong role="status">{updateStatusText(updateState)}</strong>
            </div>
            {updateState.availableVersion && (
              <div>
                <span className="update-label">Available</span>
                <strong>{updateState.availableVersion}</strong>
              </div>
            )}
          </div>
          {inProgress && (
            <div
              className="update-progress"
              role="progressbar"
              aria-label="Update progress"
              aria-valuetext={updateStatusText(updateState)}
              aria-busy="true"
            >
              <span />
            </div>
          )}
          <p className="fine-print">{updateCheckedLabel(updateState.checkedAt)}</p>
          <Toggle
            label="Automatically check and download updates"
            description="After launch, then daily. A newer stable version downloads on its own; installing waits for your confirmation."
            disabled={toggleDisabled}
            checked={updateState.automaticUpdates}
            onChange={(value) =>
              void runUpdate(
                () => client.updatesSetAutomatic({ automatic: value }),
                value ? 'Automatic update checks enabled.' : 'Automatic update checks disabled.',
              )
            }
          />
          <div className="update-actions">
            <Button
              disabled={actionsDisabled}
              onClick={() => void runUpdate(() => client.updatesCheck(), 'Update check completed.')}
            >
              {updateState.phase === 'checking' ? 'Checking…' : 'Check for Updates'}
            </Button>
            {updateState.availableVersion && !updateReady && (
              <Button
                disabled={actionsDisabled}
                onClick={() =>
                  void runUpdate(() => client.updatesDownload(), 'The update download has started.')
                }
              >
                {updateState.phase === 'downloading' ? 'Downloading…' : 'Download Update'}
              </Button>
            )}
            {updateReady && (
              <Button variant="default" disabled={restartDisabled} onClick={onRequestRestart}>
                Restart to Update
              </Button>
            )}
          </div>
          {(editor || deleting) && updateReady && (
            <p className="fine-print" role="status">
              Close the open server dialog before restarting.
            </p>
          )}
          <p className="fine-print">
            <CircleHelp size={16} /> A download installs only when the app restarts. Restarting
            interrupts active MCP connections and does not carry logs or unsaved drafts over.
          </p>
        </>
      )}
    </div>
  );
};
