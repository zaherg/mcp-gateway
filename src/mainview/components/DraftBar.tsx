import type { Document } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import type { AppSnapshot } from '@mcp-gateway/shared/rpc';

export const DraftBar = ({
  dirty,
  retryLogin,
  configurationLocked,
  snapshot,
  setDoc,
  setError,
  save,
}: {
  dirty: boolean;
  retryLogin: boolean;
  configurationLocked: boolean;
  snapshot: AppSnapshot;
  setDoc: (doc: Document) => void;
  setError: (error: string | null) => void;
  save: () => Promise<boolean>;
}) => {
  if (!dirty && !retryLogin) return null;
  return (
    <div className="draft-bar">
      <span>
        <strong>{dirty ? 'Unsaved changes' : 'Login registration unresolved'}</strong>
        <small>
          {dirty
            ? 'Live endpoints still use the saved configuration.'
            : 'Save again to retry the requested login setting.'}
        </small>
      </span>
      <div>
        {dirty && (
          <button
            type="button"
            className="button"
            disabled={configurationLocked}
            onClick={() => {
              if (
                !configurationLocked &&
                window.confirm('Discard all unsaved changes and load the latest configuration?')
              ) {
                setDoc({
                  text: snapshot.gateway.configText,
                  revision: snapshot.gateway.revision,
                  dirty: false,
                });
                setError(null);
              }
            }}
          >
            Discard
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={configurationLocked}
          onClick={() => void save()}
        >
          {dirty ? 'Save changes' : 'Retry login registration'}
        </button>
      </div>
    </div>
  );
};
