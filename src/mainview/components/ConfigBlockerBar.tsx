import { AlertTriangle } from 'lucide-react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { VisibleError } from '@mcp-gateway/shared/types';

interface ConfigBlockerBarProps {
  configError: VisibleError | null | undefined;
  stale: boolean;
  disabled?: boolean;
  onOpenRawConfig: () => void;
  onReloadFromDisk: () => void;
}

export const ConfigBlockerBar = ({
  configError,
  stale,
  disabled = false,
  onOpenRawConfig,
  onReloadFromDisk,
}: ConfigBlockerBarProps) => {
  const { t } = useI18n();
  if (!configError && !stale) return null;

  const isConfigError = Boolean(configError);
  const message =
    configError !== null && configError !== undefined
      ? configError.code === 'KeySetupFailed'
        ? configError.message
        : t('banners.configUnavailable', { message: configError.message })
      : t('banners.stale');

  return (
    <div
      role="alert"
      className="config-blocker-bar mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-mac-red/35 bg-mac-red/10 px-3.5 py-2.5 text-[13px] text-mac-label"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <AlertTriangle size={16} className="shrink-0 text-mac-red-ink" aria-hidden="true" />
        <span className="min-w-0 flex-1 wrap-anywhere">{message}</span>
      </div>
      {isConfigError ? (
        <Button size="lg" variant="default" disabled={disabled} onClick={onOpenRawConfig}>
          {t('raw.title')}
        </Button>
      ) : (
        <Button size="lg" variant="default" disabled={disabled} onClick={onReloadFromDisk}>
          {t('raw.reset')}
        </Button>
      )}
    </div>
  );
};
