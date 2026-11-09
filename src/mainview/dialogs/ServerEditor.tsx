import { Alert, Field, Modal } from '@mcp-gateway/mainview/components/ui';
import type { ConfigFormat } from '@mcp-gateway/shared/config-document';
import { parseConfigDocument } from '@mcp-gateway/shared/config-document';
import type { GatewayConfig, HttpServerConfig, StdioServerConfig } from '@mcp-gateway/shared/types';
import type { FormEvent, RefObject } from 'react';

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
};

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
};
const stringMap = (value: unknown): value is Record<string, string> => {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
};
const isBackend = (value: unknown): value is Backend => {
  if (
    !isRecord(value) ||
    (value.disabled !== undefined && typeof value.disabled !== 'boolean') ||
    (value.legacyProtocol !== undefined && typeof value.legacyProtocol !== 'boolean')
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
// This guard is for rendering only. Native validation remains authoritative on every save.
export const formConfig = (text: string, format: ConfigFormat): GatewayConfig | null => {
  try {
    const value = parseConfigDocument(text, format);
    if (!isRecord(value) || !isRecord(value.gateway) || !isRecord(value.mcpServers)) return null;
    const gateway = value.gateway;
    if (
      typeof gateway.host !== 'string' ||
      typeof gateway.port !== 'number' ||
      typeof gateway.token !== 'string' ||
      (gateway.autoStart !== undefined && typeof gateway.autoStart !== 'boolean') ||
      (gateway.launchAtLogin !== undefined && typeof gateway.launchAtLogin !== 'boolean') ||
      !Object.values(value.mcpServers).every(isBackend)
    )
      return null;
    // Preserve all fields from the source document, including unknown fields for native rejection.
    return {
      ...value,
      gateway: { ...gateway, host: gateway.host, port: gateway.port, token: gateway.token },
      mcpServers: Object.fromEntries(
        Object.entries(value.mcpServers).filter((entry): entry is [string, Backend] =>
          isBackend(entry[1]),
        ),
      ),
    };
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
});

export const ServerEditor = ({
  editor,
  editorError,
  configurationLocked,
  fallbackFocus,
  onChange,
  onClose,
  onSubmit,
  onDismissError,
}: {
  editor: Editor;
  editorError: string | null;
  configurationLocked: boolean;
  fallbackFocus: RefObject<HTMLElement | null>;
  onChange: (patch: Partial<Editor>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent) => void;
  onDismissError: () => void;
}) => {
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
            : 'Connect a local tool or an existing MCP endpoint.'}
        </p>
        {editorError && <Alert onDismiss={onDismissError}>{editorError}</Alert>}
        <Field
          label="Server name"
          help="Used in /mcp/server-name. Letters, numbers, hyphens and underscores."
        >
          <input
            required
            value={editor.name}
            readOnly={configurationLocked}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </Field>
        <Field label="Transport">
          <select
            value={editor.type}
            disabled={configurationLocked}
            onChange={(event) =>
              onChange({ type: event.target.value === 'http' ? 'http' : 'stdio' })
            }
          >
            <option value="stdio">Local command (stdio)</option>
            <option value="http">Streamable HTTP</option>
          </select>
        </Field>
        {editor.type === 'stdio' ? (
          <>
            <Field
              label="Command"
              help="Executable path only. Arguments are passed separately, never through a shell."
            >
              <input
                required
                value={editor.command}
                readOnly={configurationLocked}
                placeholder="/path/to/mcp-server"
                onChange={(event) => onChange({ command: event.target.value })}
              />
            </Field>
            <Field label="Arguments (JSON array)">
              <textarea
                spellCheck={false}
                value={editor.args}
                readOnly={configurationLocked}
                onChange={(event) => onChange({ args: event.target.value })}
              />
            </Field>
            <div className="form-grid">
              <Field label="Environment (JSON object)">
                <textarea
                  spellCheck={false}
                  value={editor.env}
                  readOnly={configurationLocked}
                  onChange={(event) => onChange({ env: event.target.value })}
                />
              </Field>
              <Field label="Working directory" help="Optional absolute path.">
                <input
                  value={editor.cwd}
                  readOnly={configurationLocked}
                  placeholder="/Users/you"
                  onChange={(event) => onChange({ cwd: event.target.value })}
                />
              </Field>
            </div>
            <button
              type="button"
              className="text-button"
              disabled={configurationLocked}
              onClick={() =>
                onChange({
                  name: editor.name || 'bear',
                  command: '/Applications/Bear.app/Contents/MacOS/bearcli',
                  args: '["mcp-server"]',
                })
              }
            >
              Fill macOS Bear preset (all accessible notes & tools)
            </button>
          </>
        ) : (
          <>
            <Field label="Upstream URL" help="HTTP(S), without embedded credentials or fragments.">
              <input
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
              <textarea
                spellCheck={false}
                value={editor.headers}
                readOnly={configurationLocked}
                onChange={(event) => onChange({ headers: event.target.value })}
              />
            </Field>
          </>
        )}
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={editor.legacyProtocol}
            disabled={configurationLocked}
            onChange={(event) => onChange({ legacyProtocol: event.target.checked })}
          />{' '}
          Allow session-based clients (MCP 2025-11-25 and earlier)
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={editor.disabled}
            disabled={configurationLocked}
            onChange={(event) => onChange({ disabled: event.target.checked })}
          />{' '}
          Disabled (do not mount this endpoint)
        </label>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={configurationLocked}>
            Apply to draft
          </button>
        </div>
        <small className="dialog-footnote">
          Review and save changes to update the running gateway.
        </small>
      </form>
    </Modal>
  );
};
