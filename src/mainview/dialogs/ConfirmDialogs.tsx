import { Modal } from '@mcp-gateway/mainview/components/ui';
import type { UpdateStatus } from '@mcp-gateway/shared/rpc';
import type { GatewayConfig } from '@mcp-gateway/shared/types';
import type { RefObject } from 'react';

export const ConfirmDialogs = ({
  confirmQuit,
  setConfirmQuit,
  quitting,
  requestQuit,
  confirmUpdate,
  updateReady,
  updateState,
  dirty,
  updateRestarting,
  requestUpdateRestart,
  setConfirmUpdate,
  deleting,
  setDeleting,
  configurationLocked,
  parsed,
  update,
  fallbackFocus,
}: {
  confirmQuit: boolean;
  setConfirmQuit: (confirm: boolean) => void;
  quitting: boolean;
  requestQuit: () => Promise<void>;
  confirmUpdate: boolean;
  updateReady: boolean;
  updateState: UpdateStatus | undefined;
  dirty: boolean;
  updateRestarting: boolean;
  requestUpdateRestart: () => Promise<void>;
  setConfirmUpdate: (confirm: boolean) => void;
  deleting: string | null;
  setDeleting: (name: string | null) => void;
  configurationLocked: boolean;
  parsed: GatewayConfig | null;
  update: (config: GatewayConfig) => void;
  fallbackFocus: RefObject<HTMLElement | null>;
}) => {
  return (
    <>
      {confirmQuit && (
        <Modal
          title="Quit MCP Gateway?"
          onClose={() => setConfirmQuit(false)}
          fallbackFocus={fallbackFocus}
        >
          <p>Your unsaved changes will be discarded. Quit stops the gateway and its backends.</p>
          <div className="dialog-actions">
            <button type="button" className="button" onClick={() => setConfirmQuit(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={quitting}
              onClick={() => void requestQuit()}
            >
              Discard changes and quit
            </button>
          </div>
        </Modal>
      )}
      {confirmUpdate && updateReady && (
        <Modal
          title="Restart to update?"
          onClose={() => setConfirmUpdate(false)}
          fallbackFocus={fallbackFocus}
        >
          <p>
            Restart MCP Gateway to install version {updateState?.availableVersion}? Active MCP
            connections will be interrupted while the gateway and backends stop before the installer
            is armed.
          </p>
          <p>
            {dirty
              ? 'Your unsaved configuration changes will be discarded.'
              : 'Your saved configuration remains unchanged.'}
          </p>
          <div className="dialog-actions">
            <button type="button" className="button" onClick={() => setConfirmUpdate(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={quitting || updateRestarting}
              onClick={() => void requestUpdateRestart()}
            >
              {dirty ? 'Discard draft and restart' : 'Restart to update'}
            </button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Delete server?"
          onClose={() => setDeleting(null)}
          fallbackFocus={fallbackFocus}
        >
          <p className="dialog-intro">
            Remove <strong>{deleting}</strong> from the configuration? Its endpoint will stop when
            you save. This does not delete backend data.
          </p>
          <div className="dialog-actions">
            <button type="button" className="button" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              disabled={configurationLocked}
              onClick={() => {
                if (configurationLocked || !parsed) return;
                const servers = { ...parsed.mcpServers };
                delete servers[deleting];
                update({ ...parsed, mcpServers: servers });
                setDeleting(null);
              }}
            >
              Delete server
            </button>
          </div>
        </Modal>
      )}
    </>
  );
};
