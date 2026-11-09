import { Alert } from '@mcp-gateway/mainview/components/ui';

export const LocalErrorBanner = ({
  error,
  onDismiss,
}: {
  error: string | null;
  onDismiss: () => void;
}) => {
  if (!error) return null;
  return <Alert onDismiss={onDismiss}>{error}</Alert>;
};
