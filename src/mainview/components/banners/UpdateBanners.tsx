import { Alert } from '@mcp-gateway/mainview/components/ui';
import type { UpdateStatus } from '@mcp-gateway/shared/rpc';

export const UpdateBanners = ({
  updateState,
  showAvailableNotice,
  showErrors,
  dismissed,
  dismiss,
}: {
  updateState: UpdateStatus | undefined;
  showAvailableNotice: boolean;
  showErrors: boolean;
  dismissed: ReadonlySet<string>;
  dismiss: (id: string) => void;
}) => {
  if (!updateState) return null;
  const available =
    showAvailableNotice && (updateState.phase === 'available' || updateState.phase === 'ready');
  const failed = showErrors && updateState.phase === 'error';
  // App retains acknowledgements under this same key, so a new phase, version or error shows again.
  const id = `update-${updateState.phase}-${updateState.availableVersion ?? ''}-${updateState.error ?? ''}`;
  if ((!available && !failed) || dismissed.has(id)) return null;
  if (available) {
    return (
      <Alert
        kind="warning"
        role="status"
        label="Dismiss update notice"
        onDismiss={() => dismiss(id)}
      >
        {updateState.phase === 'ready'
          ? `Version ${updateState.availableVersion} is ready to install.`
          : `Version ${updateState.availableVersion} is available.`}{' '}
        Open Settings → Updates to review and confirm.
      </Alert>
    );
  }
  return (
    <Alert onDismiss={() => dismiss(id)}>
      Update: {updateState.error ?? 'The update operation failed.'}
    </Alert>
  );
};
