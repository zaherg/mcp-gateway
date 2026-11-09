import { Alert } from '@mcp-gateway/mainview/components/ui';

export const NoticeBanner = ({ notice, onDismiss }: { notice: string; onDismiss: () => void }) => {
  if (!notice) return null;
  return (
    <Alert kind="success" label="Dismiss notification" onDismiss={onDismiss}>
      {notice}
    </Alert>
  );
};
