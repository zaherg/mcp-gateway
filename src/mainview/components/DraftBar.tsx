import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { AppSnapshot } from '@mcp-gateway/shared/rpc';

interface DraftBar {
  dirty: boolean;
  retryLogin: boolean;
  configurationLocked: boolean;
  snapshot: AppSnapshot;
  save: () => Promise<boolean>;
  discard: () => Promise<void>;
}

export const DraftBar = ({
  dirty,
  retryLogin,
  configurationLocked,
  snapshot,
  save,
  discard,
}: DraftBar) => {
  const { t } = useI18n();
  if (!dirty && !retryLogin) return null;
  return (
    <div className="draft-bar">
      <span>
        <strong>{dirty ? t('draft.unsaved') : t('draft.loginUnresolved')}</strong>
        <small>
          {dirty
            ? t('draft.liveEndpoints')
            : snapshot.login.error
              ? t('draft.loginRetryWithError', { error: snapshot.login.error })
              : t('draft.loginRetry')}
        </small>
      </span>
      <div>
        {dirty && (
          <Button disabled={configurationLocked} onClick={() => void discard()}>
            {t('draft.discard')}
          </Button>
        )}
        <Button variant="default" disabled={configurationLocked} onClick={() => void save()}>
          {dirty ? t('draft.save') : t('draft.retryLogin')}
        </Button>
      </div>
    </div>
  );
};
