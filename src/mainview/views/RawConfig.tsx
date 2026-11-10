import type { RefObject } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Textarea } from '@mcp-gateway/mainview/components/mac/textarea';
import { Field } from '@mcp-gateway/mainview/components/ui';
import type { Document } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import type { ConfigFormat } from '@mcp-gateway/shared/config-document';
import type { GatewaySnapshot } from '@mcp-gateway/shared/types';

interface RawConfig {
  doc: Document;
  setDoc: (doc: Document) => void;
  configurationLocked: boolean;
  format: ConfigFormat;
  filename: string;
  gateway: GatewaySnapshot | undefined;
  dirty: boolean;
  retryLogin: boolean;
  save: () => Promise<boolean>;
  rawOpen: boolean;
  setRawOpen: (open: boolean) => void;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
  setNotice: (notice: string) => void;
}

export const RawConfig = ({
  doc,
  setDoc,
  configurationLocked,
  format,
  filename,
  gateway,
  dirty,
  retryLogin,
  save,
  rawOpen,
  setRawOpen,
  fallbackFocus,
  setNotice,
}: RawConfig) => {
  return (
    <section className="panel raw-panel">
      <button
        type="button"
        className="raw-heading"
        ref={fallbackFocus}
        aria-expanded={rawOpen}
        onClick={() => setRawOpen(!rawOpen)}
      >
        <span>
          <strong>Authoritative configuration</strong>
          <small>{filename} · advanced editing</small>
        </span>
      </button>
      {rawOpen && (
        <div className="raw-body">
          <p className="mono config-path">{gateway?.configPath}</p>
          <p>
            Full file contents, including credentials. Invalid saves are rejected without discarding
            your draft. Preserve a copy of your edits before reloading external changes.{' '}
            {format === 'jsonc'
              ? 'JSONC accepts // and /* */ comments and trailing commas.'
              : 'Strict JSON: comments and trailing commas are not allowed.'}{' '}
            Changing the filename requires reopening the app.
          </p>
          <Field label={filename}>
            <Textarea
              className="min-h-87.5 text-[11px] whitespace-pre [tab-size:2]"
              readOnly={configurationLocked}
              spellCheck={false}
              value={doc.text}
              onChange={(event) => {
                if (configurationLocked) return;
                setDoc({ ...doc, text: event.target.value, dirty: true });
                setNotice('');
              }}
            />
          </Field>
          <Button
            variant="default"
            disabled={configurationLocked || (!dirty && !retryLogin)}
            onClick={() => void save()}
          >
            Save {filename}
          </Button>
        </div>
      )}
    </section>
  );
};
