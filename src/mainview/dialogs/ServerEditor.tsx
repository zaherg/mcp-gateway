import { Eye, EyeOff, Lock, Minus, Plus } from 'lucide-react';
import { type FormEvent, type RefObject, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@mcp-gateway/mainview/components/mac/native-select';
import { Alert, CheckboxRow, Field, Modal } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import { generateToken } from '@mcp-gateway/mainview/lib/token';
import type { ConfigFormat } from '@mcp-gateway/shared/config-document';
import {
  isRecord,
  parseConfigDocument,
  SAFE_NAME,
  sensitiveEnvOverrides,
} from '@mcp-gateway/shared/config-document';
import type { ConfigFile, HttpServerConfig, StdioServerConfig } from '@mcp-gateway/shared/types';

export type Document = { text: string; revision: string; dirty: boolean };

export interface KeyValueRow {
  id: string;
  key: string;
  value: string;
  secret?: boolean;
}

export type Editor = {
  original: string | null;
  name: string;
  type: 'stdio' | 'http';
  command: string;
  args: string[];
  env: KeyValueRow[];
  cwd: string;
  url: string;
  headers: KeyValueRow[];
  disabled: boolean;
  legacyProtocol: boolean;
  /** `undefined` inherits the global key unless `tokenRef` is set; any string is this server's own key. */
  token: string | undefined;
  /** This server's key is in Keychain; carried unchanged until a new key replaces it. */
  tokenRef: string | undefined;
};

let rowSequence = 0;

export const createKeyValueRow = (
  key = '',
  value = '',
  secret = isDefaultSecretRow(key, value),
) => ({
  id: `kv-${++rowSequence}`,
  key,
  value,
  secret,
});

const isDefaultSecretRow = (key: string, value: string) => {
  if (!key && !value) return false;
  if (/\$\{[^}]+\}/.test(value)) return false;
  return (
    /^(authorization|x-api-key|api-key)$/i.test(key) ||
    /(-api-key|token|secret|password|key)$/i.test(key)
  );
};

export const recordToKeyValueRows = (record: Record<string, string> | undefined) => {
  if (!record) return [];
  return Object.entries(record).map(([key, value]) => createKeyValueRow(key, value));
};

const FORBIDDEN_MAP_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const keyValueRowsToRecord = (rows: readonly KeyValueRow[], message: string) => {
  const result = Object.create(null) as Record<string, string>;
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) {
      if (row.value.length > 0) throw new Error(message);
      continue;
    }
    if (FORBIDDEN_MAP_KEYS.has(key) || Object.hasOwn(result, key)) {
      throw new Error(message);
    }
    result[key] = row.value;
  }
  return { ...result };
};

const hasInvalidKeyValueRows = (rows: readonly KeyValueRow[]) => {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) {
      if (row.value.length > 0) return true;
      continue;
    }
    if (FORBIDDEN_MAP_KEYS.has(key) || seen.has(key)) return true;
    seen.add(key);
  }
  return false;
};

const stringMap = (value: unknown): value is Record<string, string> => {
  return (
    isRecord(value) &&
    !Object.hasOwn(value, '__proto__') &&
    Object.values(value).every((item) => typeof item === 'string')
  );
};
/** Parses an editor JSON field that must hold an object of string values. */
export const parseStringMap = (text: string, message: string) => {
  const value: unknown = JSON.parse(text || '{}');
  if (!stringMap(value)) throw new Error(message);
  return value;
};
const isBackend = (value: unknown): value is StdioServerConfig | HttpServerConfig => {
  if (
    !isRecord(value) ||
    (value.disabled !== undefined && typeof value.disabled !== 'boolean') ||
    (value.legacyProtocol !== undefined && typeof value.legacyProtocol !== 'boolean') ||
    (value.token !== undefined && typeof value.token !== 'string') ||
    (value.tokenRef !== undefined && typeof value.tokenRef !== 'string')
  )
    return false;
  if ('url' in value)
    return (
      typeof value.url === 'string' && (value.headers === undefined || stringMap(value.headers))
    );
  return (
    typeof value.command === 'string' &&
    (value.args === undefined ||
      (Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string'))) &&
    (value.env === undefined || stringMap(value.env)) &&
    (value.cwd === undefined || typeof value.cwd === 'string')
  );
};
const isFormConfig = (value: unknown): value is ConfigFile => {
  if (!isRecord(value) || !isRecord(value.gateway) || !isRecord(value.mcpServers)) return false;
  const { gateway, mcpServers } = value;
  return (
    typeof gateway.host === 'string' &&
    typeof gateway.port === 'number' &&
    // Exactly one key form; native validation reports which rule failed.
    (typeof gateway.token === 'string') !== (typeof gateway.tokenRef === 'string') &&
    (gateway.token === undefined || typeof gateway.token === 'string') &&
    (gateway.tokenRef === undefined || typeof gateway.tokenRef === 'string') &&
    (gateway.autoStart === undefined || typeof gateway.autoStart === 'boolean') &&
    (gateway.launchAtLogin === undefined || typeof gateway.launchAtLogin === 'boolean') &&
    (gateway.keepAwake === undefined || typeof gateway.keepAwake === 'boolean') &&
    (gateway.allowedPeers === undefined ||
      (Array.isArray(gateway.allowedPeers) &&
        gateway.allowedPeers.every((item) => typeof item === 'string'))) &&
    Object.values(mcpServers).every(isBackend)
  );
};
// This guard is for rendering only. Native validation remains authoritative on every save.
export const formConfig = (text: string, format: ConfigFormat) => {
  try {
    const value = parseConfigDocument(text, format);
    // The parsed document keeps every field, including unknown ones for native rejection.
    return isFormConfig(value) ? value : null;
  } catch {
    return null;
  }
};
export const emptyEditor = (): Editor => ({
  original: null,
  name: '',
  type: 'stdio',
  command: '',
  args: [],
  env: [],
  cwd: '',
  url: '',
  headers: [],
  disabled: false,
  legacyProtocol: false,
  token: undefined,
  tokenRef: undefined,
});
/** The macOS Bear preset fields; a name the user already typed is kept. */
export const bearPreset = (name = '') => ({
  name: name || 'bear',
  command: '/Applications/Bear.app/Contents/MacOS/bearcli',
  args: ['mcp-server'],
});

interface ArgsListEditorProps {
  args: string[];
  readOnly: boolean;
  onChange: (args: string[]) => void;
}

const ArgsListEditor = ({ args, readOnly, onChange }: ArgsListEditorProps) => {
  const updateArg = (index: number, value: string) => {
    const next = [...args];
    next[index] = value;
    onChange(next);
  };
  const removeArg = (index: number) => {
    onChange(args.filter((_, idx) => idx !== index));
  };
  const addArg = () => {
    onChange([...args, '']);
  };
  return (
    <div className="args-list flex flex-col gap-1.5">
      {args.map((arg, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered string arguments array edited by index.
        <div key={index} className="flex items-center gap-1.5">
          <Input
            value={arg}
            readOnly={readOnly}
            placeholder={`--arg-${index + 1}`}
            onChange={(event) => updateArg(index, event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !readOnly) {
                event.preventDefault();
                addArg();
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={readOnly}
            aria-label={`Remove argument ${index + 1}`}
            onClick={() => removeArg(index)}
          >
            <Minus />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" disabled={readOnly} onClick={addArg}>
          <Plus /> Add Argument
        </Button>
      </div>
    </div>
  );
};

interface KeyValueTableEditorProps {
  rows: KeyValueRow[];
  readOnly: boolean;
  onChange: (rows: KeyValueRow[]) => void;
}

const KeyValueTableEditor = ({ rows, readOnly, onChange }: KeyValueTableEditorProps) => {
  const updateRow = (id: string, patch: Partial<KeyValueRow>) => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };
  const removeRow = (id: string) => {
    onChange(rows.filter((row) => row.id !== id));
  };
  const addRow = () => {
    onChange([...rows, createKeyValueRow()]);
  };
  return (
    <div className="kv-table flex flex-col gap-1.5">
      {rows.map((row) => {
        const isEnvRef = /\$\{[^}]+\}/.test(row.value);
        return (
          <div key={row.id} className="flex items-center gap-1.5">
            <Input
              value={row.key}
              readOnly={readOnly}
              placeholder="KEY"
              onChange={(event) => updateRow(row.id, { key: event.target.value })}
            />
            <Input
              type={row.secret ? 'password' : 'text'}
              value={row.value}
              readOnly={readOnly}
              placeholder="value or ${ENV_VAR}"
              onChange={(event) => updateRow(row.id, { value: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={readOnly}
              aria-label={row.secret ? 'Show value' : 'Mask value'}
              title={
                isEnvRef
                  ? 'Environment variable reference'
                  : row.secret
                    ? 'Show value'
                    : 'Mask secret value'
              }
              onClick={() => updateRow(row.id, { secret: !row.secret })}
            >
              {isEnvRef ? <Lock /> : row.secret ? <EyeOff /> : <Eye />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={readOnly}
              aria-label={`Remove ${row.key || 'row'}`}
              onClick={() => removeRow(row.id)}
            >
              <Minus />
            </Button>
          </div>
        );
      })}
      <div>
        <Button type="button" disabled={readOnly} onClick={addRow}>
          <Plus /> Add Row
        </Button>
      </div>
    </div>
  );
};

interface ServerEditor {
  editor: Editor;
  existingNames?: ReadonlySet<string>;
  editorError: string | null;
  configurationLocked: boolean;
  fallbackFocus: RefObject<HTMLElement | null>;
  onChange: (patch: Partial<Editor>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  onDismissError: () => void;
}

const rowsToEnvPreview = (rows: readonly KeyValueRow[]) => {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key && !FORBIDDEN_MAP_KEYS.has(key)) env[key] = row.value;
  }
  return env;
};

export const ServerEditor = ({
  editor,
  existingNames,
  editorError,
  configurationLocked,
  fallbackFocus,
  onChange,
  onClose,
  onSubmit,
  onDismissError,
}: ServerEditor) => {
  const { t } = useI18n();
  // Local reveal only; it resets whenever the dialog unmounts.
  const [showKey, setShowKey] = useState(false);
  const [dismissedEnvSignature, setDismissedEnvSignature] = useState<string | null>(null);
  const trimmedName = editor.name.trim();
  const isDuplicateName =
    trimmedName.length > 0 &&
    trimmedName !== editor.original &&
    Boolean(existingNames?.has(trimmedName));
  const isInvalidName = trimmedName.length > 0 && !SAFE_NAME.test(trimmedName);
  const hasInvalidEnv = editor.type === 'stdio' && hasInvalidKeyValueRows(editor.env);
  const hasInvalidHeaders = editor.type === 'http' && hasInvalidKeyValueRows(editor.headers);
  const sensitiveKeys =
    editor.type === 'stdio' ? sensitiveEnvOverrides(rowsToEnvPreview(editor.env)) : [];
  const envSignature = sensitiveKeys.join(',');
  return (
    <Modal
      title={editor.original ? t('common.editServer') : t('editor.addTitle')}
      onClose={onClose}
      fallbackFocus={fallbackFocus}
      busy={configurationLocked}
    >
      <form onSubmit={onSubmit}>
        <p className="dialog-intro">
          {configurationLocked ? t('editor.lockedIntro') : t('editor.intro')}
        </p>
        {editorError && <Alert onDismiss={onDismissError}>{editorError}</Alert>}
        <Field label={t('editor.name')} help={t('editor.nameHelp', { path: '/mcp/server-name' })}>
          <Input
            required
            value={editor.name}
            readOnly={configurationLocked}
            aria-invalid={isDuplicateName || isInvalidName || undefined}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
        {(isDuplicateName || isInvalidName) && (
          <p className="inline-error" role="alert">
            {isDuplicateName ? t('app.serverExists') : t('app.serverFieldsInvalid')}
          </p>
        )}
        <Field label={t('editor.transport')}>
          <NativeSelect
            value={editor.type}
            disabled={configurationLocked}
            onChange={(event) =>
              onChange({ type: event.target.value === 'http' ? 'http' : 'stdio' })
            }
          >
            <NativeSelectOption value="stdio">{t('editor.transportStdio')}</NativeSelectOption>
            <NativeSelectOption value="http">{t('common.streamableHttp')}</NativeSelectOption>
          </NativeSelect>
        </Field>
        {editor.type === 'stdio' ? (
          <>
            <Field label={t('editor.command')} help={t('editor.commandHelp')}>
              <Input
                required
                value={editor.command}
                readOnly={configurationLocked}
                placeholder="/path/to/mcp-server"
                onChange={(event) => onChange({ command: event.target.value })}
              />
            </Field>
            <Field label={t('editor.args')}>
              <ArgsListEditor
                args={editor.args}
                readOnly={configurationLocked}
                onChange={(args) => onChange({ args })}
              />
            </Field>
            <div className="form-grid">
              <Field label={t('editor.env')}>
                <KeyValueTableEditor
                  rows={editor.env}
                  readOnly={configurationLocked}
                  onChange={(env) => onChange({ env })}
                />
              </Field>
              <Field label={t('editor.cwd')} help={t('editor.cwdHelp')}>
                <Input
                  value={editor.cwd}
                  readOnly={configurationLocked}
                  placeholder="/Users/you"
                  onChange={(event) => onChange({ cwd: event.target.value })}
                />
              </Field>
            </div>
            {hasInvalidEnv && (
              <p className="inline-error" role="alert">
                {t('app.environmentInvalid')}
              </p>
            )}
            {sensitiveKeys.length > 0 && dismissedEnvSignature !== envSignature && (
              <Alert kind="warning" onDismiss={() => setDismissedEnvSignature(envSignature)}>
                {`Overrides sensitive execution environment variable(s): ${sensitiveKeys.join(', ')}`}
              </Alert>
            )}
            <div className="preset-row">
              <Button
                disabled={configurationLocked}
                onClick={() => onChange(bearPreset(editor.name))}
              >
                {t('editor.bearPreset')}
              </Button>
              <small>{t('editor.bearNote')}</small>
            </div>
          </>
        ) : (
          <>
            <Field label={t('editor.url')} help={t('editor.urlHelp', { scheme: 'HTTP(S)' })}>
              <Input
                required
                value={editor.url}
                readOnly={configurationLocked}
                placeholder="https://your-server.example/mcp"
                onChange={(event) => onChange({ url: event.target.value })}
              />
            </Field>
            <Field
              label={t('editor.headers')}
              // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal environment reference.
              help={t('editor.headersHelp', { example: '${API_TOKEN}' })}
            >
              <KeyValueTableEditor
                rows={editor.headers}
                readOnly={configurationLocked}
                onChange={(headers) => onChange({ headers })}
              />
            </Field>
            {hasInvalidHeaders && (
              <p className="inline-error" role="alert">
                {t('app.headersInvalid')}
              </p>
            )}
          </>
        )}
        <Field label={t('editor.auth')} help={t('editor.authHelp')}>
          <NativeSelect
            value={
              editor.token === undefined && editor.tokenRef === undefined ? 'global' : 'custom'
            }
            disabled={configurationLocked}
            onChange={(event) =>
              onChange({
                token: event.target.value === 'custom' ? '' : undefined,
                tokenRef: undefined,
              })
            }
          >
            <NativeSelectOption value="global">{t('editor.authGlobal')}</NativeSelectOption>
            <NativeSelectOption value="custom">{t('editor.authCustom')}</NativeSelectOption>
          </NativeSelect>
        </Field>
        {editor.tokenRef !== undefined && (
          <Field label={t('editor.key')} help={t('editor.keyHelp')}>
            <p className="m-0 text-[13px]">{t('keys.stored')}</p>
          </Field>
        )}
        {editor.token !== undefined && (
          <Field label={t('editor.key')} help={t('editor.keyHelp')}>
            <div className="token-input">
              <Input
                autoComplete="off"
                spellCheck={false}
                readOnly={configurationLocked}
                type={showKey ? 'text' : 'password'}
                value={editor.token}
                placeholder="${PRIVATE_MCP_TOKEN}"
                onChange={(event) => onChange({ token: event.target.value })}
              />
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label={showKey ? t('editor.hideKey') : t('editor.showKey')}
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? <EyeOff /> : <Eye />}
              </Button>
            </div>
          </Field>
        )}
        {(editor.token !== undefined || editor.tokenRef !== undefined) && (
          <Button
            size="lg"
            disabled={configurationLocked}
            // A new literal replaces a Keychain reference; that is also the repair for an unreadable item.
            onClick={() => onChange({ token: generateToken(), tokenRef: undefined })}
          >
            {t('editor.generateKey')}
          </Button>
        )}
        <CheckboxRow
          label={t('editor.legacy')}
          checked={editor.legacyProtocol}
          disabled={configurationLocked}
          onChange={(legacyProtocol) => onChange({ legacyProtocol })}
        />
        <CheckboxRow
          label={t('editor.disabled')}
          checked={editor.disabled}
          disabled={configurationLocked}
          onChange={(disabled) => onChange({ disabled })}
        />
        <div className="dialog-actions">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            type="submit"
            variant="default"
            disabled={
              configurationLocked ||
              isDuplicateName ||
              isInvalidName ||
              hasInvalidEnv ||
              hasInvalidHeaders
            }
          >
            {t('editor.apply')}
          </Button>
        </div>
        <small className="dialog-footnote">{t('editor.footnote')}</small>
      </form>
    </Modal>
  );
};
