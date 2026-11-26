import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { ChevronRight, CircleHelp } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { useGatewayView } from '@mcp-gateway/mainview/context/GatewayViewContext';
import type { Document } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import { jsonEditing } from '@mcp-gateway/mainview/lib/json-editing';
import {
  CONFIG_TOO_LARGE,
  type ConfigIssue,
  formatConfigDocument,
  MAX_CONFIG_BYTES,
  parseConfigTree,
} from '@mcp-gateway/shared/config-document';
import type { Translate } from '@mcp-gateway/shared/i18n';

// Proposed interaction values, not measured limits.
const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_DISPLAY_TIMEOUT_MS = 5_000;

type Feedback =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; text: string }
  | { kind: 'unavailable'; text: string }
  | { kind: 'issue'; text: string; message: string; at?: { line: number; column: number } };

interface SyncState {
  text: string;
  revision: string;
  dirty: boolean;
  locked: boolean;
  invalid: boolean;
  setDoc: (doc: Document) => void;
  lastEmitted: string | null;
  lastSynced: { text: string; revision: string; dirty: boolean };
  listener: Extension | null;
}

const staticExtensions: Extension[] = [...jsonEditing, lineNumbers()];

// Uniform endings survive edits; a mixed-ending draft normalizes to LF on its first real edit.
const lineSeparatorOf = (text: string): string | null => {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const loneCr = text.match(/\r(?!\n)/g)?.length ?? 0;
  const loneLf = text.split('\n').length - 1 - crlf;
  if (crlf > 0 && loneCr === 0 && loneLf === 0) return '\r\n';
  if (loneCr > 0 && crlf === 0 && loneLf === 0) return '\r';
  if (crlf === 0 && loneCr === 0) return '\n';
  return null;
};

const fieldBehavior = (fieldId: string, locked: boolean, invalid: boolean): Extension[] => [
  EditorState.readOnly.of(locked),
  EditorView.editable.of(!locked),
  EditorView.contentAttributes.of({
    id: fieldId,
    tabindex: '0',
    spellcheck: 'false',
    'aria-labelledby': `${fieldId}-label`,
    'aria-describedby': `${fieldId}-feedback`,
    ...(invalid ? { 'aria-invalid': 'true' } : {}),
  }),
];

const positionOf = (text: string, offset: number): { line: number; column: number } => {
  const limit = Math.max(0, Math.min(offset, text.length));
  // A bare CR ends a line too, as the editor displays it.
  const lines = text.slice(0, limit).split(/\r\n|\r|\n/);
  return { line: lines.length, column: (lines.at(-1) ?? '').length + 1 };
};

const feedbackOf = (issue: ConfigIssue | null, text: string): Feedback => {
  if (!issue) return { kind: 'ok', text };
  return {
    kind: 'issue',
    text,
    message: issue.message,
    ...(issue.offset === undefined ? {} : { at: positionOf(text, issue.offset) }),
  };
};

const feedbackText = (feedback: Feedback, t: Translate): string => {
  switch (feedback.kind) {
    case 'ok':
      return t('raw.checked');
    case 'checking':
      return t('raw.checking');
    case 'unavailable':
      return t('raw.checkUnavailable');
    case 'issue':
      return feedback.at
        ? t('raw.issueAt', {
            message: feedback.message,
            line: feedback.at.line,
            column: feedback.at.column,
          })
        : feedback.message;
    default:
      return '';
  }
};

const tooLarge = (text: string): boolean =>
  new TextEncoder().encode(text).length > MAX_CONFIG_BYTES;

interface RawConfigProps {
  visible: boolean;
}

export const RawConfig = ({ visible }: RawConfigProps) => {
  const {
    client,
    doc,
    setDoc,
    configurationLocked,
    busy,
    format,
    filename,
    gateway,
    dirty,
    saveRawConfig,
    discardRawConfig,
    revealConfig,
    openConfigInEditor,
    importExternalServers,
    rawOpen,
    setRawOpen,
  } = useGatewayView();
  const { t } = useI18n();
  const locked = configurationLocked || busy;
  const previewOpen = visible && rawOpen;
  const fieldId = useId();
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle' });
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const validationSeq = useRef(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartmentRef = useRef<Compartment | null>(null);
  if (compartmentRef.current === null) compartmentRef.current = new Compartment();

  const currentDocText = doc?.text ?? '';
  const currentDocRevision = doc?.revision ?? '';
  const currentDocDirty = doc?.dirty ?? false;

  const syncStateRef = useRef<SyncState>({
    text: currentDocText,
    revision: currentDocRevision,
    dirty: currentDocDirty,
    locked,
    invalid: false,
    setDoc,
    lastEmitted: null,
    lastSynced: { text: currentDocText, revision: currentDocRevision, dirty: currentDocDirty },
    listener: null,
  });

  if (syncStateRef.current.listener === null) {
    syncStateRef.current.listener = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const sync = syncStateRef.current;
      if (sync.locked) return;
      const text = update.state.sliceDoc();
      if (text === (sync.lastEmitted ?? sync.text)) return;
      sync.lastEmitted = text;
      setFeedback({ kind: 'idle' });
      setImportNotice(null);
      sync.setDoc({ text, revision: sync.revision, dirty: true });
    });
  }

  useEffect(() => {
    const seq = ++validationSeq.current;
    setFeedback({ kind: 'idle' });
    if (!previewOpen || locked || !doc) return;

    const text = doc.text;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const debounceId = setTimeout(() => {
      if (seq !== validationSeq.current) return;
      if (tooLarge(text)) {
        setFeedback({ kind: 'issue', text, message: CONFIG_TOO_LARGE });
        return;
      }
      const parsed = parseConfigTree(text, format);
      if (!parsed.ok) {
        setFeedback(feedbackOf(parsed.issue, text));
        return;
      }
      setFeedback({ kind: 'checking' });
      timeoutId = setTimeout(() => {
        if (seq === validationSeq.current) {
          setFeedback({ kind: 'unavailable', text });
        }
      }, PREVIEW_DISPLAY_TIMEOUT_MS);

      void (async () => {
        let result: Feedback = { kind: 'unavailable', text };
        try {
          const reply = await client.validateConfig({ text });
          if (reply.ok) result = feedbackOf(reply.value.issue, text);
        } catch {
          // A bridge failure is not a configuration result; keep the unavailable state.
        }
        if (timeoutId !== null) clearTimeout(timeoutId);
        if (seq === validationSeq.current) {
          setFeedback(result);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      clearTimeout(debounceId);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [client, doc, format, locked, previewOpen]);

  // A result never describes a draft that has since been replaced outside the editor.
  const current: Feedback =
    'text' in feedback && feedback.text !== currentDocText ? { kind: 'idle' } : feedback;
  // Native Save stays authoritative; this only blocks a flagged or not-yet-checked draft.
  const saveReady = current.kind === 'ok' || current.kind === 'unavailable';
  const invalid = current.kind === 'issue';

  syncStateRef.current.text = currentDocText;
  syncStateRef.current.revision = currentDocRevision;
  syncStateRef.current.dirty = currentDocDirty;
  syncStateRef.current.locked = locked;
  syncStateRef.current.invalid = invalid;
  syncStateRef.current.setDoc = setDoc;

  // The view exists only while its host is mounted; live values are read through stable refs.
  useLayoutEffect(() => {
    if (!previewOpen) return;
    const host = hostRef.current;
    const compartment = compartmentRef.current;
    const sync = syncStateRef.current;
    const listener = sync.listener;
    if (!host || !compartment || !listener) return;
    const separator = lineSeparatorOf(sync.text);
    const view = new EditorView({
      doc: sync.text,
      extensions: [
        ...staticExtensions,
        ...(separator === null ? [] : [EditorState.lineSeparator.of(separator)]),
        compartment.of(fieldBehavior(fieldId, sync.locked, sync.invalid)),
        listener,
      ],
      parent: host,
    });
    viewRef.current = view;
    sync.lastSynced = { text: sync.text, revision: sync.revision, dirty: sync.dirty };
    return () => {
      view.destroy();
      viewRef.current = null;
      sync.lastEmitted = null;
    };
  }, [previewOpen, fieldId]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    const compartment = compartmentRef.current;
    if (!view || !compartment) return;
    view.dispatch({
      effects: compartment.reconfigure(fieldBehavior(fieldId, locked, invalid)),
    });
  }, [locked, fieldId, invalid]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    const compartment = compartmentRef.current;
    const sync = syncStateRef.current;
    const listener = sync.listener;
    if (!compartment || !listener) return;
    if (!view) {
      sync.lastSynced = {
        text: currentDocText,
        revision: currentDocRevision,
        dirty: currentDocDirty,
      };
      return;
    }
    const previous = sync.lastSynced;
    const viewText = view.state.doc.toString();
    const cleanOutOfSync = !currentDocDirty && viewText !== currentDocText;
    if (
      !cleanOutOfSync &&
      previous.text === currentDocText &&
      previous.revision === currentDocRevision &&
      previous.dirty === currentDocDirty
    )
      return;
    sync.lastSynced = {
      text: currentDocText,
      revision: currentDocRevision,
      dirty: currentDocDirty,
    };
    const isEditorEcho =
      currentDocDirty === true &&
      previous.revision === currentDocRevision &&
      sync.lastEmitted !== null &&
      currentDocText === sync.lastEmitted;
    sync.lastEmitted = null;
    if (isEditorEcho) return;
    const sameText = previous.text === currentDocText && !cleanOutOfSync;
    const resetHistory =
      cleanOutOfSync ||
      !sameText ||
      previous.revision !== currentDocRevision ||
      (previous.dirty && !currentDocDirty);
    if (!resetHistory) return;
    // External replacement or a clean/revision boundary: fresh state and history.
    const scrollTop = view.scrollDOM.scrollTop;
    const scrollLeft = view.scrollDOM.scrollLeft;
    const main = view.state.selection.main;
    const separator = lineSeparatorOf(currentDocText);
    const base = EditorState.create({
      doc: currentDocText,
      extensions: [
        ...staticExtensions,
        ...(separator === null ? [] : [EditorState.lineSeparator.of(separator)]),
        compartment.of(fieldBehavior(fieldId, locked, invalid)),
        listener,
      ],
    });
    const limit = base.doc.length;
    view.setState(
      base.update({
        selection: {
          anchor: Math.min(main.anchor, limit),
          head: Math.min(main.head, limit),
        },
      }).state,
    );
    if (sameText) {
      view.scrollDOM.scrollTop = scrollTop;
      view.scrollDOM.scrollLeft = scrollLeft;
    }
  }, [currentDocText, currentDocRevision, currentDocDirty, locked, fieldId, invalid]);

  const jumpToIssueLine = (lineNumber: number) => {
    const view = viewRef.current;
    if (!view) return;
    const clampedLine = Math.max(1, Math.min(lineNumber, view.state.doc.lines));
    const line = view.state.doc.line(clampedLine);
    view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    });
    view.focus();
  };

  const formatDraft = () => {
    if (locked || !doc) return;
    if (tooLarge(doc.text)) {
      setFeedback({ kind: 'issue', text: doc.text, message: CONFIG_TOO_LARGE });
      return;
    }
    const parsed = parseConfigTree(doc.text, format);
    if (!parsed.ok) {
      setFeedback(feedbackOf(parsed.issue, doc.text));
      return;
    }
    let text: string;
    try {
      text = formatConfigDocument(doc.text, format);
    } catch {
      setFeedback({
        kind: 'issue',
        text: doc.text,
        message: t('raw.formatFailed'),
      });
      return;
    }
    if (text === doc.text) return;
    setFeedback({ kind: 'idle' });
    setDoc({ ...doc, text, dirty: true });
  };

  const handleImportExternal = async () => {
    if (locked || dirty) return;
    const count = await importExternalServers();
    if (count === null) return;
    setImportNotice(
      count > 0
        ? `Imported ${count} server${count === 1 ? '' : 's'} from Claude Desktop / Cursor.`
        : 'No new servers found in Claude Desktop or Cursor.',
    );
  };

  if (!visible || !doc) return null;

  return (
    <section className="panel raw-panel">
      <button
        type="button"
        className="raw-heading"
        aria-expanded={rawOpen}
        onClick={() => setRawOpen(!rawOpen)}
      >
        <span>
          <strong>{t('raw.title')}</strong>
          <small>{t('raw.subtitle', { filename })}</small>
        </span>
        <ChevronRight size={16} className="raw-chevron" aria-hidden="true" />
      </button>
      {rawOpen && (
        <div className="raw-body">
          <div className="mt-3 mb-2 flex items-center justify-between gap-2">
            <p className="mono config-path m-0 text-[12px] text-mac-label-secondary">
              {gateway?.configPath}
            </p>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Schema reference"
              aria-expanded={schemaOpen}
              onClick={() => setSchemaOpen((previous) => !previous)}
            >
              <CircleHelp size={15} />
            </Button>
          </div>
          {schemaOpen && (
            <div className="schema-popover">
              <p className="m-0 mb-1.5 text-[12px] text-mac-label-secondary">
                {t('raw.intro')} {format === 'jsonc' ? t('raw.jsonc') : t('raw.json')}
              </p>
              <pre className="mono m-0 overflow-x-auto text-[11px] leading-[1.5]">{`{
  "gateway": {
    "host": "127.0.0.1",
    "port": 8765,
    "token": "<32..512 ASCII chars>",
    "autoStart": false,
    "launchAtLogin": false
  },
  "mcpServers": {
    "stdio-example": {
      "command": "/usr/local/bin/server",
      "args": ["--flag"],
      "env": { "API_KEY": "\${API_KEY}" }
    },
    "http-example": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer \${TOKEN}" }
    }
  }
}`}</pre>
            </div>
          )}
          <div className="field">
            <span
              id={`${fieldId}-label`}
              className="flex items-center text-mac-body leading-none font-semibold text-mac-label select-none"
            >
              {filename}
            </span>
            <div
              ref={hostRef}
              className={invalid ? 'raw-code-editor raw-code-editor-error' : 'raw-code-editor'}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <small
                id={`${fieldId}-feedback`}
                className={
                  current.kind === 'issue' ? 'raw-feedback raw-feedback-error' : 'raw-feedback'
                }
                role="status"
              >
                {importNotice || feedbackText(current, t)}
              </small>
              {current.kind === 'issue' && current.at?.line && (
                <Button
                  variant="link"
                  onClick={() => {
                    if (current.at?.line) jumpToIssueLine(current.at.line);
                  }}
                >
                  Line {current.at.line}
                </Button>
              )}
            </div>
          </div>
          <div className="raw-actions">
            <Button variant="secondary" disabled={locked} onClick={revealConfig}>
              {t('raw.showInFinder')}
            </Button>
            <Button variant="secondary" disabled={locked} onClick={openConfigInEditor}>
              Open in External Editor
            </Button>
            <Button
              variant="secondary"
              disabled={locked || dirty}
              onClick={() => void handleImportExternal()}
            >
              Import from Claude / Cursor
            </Button>
            <Button variant="secondary" disabled={locked} onClick={formatDraft}>
              {t('raw.format')}
            </Button>
            <Button
              variant="secondary"
              disabled={locked || doc.text === gateway?.configText}
              onClick={() => void discardRawConfig()}
            >
              {t('raw.reset')}
            </Button>
            <Button
              variant="default"
              aria-describedby={`${fieldId}-feedback`}
              disabled={locked || !dirty || !saveReady}
              onClick={() => void saveRawConfig()}
            >
              {t('raw.save', { filename })}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
};
