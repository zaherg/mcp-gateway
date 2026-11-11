import type { RefObject } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Label } from '@mcp-gateway/mainview/components/mac/label';
import { Textarea } from '@mcp-gateway/mainview/components/mac/textarea';
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

const positionOf = (text: string, offset: number): { line: number; column: number } => {
  const limit = Math.max(0, Math.min(offset, text.length));
  // A bare CR ends a line too, as the text area displays it.
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

  // A result never describes a draft that has since been replaced outside the editor.
  const current: Feedback =
    'text' in feedback && feedback.text !== doc.text ? { kind: 'idle' } : feedback;
  // Native Save stays authoritative; this only blocks a flagged or not-yet-checked draft.
  const saveReady = current.kind === 'ok' || current.kind === 'unavailable';

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
            <Label htmlFor={fieldId} className="font-semibold">
              {filename}
            </Label>
            <Textarea
              id={fieldId}
              aria-describedby={`${fieldId}-feedback`}
              aria-invalid={current.kind === 'issue' ? true : undefined}
              className="min-h-87.5 text-[11px] whitespace-pre [tab-size:2]"
              readOnly={configurationLocked}
              spellCheck={false}
              value={doc.text}
              onChange={(event) => {
                if (configurationLocked) return;
                setFeedback({ kind: 'idle' });
                setDoc({ ...doc, text: event.target.value, dirty: true });
                setNotice('');
              }}
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
