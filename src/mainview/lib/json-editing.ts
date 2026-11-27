import { history, historyKeymap, indentWithTab, standardKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { json } from '@codemirror/legacy-modes/mode/javascript';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { classHighlighter, tags } from '@lezer/highlight';

// The stream mode highlights and indents JSON and JSONC; parsers and native Save stay authoritative.
const jsonLanguage = StreamLanguage.define({
  ...json,
  // Resolve the legacy alias inside combined "string property" tokens.
  tokenTable: { property: tags.propertyName },
});

/** Shared JSON/JSONC editor setup with 2-space Tab indentation. */
export const jsonEditing = [
  jsonLanguage,
  syntaxHighlighting(classHighlighter),
  bracketMatching(),
  indentUnit.of('  '),
  EditorState.tabSize.of(2),
  history(),
  keymap.of([...standardKeymap, ...historyKeymap, indentWithTab]),
];
