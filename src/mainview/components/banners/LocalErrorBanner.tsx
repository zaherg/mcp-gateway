import { Alert } from '@mcp-gateway/mainview/components/ui';

interface LocalErrorBanner {
  error: string | null;
  onDismiss: () => void;
}

export const LocalErrorBanner = ({ error, onDismiss }: LocalErrorBanner) => {
  if (!error) return null;
  return <Alert onDismiss={onDismiss}>{error}</Alert>;
};
