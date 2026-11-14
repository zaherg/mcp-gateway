import { GatewayErrorBanners } from '@mcp-gateway/mainview/components/banners/GatewayErrorBanners';
import { LocalErrorBanner } from '@mcp-gateway/mainview/components/banners/LocalErrorBanner';
import { LoginStartupBanner } from '@mcp-gateway/mainview/components/banners/LoginStartupBanner';
import { NoticeBanner } from '@mcp-gateway/mainview/components/banners/NoticeBanner';
import { QuitBanners } from '@mcp-gateway/mainview/components/banners/QuitBanners';
import { StaleConfigBanner } from '@mcp-gateway/mainview/components/banners/StaleConfigBanner';
import { UpdateBanners } from '@mcp-gateway/mainview/components/banners/UpdateBanners';
import type { Tab } from '@mcp-gateway/mainview/components/Shell';
import type { AppSnapshot, QuitStatus, UpdateStatus } from '@mcp-gateway/shared/rpc';
import type { GatewayConfig, GatewaySnapshot } from '@mcp-gateway/shared/types';

interface Banners {
  error: string | null;
  dismissLocalError: () => void;
  updateState: UpdateStatus | undefined;
  tab: Tab;
  dismissed: Set<string>;
  dismiss: (id: string) => void;
  quitting: boolean;
  quitStatus: QuitStatus;
  shutdownStarted: boolean;
  updateRestarting: boolean;
  quitStatusKnown: boolean;
  requestingQuit: boolean;
  quitReadError: boolean;
  notice: string;
  setNotice: (notice: string) => void;
  gateway: GatewaySnapshot | undefined;
  errorOccurrence: string | null;
  config: GatewayConfig | null;
  configurationLocked: boolean;
  snapshot: AppSnapshot | undefined;
  loginWanted: boolean;
  loginInDraftBar: boolean;
  stale: boolean;
}

export const Banners = ({
  error,
  dismissLocalError,
  updateState,
  tab,
  dismissed,
  dismiss,
  quitting,
  quitStatus,
  shutdownStarted,
  updateRestarting,
  quitStatusKnown,
  requestingQuit,
  quitReadError,
  notice,
  setNotice,
  gateway,
  errorOccurrence,
  config,
  configurationLocked,
  snapshot,
  loginWanted,
  loginInDraftBar,
  stale,
}: Banners) => {
  // Logs is a read-only inspector. It keeps local errors, notices and Quit status, which its own
  // header can cause, and hides passive status that belongs to Overview and Settings.
  const showStatus = tab !== 'logs';
  // Children render in this order and return fragments, so the stack stays `:empty` when idle.
  return (
    <div className="announcements" aria-live="polite">
      <LocalErrorBanner error={error} onDismiss={dismissLocalError} />
      <UpdateBanners
        updateState={updateState}
        showErrors={showStatus}
        dismissed={dismissed}
        dismiss={dismiss}
      />
      <QuitBanners
        quitting={quitting}
        quitStatus={quitStatus}
        shutdownStarted={shutdownStarted}
        updateRestarting={updateRestarting}
        quitStatusKnown={quitStatusKnown}
        requestingQuit={requestingQuit}
        quitReadError={quitReadError}
        dismissed={dismissed}
        dismiss={dismiss}
      />
      <NoticeBanner notice={notice} onDismiss={() => setNotice('')} />
      {showStatus && (
        <GatewayErrorBanners
          configError={gateway?.configError ?? null}
          operationalError={gateway?.operationalError ?? null}
          hasLocalError={Boolean(error)}
          errorOccurrence={errorOccurrence}
          hasRetainedConfig={config !== null}
          configurationLocked={configurationLocked}
          dismissed={dismissed}
          dismiss={dismiss}
        />
      )}
      {/* Login warnings belong to Settings, which also hosts the retry action. */}
      {tab === 'settings' && (
        <LoginStartupBanner
          login={snapshot?.login}
          loginWanted={loginWanted}
          loginInDraftBar={loginInDraftBar}
          dismissed={dismissed}
          dismiss={dismiss}
        />
      )}
      {showStatus && (
        <StaleConfigBanner
          stale={stale}
          revision={gateway?.revision}
          dismissed={dismissed}
          dismiss={dismiss}
        />
      )}
    </div>
  );
};
