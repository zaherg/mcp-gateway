import { Alert } from '@mcp-gateway/mainview/components/ui';
import type { UpdateStatus } from '@mcp-gateway/shared/rpc';

interface UpdateBanners {
  updateState: UpdateStatus | undefined;
  showErrors: boolean;
  dismissed: ReadonlySet<string>;
  dismiss: (id: string) => void;
}

export const UpdateBanners = ({ updateState, showErrors, dismissed, dismiss }: UpdateBanners) => {
  if (!updateState || !showErrors || updateState.phase !== 'error') return null;
  // App retains acknowledgements under this same key, so a new phase, version or error shows again.
  const id = `update-${updateState.phase}-${updateState.availableVersion ?? ''}-${updateState.error ?? ''}`;
  if (dismissed.has(id)) return null;
  return (
    <Alert onDismiss={() => dismiss(id)}>
      Update: {updateState.error ?? 'The update operation failed.'}
    </Alert>
  );
};
