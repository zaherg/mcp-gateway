import { Alert } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { QuitStatus } from '@mcp-gateway/shared/rpc';

interface QuitBanners {
  quitting: boolean;
  quitStatus: QuitStatus;
  shutdownStarted: boolean;
  updateRestarting: boolean;
  quitStatusKnown: boolean;
  requestingQuit: boolean;
  quitReadError: boolean;
  dismissed: ReadonlySet<string>;
  dismiss: (id: string) => void;
}

export const QuitBanners = ({
  quitting,
  quitStatus,
  shutdownStarted,
  updateRestarting,
  quitStatusKnown,
  requestingQuit,
  quitReadError,
  dismissed,
  dismiss,
}: QuitBanners) => {
  const { t } = useI18n();
  // These conditions are independent: several messages can show at once.
  return (
    <>
      {!quitting &&
        quitStatus.phase === 'failed' &&
        !dismissed.has(`quit-${quitStatus.attempt}`) && (
          <Alert onDismiss={() => dismiss(`quit-${quitStatus.attempt}`)}>{quitStatus.error}</Alert>
        )}
      {shutdownStarted && (
        <p role="status">
          {t(updateRestarting ? 'banners.readOnlyUpdate' : 'banners.readOnlyQuit')}
        </p>
      )}
      {!quitStatusKnown && !requestingQuit && (
        <p role="status">{t('banners.readOnlyUnconfirmed')}</p>
      )}
      {quitReadError && <p role="status">{t('banners.quitStatusUnknown')}</p>}
    </>
  );
};
