import { Alert } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { VisibleError } from '@mcp-gateway/shared/types';

interface GatewayErrorBanners {
  configError: VisibleError | null;
  operationalError: VisibleError | null;
  hasLocalError: boolean;
  errorOccurrence: string | null;
  hasRetainedConfig: boolean;
  configurationLocked: boolean;
  dismissed: ReadonlySet<string>;
  dismiss: (id: string) => void;
}

export const GatewayErrorBanners = ({
  configError,
  operationalError,
  hasLocalError,
  errorOccurrence,
  hasRetainedConfig,
  configurationLocked,
  dismissed,
  dismiss,
}: GatewayErrorBanners) => {
  const { t } = useI18n();
  // A local error with the same occurrence already reports this failure.
  const reportedLocally = (occurrenceId: string) =>
    hasLocalError && errorOccurrence === occurrenceId;
  return (
    <>
      {configError &&
        !reportedLocally(configError.occurrenceId) &&
        !dismissed.has(`config-${configError.occurrenceId}`) && (
          <Alert onDismiss={() => dismiss(`config-${configError.occurrenceId}`)}>
            {t('banners.configUnavailable', { message: configError.message })}{' '}
            {hasRetainedConfig && !configurationLocked
              ? t('banners.retainedDraft')
              : t('banners.editingPaused')}
          </Alert>
        )}
      {operationalError &&
        !reportedLocally(operationalError.occurrenceId) &&
        !dismissed.has(`operation-${operationalError.occurrenceId}`) && (
          <Alert onDismiss={() => dismiss(`operation-${operationalError.occurrenceId}`)}>
            {operationalError.code}: {operationalError.message}
          </Alert>
        )}
    </>
  );
};
