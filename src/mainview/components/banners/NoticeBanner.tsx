import { Alert } from '@mcp-gateway/mainview/components/ui';

interface NoticeBanner {
  notice: string;
  onDismiss: () => void;
}

export const NoticeBanner = ({ notice, onDismiss }: NoticeBanner) => {
  if (!notice) return null;
  return (
    <Alert kind="success" label="Dismiss notification" onDismiss={onDismiss}>
      {notice}
    </Alert>
  );
};
