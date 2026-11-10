import { ArrowDownToLine, ArrowUpRight, CircleHelp, RefreshCw } from 'lucide-react';
import type { RefObject } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Toggle } from '@mcp-gateway/mainview/components/ui';
import type { Editor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import type { AppClient, AppResult, QuitStatus, UpdateStatus } from '@mcp-gateway/shared/rpc';

const updateCheckedLabel = (value: string | null): string => {
  if (!value) return 'Not checked yet.';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Last check time is unavailable.';
  return `Last checked ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
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

export const Updates = ({
  updateState,
  updateBusy,
  configurationLocked,
  busy,
  quitStatusKnown,
  quitStatus,
  editor,
  deleting,
  runUpdate,
  client,
  setConfirmUpdate,
  updatesHeading,
}: {
  updateState: UpdateStatus;
  updateBusy: boolean;
  configurationLocked: boolean;
  busy: boolean;
  quitStatusKnown: boolean;
  quitStatus: QuitStatus;
  editor: Editor | null;
  deleting: string | null;
  runUpdate: (
    operation: () => Promise<AppResult<UpdateStatus>>,
    message: string,
  ) => Promise<boolean>;
  client: AppClient;
  setConfirmUpdate: (confirm: boolean) => void;
  updatesHeading: RefObject<HTMLHeadingElement | null>;
}) => {
  const updateReady = updateState.phase === 'ready';
  const inProgress = updateState.phase === 'checking' || updateState.phase === 'downloading';
  const actionsDisabled =
    updateBusy || configurationLocked || inProgress || updateState.phase === 'restarting';
  return (
    <section className="panel updates-panel" aria-labelledby="updates-heading">
      <div className="section-heading">
        <div>
          <h2 id="updates-heading" ref={updatesHeading} tabIndex={-1}>
            Updates
          </h2>
          <p>
            Signed macOS arm64 stable builds only. Downloads come from the fixed GitHub release
            source.
          </p>
        </div>
        <ArrowDownToLine size={20} />
      </div>
      {!updateState.supported ? (
        <p className="update-unavailable">
          Automatic updates are unsupported in this build. This build does not contact the update
          feed.
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
            description="Check after launch, then daily. A higher stable version downloads automatically; installation always requires explicit confirmation."
            disabled={updateBusy || configurationLocked || updateState.phase === 'restarting'}
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
              <RefreshCw />
              {updateState.phase === 'checking' ? 'Checking…' : 'Check for Updates'}
            </Button>
            {updateState.availableVersion && !updateReady && (
              <Button
                disabled={actionsDisabled}
                onClick={() =>
                  void runUpdate(() => client.updatesDownload(), 'The update download has started.')
                }
              >
                <ArrowDownToLine />
                {updateState.phase === 'downloading' ? 'Downloading…' : 'Download Update'}
              </Button>
            )}
            {updateReady && (
              <Button
                variant="default"
                disabled={
                  busy ||
                  !quitStatusKnown ||
                  updateState.phase === 'restarting' ||
                  !!editor ||
                  !!deleting ||
                  quitStatus.phase === 'pending' ||
                  quitStatus.phase === 'ready'
                }
                onClick={() => setConfirmUpdate(true)}
              >
                <ArrowUpRight />
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
            <CircleHelp size={14} /> A downloaded update is not installed until the app restarts and
            the expected version starts. Active MCP connections are interrupted during restart. Logs
            and unsaved drafts remain available only in the current process; they are not retained
            after a successful restart.
          </p>
        </>
      )}
    </section>
  );
};
