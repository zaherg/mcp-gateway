import { history, historyKeymap, standardKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { json } from '@codemirror/legacy-modes/mode/javascript';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter, tags } from '@lezer/highlight';
import type { RefObject } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import type { Document } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import {
  CONFIG_TOO_LARGE,
  type ConfigFormat,
  type ConfigIssue,
  formatConfigDocument,
  MAX_CONFIG_BYTES,
  parseConfigTree,
} from '@mcp-gateway/shared/config-document';
import type { AppClient } from '@mcp-gateway/shared/rpc';
import type { GatewaySnapshot } from '@mcp-gateway/shared/types';

// Proposed interaction values, not measured limits.
const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_DISPLAY_TIMEOUT_MS = 5_000;

type Feedback =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; text: string }
  | { kind: 'unavailable'; text: string }
  | { kind: 'issue'; text: string; message: string; at?: { line: number; column: number } };

interface Pending {
  text: string;
  revision: string;
  format: ConfigFormat;
  attempt: number;
}

interface EditTarget {
  text: string;
  revision: string;
  dirty: boolean;
  locked: boolean;
  invalid: boolean;
  setDoc: (doc: Document) => void;
  setNotice: (notice: string) => void;
}

// The stream mode highlights and indents JSONC; parseConfigTree and native Save stay authoritative.
const configLanguage = StreamLanguage.define({
  ...json,
  // Resolve the legacy alias inside combined "string property" tokens.
  tokenTable: { property: tags.propertyName },
});

const staticExtensions: Extension[] = [
  configLanguage,
  syntaxHighlighting(classHighlighter),
  lineNumbers(),
  bracketMatching(),
  indentUnit.of('  '),
  EditorState.tabSize.of(2),
  history(),
  keymap.of([...standardKeymap, ...historyKeymap]),
];

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

const feedbackText = (feedback: Feedback): string => {
  switch (feedback.kind) {
    case 'ok':
      return 'Configuration fields checked.';
    case 'checking':
      return 'Checking configuration...';
    case 'unavailable':
      return 'Configuration check unavailable; Save still validates.';
    case 'issue':
      return feedback.at
        ? `${feedback.message} (line ${feedback.at.line}, column ${feedback.at.column})`
        : feedback.message;
    default:
      return '';
  }
};

const tooLarge = (text: string): boolean =>
  new TextEncoder().encode(text).length > MAX_CONFIG_BYTES;

interface RawConfig {
  client: AppClient;
  visible: boolean;
  doc: Document;
  setDoc: (doc: Document) => void;
  configurationLocked: boolean;
  format: ConfigFormat;
  filename: string;
  gateway: GatewaySnapshot | undefined;
  dirty: boolean;
  retryLogin: boolean;
  save: () => Promise<boolean>;
  discard: () => Promise<void>;
  rawOpen: boolean;
  setRawOpen: (open: boolean) => void;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
  setNotice: (notice: string) => void;
}

export const RawConfig = ({
  client,
  visible,
  doc,
  setDoc,
  configurationLocked,
  format,
  filename,
  gateway,
  dirty,
  retryLogin,
  save,
  discard,
  rawOpen,
  setRawOpen,
  fallbackFocus,
  setNotice,
}: RawConfig) => {
  const previewOpen = visible && rawOpen;
  const fieldId = useId();
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle' });
  // A result applies only to its own text generation: open state, lock, text, revision, format.
  const generation = useRef(0);
  const inFlight = useRef(false);
  const pending = useRef<Pending | null>(null);
  const unmounted = useRef(false);
  const displayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef({ open: previewOpen, locked: configurationLocked });
  live.current = { open: previewOpen, locked: configurationLocked };
  const revisionRef = useRef(doc.revision);
  revisionRef.current = doc.revision;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartmentRef = useRef<Compartment | null>(null);
  if (compartmentRef.current === null) compartmentRef.current = new Compartment();
  // The editor's own emitted text, so the sync effect can tell an echo from an external replacement.
  const lastEmitted = useRef<string | null>(null);
  const lastSynced = useRef({ text: doc.text, revision: doc.revision, dirty: doc.dirty });
  const editRef = useRef<EditTarget>({
    text: doc.text,
    revision: doc.revision,
    dirty: doc.dirty,
    locked: configurationLocked,
    invalid: false,
    setDoc,
    setNotice,
  });
  const listenerRef = useRef<Extension | null>(null);
  if (listenerRef.current === null) {
    listenerRef.current = EditorView.updateListener.of((update) => {
      if (!update.docChanged) return;
      const edit = editRef.current;
      if (edit.locked) return;
      const text = update.state.sliceDoc();
      if (text === (lastEmitted.current ?? edit.text)) return;
      lastEmitted.current = text;
      setFeedback({ kind: 'idle' });
      edit.setDoc({ text, revision: edit.revision, dirty: true });
      edit.setNotice('');
    });
  }

  const check = useCallback(
    function check(text: string, revision: string, format: ConfigFormat, attempt: number): void {
      if (unmounted.current || attempt !== generation.current) return;
      if (!live.current.open || live.current.locked) return;
      if (tooLarge(text)) {
        setFeedback({ kind: 'issue', text, message: CONFIG_TOO_LARGE });
        return;
      }
      const parsed = parseConfigTree(text, format);
      if (!parsed.ok) {
        setFeedback(feedbackOf(parsed.issue, text));
        return;
      }
      // One native request at a time; only the latest pending document is retained.
      const armUnavailable = () => {
        if (displayTimer.current !== null) clearTimeout(displayTimer.current);
        displayTimer.current = setTimeout(() => {
          displayTimer.current = null;
          if (unmounted.current || attempt !== generation.current) return;
          if (live.current.open && !live.current.locked) setFeedback({ kind: 'unavailable', text });
        }, PREVIEW_DISPLAY_TIMEOUT_MS);
      };
      if (inFlight.current) {
        pending.current = { text, revision, format, attempt };
        setFeedback({ kind: 'checking' });
        armUnavailable();
        return;
      }
      inFlight.current = true;
      setFeedback({ kind: 'checking' });
      armUnavailable();
      void (async () => {
        let result: Feedback = { kind: 'unavailable', text };
        try {
          const reply = await client.validateConfig({ text });
          if (reply.ok) result = feedbackOf(reply.value.issue, text);
        } catch {
          // A bridge failure is not a configuration result; keep the unavailable state.
        }
        if (displayTimer.current !== null) {
          clearTimeout(displayTimer.current);
          displayTimer.current = null;
        }
        inFlight.current = false;
        const next = pending.current;
        pending.current = null;
        const current =
          !unmounted.current &&
          live.current.open &&
          !live.current.locked &&
          attempt === generation.current &&
          revision === revisionRef.current;
        if (current) setFeedback(result);
        if (next && !unmounted.current && next.attempt === generation.current)
          check(next.text, next.revision, next.format, next.attempt);
      })();
    },
    [client],
  );

  useEffect(() => {
    generation.current += 1;
    const attempt = generation.current;
    pending.current = null;
    setFeedback({ kind: 'idle' });
    if (!previewOpen || configurationLocked) {
      if (displayTimer.current !== null) {
        clearTimeout(displayTimer.current);
        displayTimer.current = null;
      }
      return;
    }
    const timer = setTimeout(
      () => check(doc.text, doc.revision, format, attempt),
      PREVIEW_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [check, doc.text, doc.revision, format, previewOpen, configurationLocked]);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      generation.current += 1;
      pending.current = null;
      if (displayTimer.current !== null) clearTimeout(displayTimer.current);
    };
  }, []);

  // A result never describes a draft that has since been replaced outside the editor.
  const current: Feedback =
    'text' in feedback && feedback.text !== doc.text ? { kind: 'idle' } : feedback;
  // Native Save stays authoritative; this only blocks a flagged or not-yet-checked draft.
  const saveReady = current.kind === 'ok' || current.kind === 'unavailable';
  const invalid = current.kind === 'issue';

  editRef.current = {
    text: doc.text,
    revision: doc.revision,
    dirty: doc.dirty,
    locked: configurationLocked,
    invalid,
    setDoc,
    setNotice,
  };

  // The view exists only while its host is mounted; live values are read through stable refs.
  useLayoutEffect(() => {
    if (!previewOpen) return;
    const host = hostRef.current;
    const compartment = compartmentRef.current;
    const listener = listenerRef.current;
    if (!host || !compartment || !listener) return;
    const edit = editRef.current;
    const separator = lineSeparatorOf(edit.text);
    const view = new EditorView({
      doc: edit.text,
      extensions: [
        ...staticExtensions,
        ...(separator === null ? [] : [EditorState.lineSeparator.of(separator)]),
        compartment.of(fieldBehavior(fieldId, edit.locked, edit.invalid)),
        listener,
      ],
      parent: host,
    });
    viewRef.current = view;
    lastSynced.current = { text: edit.text, revision: edit.revision, dirty: edit.dirty };
    return () => {
      view.destroy();
      viewRef.current = null;
      lastEmitted.current = null;
    };
  }, [previewOpen, fieldId]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    const compartment = compartmentRef.current;
    if (!view || !compartment) return;
    view.dispatch({
      effects: compartment.reconfigure(fieldBehavior(fieldId, configurationLocked, invalid)),
    });
  }, [configurationLocked, fieldId, invalid]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    const compartment = compartmentRef.current;
    const listener = listenerRef.current;
    if (!compartment || !listener) return;
    if (!view) {
      lastSynced.current = { text: doc.text, revision: doc.revision, dirty: doc.dirty };
      return;
    }
    const previous = lastSynced.current;
    if (
      previous.text === doc.text &&
      previous.revision === doc.revision &&
      previous.dirty === doc.dirty
    )
      return;
    lastSynced.current = { text: doc.text, revision: doc.revision, dirty: doc.dirty };
    const isEditorEcho =
      lastEmitted.current !== null &&
      doc.text === lastEmitted.current &&
      doc.dirty &&
      previous.revision === doc.revision;
    lastEmitted.current = null;
    if (isEditorEcho) return;
    const sameText = previous.text === doc.text;
    const resetHistory =
      !sameText || previous.revision !== doc.revision || (previous.dirty && !doc.dirty);
    if (!resetHistory) return;
    // External replacement or a clean/revision boundary: fresh state and history.
    const scrollTop = view.scrollDOM.scrollTop;
    const scrollLeft = view.scrollDOM.scrollLeft;
    const main = view.state.selection.main;
    const separator = lineSeparatorOf(doc.text);
    const base = EditorState.create({
      doc: doc.text,
      extensions: [
        ...staticExtensions,
        ...(separator === null ? [] : [EditorState.lineSeparator.of(separator)]),
        compartment.of(fieldBehavior(fieldId, configurationLocked, invalid)),
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
  }, [doc.text, doc.revision, doc.dirty, configurationLocked, fieldId, invalid]);

  const formatDraft = () => {
    if (configurationLocked) return;
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
        message: 'The configuration could not be formatted.',
      });
      return;
    }
    if (text === doc.text) return;
    setFeedback({ kind: 'idle' });
    setDoc({ ...doc, text, dirty: true });
    setNotice('');
  };

  // Keep the single-flight guard alive while Logs hides the editor.
  if (!visible) return null;

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
            <small
              id={`${fieldId}-feedback`}
              className={
                current.kind === 'issue' ? 'raw-feedback raw-feedback-error' : 'raw-feedback'
              }
              role="status"
            >
              {feedbackText(current)}
            </small>
          </div>
          <div className="raw-actions">
            <Button variant="secondary" disabled={configurationLocked} onClick={formatDraft}>
              Format
            </Button>
            <Button
              variant="secondary"
              disabled={configurationLocked || doc.text === gateway?.configText}
              onClick={() => void discard()}
            >
              Reset
            </Button>
            <Button
              variant="default"
              aria-describedby={`${fieldId}-feedback`}
              disabled={configurationLocked || (!dirty && !retryLogin) || !saveReady}
              onClick={() => void save()}
            >
              Save {filename}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
};
