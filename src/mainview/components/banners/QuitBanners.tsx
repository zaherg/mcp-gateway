import { Alert } from '@mcp-gateway/mainview/components/ui';
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
          Configuration is read-only because{' '}
          {updateRestarting ? 'an update restart has started' : 'Quit cleanup has started'}. Drafts
          can still be selected and copied, and Logs remain available.
        </p>
      )}
      {!quitStatusKnown && !requestingQuit && (
        <p role="status">Configuration is read-only until Quit status is confirmed.</p>
      )}
      {quitReadError && (
        <p role="status">Could not read Quit status. Cleanup completion is unknown.</p>
      )}
    </>
  );
};
