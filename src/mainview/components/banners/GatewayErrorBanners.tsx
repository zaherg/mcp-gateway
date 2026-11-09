import { Alert } from '@mcp-gateway/mainview/components/ui';
import type { VisibleError } from '@mcp-gateway/shared/types';

export const GatewayErrorBanners = ({
  configError,
  operationalError,
  hasLocalError,
  errorOccurrence,
  hasRetainedConfig,
  configurationLocked,
  dismissed,
  dismiss,
}: {
  configError: VisibleError | null;
  operationalError: VisibleError | null;
  hasLocalError: boolean;
  errorOccurrence: string | null;
  hasRetainedConfig: boolean;
  configurationLocked: boolean;
  dismissed: ReadonlySet<string>;
  dismiss: (id: string) => void;
}) => {
  // A local error with the same occurrence already reports this failure.
  const reportedLocally = (occurrenceId: string) =>
    hasLocalError && errorOccurrence === occurrenceId;
  return (
    <>
      {configError &&
        !reportedLocally(configError.occurrenceId) &&
        !dismissed.has(`config-${configError.occurrenceId}`) && (
          <Alert onDismiss={() => dismiss(`config-${configError.occurrenceId}`)}>
            Configuration unavailable: {configError.message} Open the configuration editor to repair
            the authoritative file.{' '}
            {hasRetainedConfig && !configurationLocked
              ? 'The retained draft remains editable. Review external changes before saving.'
              : 'Structured editing is paused.'}
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
