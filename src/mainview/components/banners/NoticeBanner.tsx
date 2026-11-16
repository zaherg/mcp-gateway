import { Alert } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';

interface NoticeBanner {
  notice: string;
  onDismiss: () => void;
}

export const NoticeBanner = ({ notice, onDismiss }: NoticeBanner) => {
  const { t } = useI18n();
  if (!notice) return null;
  return (
    <Alert kind="success" label={t('banners.dismissNotification')} onDismiss={onDismiss}>
      {notice}
    </Alert>
  );
};
