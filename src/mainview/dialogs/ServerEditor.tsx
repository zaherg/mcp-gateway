import { Eye, EyeOff } from 'lucide-react';
import { type FormEvent, type RefObject, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Input } from '@mcp-gateway/mainview/components/mac/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@mcp-gateway/mainview/components/mac/native-select';
import { Textarea } from '@mcp-gateway/mainview/components/mac/textarea';
import { Alert, CheckboxRow, Field, Modal } from '@mcp-gateway/mainview/components/ui';
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
  // Local reveal only; it resets whenever the dialog unmounts.
  const [showKey, setShowKey] = useState(false);
  return (
    <Modal
      title={editor.original ? 'Edit server' : 'Add a server'}
      onClose={onClose}
      fallbackFocus={fallbackFocus}
    >
      <form onSubmit={onSubmit}>
        <p className="dialog-intro">
          {configurationLocked
            ? 'Quit cleanup has started. This draft is read-only; select and copy fields before closing.'
            : 'Connect a local tool or an existing MCP endpoint'}
        </p>
        {editorError && <Alert onDismiss={onDismissError}>{editorError}</Alert>}
        <Field
          label="Server name"
          help="Used in /mcp/server-name. Letters, numbers, hyphens and underscores."
        >
          <Input
            required
            value={editor.name}
            readOnly={configurationLocked}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
        <Field label="Transport">
          <NativeSelect
            value={editor.type}
            disabled={configurationLocked}
            onChange={(event) =>
              onChange({ type: event.target.value === 'http' ? 'http' : 'stdio' })
            }
          >
            <NativeSelectOption value="stdio">Local command (stdio)</NativeSelectOption>
            <NativeSelectOption value="http">Streamable HTTP</NativeSelectOption>
          </NativeSelect>
        </Field>
        {editor.type === 'stdio' ? (
          <>
            <Field
              label="Command"
              help="Executable path only. Arguments are passed separately, never through a shell."
            >
              <Input
                required
                value={editor.command}
                readOnly={configurationLocked}
                placeholder="/path/to/mcp-server"
                onChange={(event) => onChange({ command: event.target.value })}
              />
            </Field>
            <Field label="Arguments (JSON array)">
              <Textarea
                spellCheck={false}
                value={editor.args}
                readOnly={configurationLocked}
                onChange={(event) => onChange({ args: event.target.value })}
              />
            </Field>
            <div className="form-grid">
              <Field label="Environment (JSON object)">
                <Textarea
                  spellCheck={false}
                  value={editor.env}
                  readOnly={configurationLocked}
                  onChange={(event) => onChange({ env: event.target.value })}
                />
              </Field>
              <Field label="Working directory" help="Optional absolute path.">
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
                Fill Bear preset
              </Button>
              <small>Optional, macOS only. Bear exposes all accessible notes and tools.</small>
            </div>
          </>
        ) : (
          <>
            <Field label="Upstream URL" help="HTTP(S), without embedded credentials or fragments.">
              <Input
                required
                value={editor.url}
                readOnly={configurationLocked}
                placeholder="https://your-server.example/mcp"
                onChange={(event) => onChange({ url: event.target.value })}
              />
            </Field>
            <Field
              label="Headers (JSON object)"
              help="String values only. Prefer environment references such as ${API_TOKEN}."
            >
              <Textarea
                spellCheck={false}
                value={editor.headers}
                readOnly={configurationLocked}
                onChange={(event) => onChange({ headers: event.target.value })}
              />
            </Field>
          </>
        )}
        <Field
          label="Authentication"
          help="Servers without their own key use the global key from Settings."
        >
          <NativeSelect
            value={editor.token === undefined ? 'global' : 'custom'}
            disabled={configurationLocked}
            onChange={(event) =>
              onChange({ token: event.target.value === 'custom' ? '' : undefined })
            }
          >
            <NativeSelectOption value="global">Use global key</NativeSelectOption>
            <NativeSelectOption value="custom">Use this server's key</NativeSelectOption>
          </NativeSelect>
        </Field>
        {editor.token !== undefined && (
          <Field
            label="Server key"
            help="Only this key can access this server. The global key will not work."
          >
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
                aria-label={showKey ? 'Hide server key' : 'Show server key'}
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
            Generate secure key
          </Button>
        )}
        <CheckboxRow
          label="Allow session-based clients (MCP 2025-11-25 and earlier)"
          checked={editor.legacyProtocol}
          disabled={configurationLocked}
          onChange={(legacyProtocol) => onChange({ legacyProtocol })}
        />
        <CheckboxRow
          label="Disabled (do not mount this endpoint)"
          checked={editor.disabled}
          disabled={configurationLocked}
          onChange={(disabled) => onChange({ disabled })}
        />
        <div className="dialog-actions">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="default" disabled={configurationLocked}>
            Apply to draft
          </Button>
        </div>
        <small className="dialog-footnote">
          Review and save changes to update the running gateway.
        </small>
      </form>
    </Modal>
  );
};
