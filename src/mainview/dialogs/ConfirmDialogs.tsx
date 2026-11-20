import type { RefObject } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Modal } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { UpdateStatus } from '@mcp-gateway/shared/rpc';
import type { ConfigFile } from '@mcp-gateway/shared/types';

interface ConfirmDialogs {
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
  parsed: ConfigFile | null;
  update: (config: ConfigFile) => void;
  fallbackFocus: RefObject<HTMLElement | null>;
}

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
}: ConfirmDialogs) => {
  const { t, rich } = useI18n();
  return (
    <>
      {confirmQuit && (
        <Modal
          title={t('confirm.quitTitle')}
          onClose={() => setConfirmQuit(false)}
          fallbackFocus={fallbackFocus}
        >
          <p>{t('confirm.quitBody')}</p>
          <div className="dialog-actions">
            <Button onClick={() => setConfirmQuit(false)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={quitting} onClick={() => void requestQuit()}>
              {t('confirm.quitAction')}
            </Button>
          </div>
        </Modal>
      )}
      {confirmUpdate && updateReady && (
        <Modal
          title={t('confirm.updateTitle')}
          onClose={() => setConfirmUpdate(false)}
          fallbackFocus={fallbackFocus}
        >
          <p>{t('confirm.updateBody', { version: updateState?.availableVersion ?? '' })}</p>
          <p>{dirty ? t('confirm.updateDiscards') : t('confirm.updateKeeps')}</p>
          <div className="dialog-actions">
            <Button onClick={() => setConfirmUpdate(false)}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              disabled={quitting || updateRestarting}
              onClick={() => void requestUpdateRestart()}
            >
              {dirty ? t('confirm.updateDiscardAction') : t('confirm.updateAction')}
            </Button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal
          title={t('confirm.deleteTitle')}
          onClose={() => setDeleting(null)}
          fallbackFocus={fallbackFocus}
        >
          <p className="dialog-intro">
            {rich('confirm.deleteBody', { name: <strong>{deleting}</strong> })}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setDeleting(null)}>{t('common.cancel')}</Button>
            <Button
              variant="destructive"
              disabled={configurationLocked}
              onClick={() => {
                if (configurationLocked || !parsed) return;
                const servers = { ...parsed.mcpServers };
                delete servers[deleting];
                update({ ...parsed, mcpServers: servers });
                setDeleting(null);
              }}
            >
              {t('confirm.deleteAction')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
};
