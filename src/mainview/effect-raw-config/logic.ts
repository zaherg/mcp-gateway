import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Redacted, Schema } from 'effect';

import {
  CONFIG_TOO_LARGE,
  type ConfigFormat,
  type ConfigIssue,
  formatConfigDocument,
  MAX_CONFIG_BYTES,
  parseConfigTree,
} from '@mcp-gateway/shared/config-document';
import type { Translate } from '@mcp-gateway/shared/i18n';

export const PREVIEW_DEBOUNCE_MS = 300;
export const PREVIEW_DISPLAY_TIMEOUT_MS = 5_000;

export const IssuePositionSchema = Schema.Struct({
  line: Schema.Number,
  column: Schema.Number,
});

export const FeedbackSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('idle') }),
  Schema.Struct({ kind: Schema.Literal('checking') }),
  Schema.Struct({ kind: Schema.Literal('ok'), text: Schema.Redacted(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal('unavailable'), text: Schema.Redacted(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal('issue'),
    text: Schema.Redacted(Schema.String),
    message: Schema.String,
    at: Schema.NullOr(IssuePositionSchema),
  }),
]);

export type Feedback = typeof FeedbackSchema.Type;

// Uniform endings survive edits; a mixed-ending draft normalizes to LF on its first real edit.
export const lineSeparatorOf = (text: string): '\r\n' | '\r' | '\n' | null => {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const loneCr = text.match(/\r(?!\n)/g)?.length ?? 0;
  const loneLf = text.split('\n').length - 1 - crlf;
  if (crlf > 0 && loneCr === 0 && loneLf === 0) return '\r\n';
  if (loneCr > 0 && crlf === 0 && loneLf === 0) return '\r';
  if (crlf === 0 && loneCr === 0) return '\n';
  return null;
};

export const fieldBehavior = (fieldId: string, locked: boolean, invalid: boolean) => [
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

export const positionOf = (text: string, offset: number): { line: number; column: number } => {
  const limit = Math.max(0, Math.min(offset, text.length));
  // A bare CR ends a line too, as the editor displays it.
  const lines = text.slice(0, limit).split(/\r\n|\r|\n/);
  return { line: lines.length, column: (lines.at(-1) ?? '').length + 1 };
};

export const feedbackOf = (
  issue: ConfigIssue | null,
  text: Redacted.Redacted<string>,
): Feedback => {
  if (!issue) return { kind: 'ok', text };
  const raw = Redacted.value(text);
  return {
    kind: 'issue',
    text,
    message: issue.message,
    at: issue.offset === undefined ? null : positionOf(raw, issue.offset),
  };
};

export const feedbackText = (feedback: Feedback, t: Translate): string => {
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

export const tooLarge = (text: string): boolean =>
  new TextEncoder().encode(text).length > MAX_CONFIG_BYTES;

export const currentFeedbackFor = (feedback: Feedback, currentRawText: string): Feedback => {
  if (
    (feedback.kind === 'ok' || feedback.kind === 'unavailable' || feedback.kind === 'issue') &&
    Redacted.value(feedback.text) !== currentRawText
  ) {
    return { kind: 'idle' };
  }
  return feedback;
};

export type FormatDraftResult =
  | { readonly ok: true; readonly changed: false }
  | { readonly ok: true; readonly changed: true; readonly text: Redacted.Redacted<string> }
  | { readonly ok: false; readonly feedback: Feedback };

export const formatDraftLogic = (
  text: Redacted.Redacted<string>,
  format: ConfigFormat,
  t: Translate,
): FormatDraftResult => {
  const raw = Redacted.value(text);
  if (tooLarge(raw)) {
    return { ok: false, feedback: { kind: 'issue', text, message: CONFIG_TOO_LARGE, at: null } };
  }
  const parsed = parseConfigTree(raw, format);
  if (!parsed.ok) {
    return { ok: false, feedback: feedbackOf(parsed.issue, text) };
  }
  let formatted: string;
  try {
    formatted = formatConfigDocument(raw, format);
  } catch {
    return {
      ok: false,
      feedback: { kind: 'issue', text, message: t('raw.formatFailed'), at: null },
    };
  }
  if (formatted === raw) return { ok: true, changed: false };
  return { ok: true, changed: true, text: Redacted.make(formatted) };
};

export const formatImportNotice = (count: number): string =>
  count > 0
    ? `Imported ${count} server${count === 1 ? '' : 's'} from Claude Desktop / Cursor.`
    : 'No new servers found in Claude Desktop or Cursor.';
