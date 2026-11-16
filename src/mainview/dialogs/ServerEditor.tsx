import { Eye, EyeOff } from 'lucide-react';
import { type FormEvent, type RefObject, useState } from 'react';

import { JsonEditor } from '@mcp-gateway/mainview/components/JsonEditor';
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
import { isRecord, parseConfigDocument } from '@mcp-gateway/shared/config-document';
import type { GatewayConfig, HttpServerConfig, StdioServerConfig } from '@mcp-gateway/shared/types';

export type Backend = StdioServerConfig | HttpServerConfig;
export type Document = { text: string; revision: string; dirty: boolean };
export type Editor = {
  original: string | null;
  name: string;
  type: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  disabled: boolean;
  legacyProtocol: boolean;
  /** `undefined` inherits the global key; any string is this server's own key. */
  token: string | undefined;
};

const stringMap = (value: unknown): value is Record<string, string> => {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
};
/** Parses an editor JSON field that must hold an object of string values. */
export const parseStringMap = (text: string, message: string): Record<string, string> => {
  const value: unknown = JSON.parse(text || '{}');
  if (!stringMap(value)) throw new Error(message);
  return value;
};
const isBackend = (value: unknown): value is Backend => {
  if (
    !isRecord(value) ||
    (value.disabled !== undefined && typeof value.disabled !== 'boolean') ||
    (value.legacyProtocol !== undefined && typeof value.legacyProtocol !== 'boolean') ||
    (value.token !== undefined && typeof value.token !== 'string')
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
const isFormConfig = (value: unknown): value is GatewayConfig => {
  if (!isRecord(value) || !isRecord(value.gateway) || !isRecord(value.mcpServers)) return false;
  const { gateway, mcpServers } = value;
  return (
    typeof gateway.host === 'string' &&
    typeof gateway.port === 'number' &&
    typeof gateway.token === 'string' &&
    (gateway.autoStart === undefined || typeof gateway.autoStart === 'boolean') &&
    (gateway.launchAtLogin === undefined || typeof gateway.launchAtLogin === 'boolean') &&
    (gateway.allowedPeers === undefined ||
      (Array.isArray(gateway.allowedPeers) &&
        gateway.allowedPeers.every((item) => typeof item === 'string'))) &&
    Object.values(mcpServers).every(isBackend)
  );
};
// This guard is for rendering only. Native validation remains authoritative on every save.
export const formConfig = (text: string, format: ConfigFormat): GatewayConfig | null => {
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
  args: '[]',
  env: '{}',
  cwd: '',
  url: '',
  headers: '{}',
  disabled: false,
  legacyProtocol: false,
  token: undefined,
});
/** The macOS Bear preset fields; a name the user already typed is kept. */
export const bearPreset = (name = ''): Pick<Editor, 'name' | 'command' | 'args'> => ({
  name: name || 'bear',
  command: '/Applications/Bear.app/Contents/MacOS/bearcli',
  args: '["mcp-server"]',
});

interface ServerEditor {
  editor: Editor;
  editorError: string | null;
  configurationLocked: boolean;
  fallbackFocus: RefObject<HTMLElement | null>;
  onChange: (patch: Partial<Editor>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  onDismissError: () => void;
}

export const ServerEditor = ({
  editor,
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
  return (
    <Modal
      title={editor.original ? t('common.editServer') : t('editor.addTitle')}
      onClose={onClose}
      fallbackFocus={fallbackFocus}
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
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
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
              <JsonEditor
                value={editor.args}
                readOnly={configurationLocked}
                onChange={(args) => onChange({ args })}
              />
            </Field>
            <div className="form-grid">
              <Field label={t('editor.env')}>
                <JsonEditor
                  value={editor.env}
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
              <JsonEditor
                value={editor.headers}
                readOnly={configurationLocked}
                onChange={(headers) => onChange({ headers })}
              />
            </Field>
          </>
        )}
        <Field label={t('editor.auth')} help={t('editor.authHelp')}>
          <NativeSelect
            value={editor.token === undefined ? 'global' : 'custom'}
            disabled={configurationLocked}
            onChange={(event) =>
              onChange({ token: event.target.value === 'custom' ? '' : undefined })
            }
          >
            <NativeSelectOption value="global">{t('editor.authGlobal')}</NativeSelectOption>
            <NativeSelectOption value="custom">{t('editor.authCustom')}</NativeSelectOption>
          </NativeSelect>
        </Field>
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
        {editor.token !== undefined && (
          <Button
            size="lg"
            disabled={configurationLocked}
            onClick={() => onChange({ token: generateToken() })}
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
          <Button type="submit" variant="default" disabled={configurationLocked}>
            {t('editor.apply')}
          </Button>
        </div>
        <small className="dialog-footnote">{t('editor.footnote')}</small>
      </form>
    </Modal>
  );
};
