import { history, historyKeymap, standardKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language';
import { json } from '@codemirror/legacy-modes/mode/javascript';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { classHighlighter, tags } from '@lezer/highlight';

// The stream mode highlights and indents JSON and JSONC; parsers and native Save stay authoritative.
const jsonLanguage = StreamLanguage.define({
  ...json,
  // Resolve the legacy alias inside combined "string property" tokens.
  tokenTable: { property: tags.propertyName },
});

/** Every JSON editor in the app shares this setup. Tab and Escape stay unbound for focus and dialogs. */
export const jsonEditing: Extension[] = [
  jsonLanguage,
  syntaxHighlighting(classHighlighter),
  bracketMatching(),
  indentUnit.of('  '),
  EditorState.tabSize.of(2),
  history(),
  keymap.of([...standardKeymap, ...historyKeymap]),
];
