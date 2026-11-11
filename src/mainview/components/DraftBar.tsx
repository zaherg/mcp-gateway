import { Button } from '@mcp-gateway/mainview/components/mac/button';
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
  if (!dirty && !retryLogin) return null;
  return (
    <div className="draft-bar">
      <span>
        <strong>{dirty ? 'Unsaved changes' : 'Login registration unresolved'}</strong>
        <small>
          {dirty
            ? 'Live endpoints still use the saved configuration.'
            : `${snapshot.login.error ? `${snapshot.login.error} ` : ''}Save again to retry the requested login setting.`}
        </small>
      </span>
      <div>
        {dirty && (
          <Button disabled={configurationLocked} onClick={() => void discard()}>
            Discard
          </Button>
        )}
        <Button variant="default" disabled={configurationLocked} onClick={() => void save()}>
          {dirty ? 'Save changes' : 'Retry login registration'}
        </Button>
      </div>
    </div>
  );
};
