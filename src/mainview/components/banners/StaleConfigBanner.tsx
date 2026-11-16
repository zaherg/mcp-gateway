import { Alert } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';

interface StaleConfigBanner {
  stale: boolean;
  revision: string | undefined;
  dismissed: ReadonlySet<string>;
  dismiss: (id: string) => void;
}

export const StaleConfigBanner = ({ stale, revision, dismissed, dismiss }: StaleConfigBanner) => {
  const { t } = useI18n();
  // App retains acknowledgements under this same key; without a snapshot it is `stale-undefined`.
  if (!stale || dismissed.has(`stale-${revision}`)) return null;
  return (
    <Alert kind="warning" role="status" onDismiss={() => dismiss(`stale-${revision}`)}>
      {t('banners.stale')}
    </Alert>
  );
};
