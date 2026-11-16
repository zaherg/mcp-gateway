import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useLayoutEffect, useRef } from 'react';

import { jsonEditing } from '@mcp-gateway/mainview/lib/json-editing';

// Marks replacements that came from the value prop, so they are not reported back as edits.
const external = Annotation.define<boolean>();

// A contenteditable cannot be the target of <label htmlFor>, so Field's label is referenced by id.
const behavior = (
  id: string | undefined,
  describedBy: string | undefined,
  readOnly: boolean,
): Extension[] => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
  EditorView.contentAttributes.of({
    ...(id ? { id, 'aria-labelledby': `${id}-label` } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    tabindex: '0',
    spellcheck: 'false',
  }),
];

interface JsonEditor {
  id?: string;
  'aria-describedby'?: string;
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}

/** A small JSON field; `value` stays the single source of truth. */
export const JsonEditor = ({
  id,
  'aria-describedby': describedBy,
  value,
  readOnly,
  onChange,
}: JsonEditor) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartmentRef = useRef<Compartment | null>(null);
  if (compartmentRef.current === null) compartmentRef.current = new Compartment();
  // The view is created once; it reads current props through this ref.
  const live = useRef({ value, onChange });
  live.current = { value, onChange };

  useLayoutEffect(() => {
    const host = hostRef.current;
    const compartment = compartmentRef.current;
    if (!host || !compartment) return;
    const view = new EditorView({
      doc: live.current.value,
      extensions: [
        ...jsonEditing,
        // Filled by the behavior effect below, in the same commit and before paint.
        compartment.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(external)))
            live.current.onChange(update.state.doc.toString());
        }),
      ],
      parent: host,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Follow outside changes such as Fill Bear preset; the editor's own edits already match.
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      annotations: external.of(true),
    });
  }, [value]);

  useLayoutEffect(() => {
    const view = viewRef.current;
    const compartment = compartmentRef.current;
    if (!view || !compartment) return;
    view.dispatch({ effects: compartment.reconfigure(behavior(id, describedBy, readOnly)) });
  }, [id, describedBy, readOnly]);

  return <div ref={hostRef} className="raw-code-editor json-field" />;
};
