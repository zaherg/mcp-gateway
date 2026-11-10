import { Button } from '@mcp-gateway/mainview/components/mac/button';
import type { Document } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import type { AppSnapshot } from '@mcp-gateway/shared/rpc';

interface DraftBar {
  dirty: boolean;
  retryLogin: boolean;
  configurationLocked: boolean;
  snapshot: AppSnapshot;
  setDoc: (doc: Document) => void;
  setError: (error: string | null) => void;
  save: () => Promise<boolean>;
  confirmDiscard: () => Promise<boolean>;
}

export const DraftBar = ({
  dirty,
  retryLogin,
  configurationLocked,
  snapshot,
  setDoc,
  setError,
  save,
  confirmDiscard,
}: DraftBar) => {
  if (!dirty && !retryLogin) return null;
  const discard = async () => {
    if (configurationLocked || !(await confirmDiscard())) return;
    setDoc({
      text: snapshot.gateway.configText,
      revision: snapshot.gateway.revision,
      dirty: false,
    });
    setError(null);
  };
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
