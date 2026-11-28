import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { Command, Mount, Subscription, UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Effect, Layer, Option, Queue, Redacted, Schema, Stream } from 'effect';

import { ConfigFormatSchema, ImportOutcomeSchema } from '@mcp-gateway/mainview/effect-app/schemas';
import { GatewayRpc } from '@mcp-gateway/mainview/effect-app/services';
import { DocumentSchema } from '@mcp-gateway/mainview/effect-dialogs/server-editor-logic';
import {
  currentFeedbackFor,
  type Feedback,
  FeedbackSchema,
  feedbackOf,
  feedbackText,
  fieldBehavior,
  formatDraftLogic,
  formatImportNotice,
  lineSeparatorOf,
  PREVIEW_DEBOUNCE_MS,
  PREVIEW_DISPLAY_TIMEOUT_MS,
  tooLarge,
} from '@mcp-gateway/mainview/effect-raw-config/logic';
import { buttonClasses, iconChevronRight, iconCircleHelp } from '@mcp-gateway/mainview/effect-ui';
import { jsonEditing } from '@mcp-gateway/mainview/lib/json-editing';
import { CONFIG_TOO_LARGE, parseConfigTree } from '@mcp-gateway/shared/config-document';
import { type Locale, translator } from '@mcp-gateway/shared/i18n';

const staticExtensions = [...jsonEditing, lineNumbers()];

export const AttachCodeMirrorArgs = {
  text: Schema.Redacted(Schema.String),
  revision: Schema.String,
  dirty: Schema.Boolean,
  locked: Schema.Boolean,
  invalid: Schema.Boolean,
  fieldId: Schema.String,
  jumpSeq: Schema.Number,
  jumpLine: Schema.NullOr(Schema.Number),
};

export const AttachCodeMirror = Mount.makeStream(
  'mcp-gateway/raw-config/AttachCodeMirror',
  { args: AttachCodeMirrorArgs },
  (host: HTMLDivElement, initialArgs, changes) =>
    Stream.callback<Redacted.Redacted<string>>(
      Effect.fnUntraced(function* (queue) {
        const compartment = new Compartment();
        let currentLocked = initialArgs.locked;
        let currentText = Redacted.value(initialArgs.text);
        let lastEmitted: string | null = null;
        let lastSynced = {
          text: currentText,
          revision: initialArgs.revision,
          dirty: initialArgs.dirty,
        };
        let lastJumpSeq = initialArgs.jumpSeq;

        const listener = EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (currentLocked) return;
          const nextText = update.state.sliceDoc();
          if (nextText === (lastEmitted ?? currentText)) return;
          lastEmitted = nextText;
          Queue.offerUnsafe(queue, Redacted.make(nextText));
        });

        const buildExtensions = (
          text: string,
          fieldId: string,
          locked: boolean,
          invalid: boolean,
        ) => {
          const separator = lineSeparatorOf(text);
          return [
            ...staticExtensions,
            ...(separator === null ? [] : [EditorState.lineSeparator.of(separator)]),
            compartment.of(fieldBehavior(fieldId, locked, invalid)),
            listener,
          ];
        };

        const view = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new EditorView({
                doc: currentText,
                extensions: buildExtensions(
                  currentText,
                  initialArgs.fieldId,
                  initialArgs.locked,
                  initialArgs.invalid,
                ),
                parent: host,
              }),
          ),
          (editorView) =>
            Effect.sync(() => {
              editorView.destroy();
              lastEmitted = null;
            }),
        );

        let first = true;
        yield* Stream.runForEach(changes, (args) =>
          Effect.sync(() => {
            const nextRawText = Redacted.value(args.text);
            currentLocked = args.locked;
            currentText = nextRawText;

            if (first) {
              first = false;
              return;
            }

            // Reconfigure lock / validity attributes on every change.
            view.dispatch({
              effects: compartment.reconfigure(
                fieldBehavior(args.fieldId, args.locked, args.invalid),
              ),
            });

            // Sync document text / revision / dirty boundary.
            const previous = lastSynced;
            const viewText = view.state.doc.toString();
            const cleanOutOfSync = !args.dirty && viewText !== nextRawText;
            const docChanged =
              cleanOutOfSync ||
              previous.text !== nextRawText ||
              previous.revision !== args.revision ||
              previous.dirty !== args.dirty;

            if (docChanged) {
              lastSynced = {
                text: nextRawText,
                revision: args.revision,
                dirty: args.dirty,
              };
              const isEditorEcho =
                args.dirty === true &&
                previous.revision === args.revision &&
                lastEmitted !== null &&
                nextRawText === lastEmitted;
              lastEmitted = null;
              if (!isEditorEcho) {
                const sameText = previous.text === nextRawText && !cleanOutOfSync;
                const resetHistory =
                  cleanOutOfSync ||
                  !sameText ||
                  previous.revision !== args.revision ||
                  (previous.dirty && !args.dirty);
                if (resetHistory) {
                  const scrollTop = view.scrollDOM.scrollTop;
                  const scrollLeft = view.scrollDOM.scrollLeft;
                  const main = view.state.selection.main;
                  const base = EditorState.create({
                    doc: nextRawText,
                    extensions: buildExtensions(
                      nextRawText,
                      args.fieldId,
                      args.locked,
                      args.invalid,
                    ),
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
                }
              }
            }

            // Jump to issue line when jumpSeq advances.
            if (args.jumpSeq !== lastJumpSeq) {
              lastJumpSeq = args.jumpSeq;
              if (args.jumpLine !== null) {
                const clampedLine = Math.max(1, Math.min(args.jumpLine, view.state.doc.lines));
                const line = view.state.doc.line(clampedLine);
                view.dispatch({
                  selection: { anchor: line.from },
                  effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
                });
                view.focus();
              }
            }
          }),
        ).pipe(Effect.forkScoped);
      }),
    ),
);

export const RawConfigProps = Schema.Struct({
  locale: Schema.String,
  visible: Schema.Boolean,
  rawOpen: Schema.Boolean,
  locked: Schema.Boolean,
  format: ConfigFormatSchema,
  filename: Schema.String,
  configPath: Schema.String,
  savedConfigText: Schema.Redacted(Schema.String),
  doc: DocumentSchema,
  editSequence: Schema.Number,
  lastImport: Schema.NullOr(ImportOutcomeSchema),
});

export const RawConfigModel = Schema.Struct({
  feedback: FeedbackSchema,
  schemaOpen: Schema.Boolean,
  dismissedImportSeq: Schema.NullOr(Schema.Number),
  jumpSeq: Schema.Number,
  jumpLine: Schema.NullOr(Schema.Number),
});

export const RawConfigMessage = UiSchema.TaggedEnum({
  ValidationNeeded: {},
  ValidationDebounced: {
    text: Schema.Redacted(Schema.String),
    format: ConfigFormatSchema,
  },
  ValidationCompleted: {
    feedback: FeedbackSchema,
  },
  EditorTextChanged: {
    text: Schema.Redacted(Schema.String),
  },
  ToggledRawOpen: {},
  ToggledSchemaOpen: {},
  ClickedJumpToLine: { line: Schema.Number },
  ClickedFormat: {},
  ClickedRevealConfig: {},
  ClickedOpenConfigInEditor: {},
  ClickedImportExternal: {},
  ClickedReset: {},
  ClickedSave: {},
});

export const RawConfigEvent = UiSchema.TaggedEnum({
  ToggledRawOpen: { open: Schema.Boolean },
  ChangedDoc: { doc: DocumentSchema },
  RequestedRevealConfig: {},
  RequestedOpenConfigInEditor: {},
  RequestedImportExternal: {},
  RequestedDiscardRawConfig: {},
  RequestedSaveRawConfig: {},
});

export const DebounceValidation = Command.make(
  'mcp-gateway/raw-config/DebounceValidation',
  {
    args: {
      text: Schema.Redacted(Schema.String),
      format: ConfigFormatSchema,
    },
    mode: 'switch',
  },
  ({ text, format }) =>
    Effect.sleep(`${PREVIEW_DEBOUNCE_MS} millis`).pipe(
      Effect.as(RawConfigMessage.ValidationDebounced({ text, format })),
    ),
);

export class RunRemoteValidation extends Command.Service<RunRemoteValidation>()(
  'mcp-gateway/raw-config/RunRemoteValidation',
  {
    args: { text: Schema.Redacted(Schema.String) },
    success: RawConfigMessage,
    mode: 'switch',
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* GatewayRpc;
      return ({ text }) =>
        rpc.validateConfig({ text }).pipe(
          Effect.timeoutOption(`${PREVIEW_DISPLAY_TIMEOUT_MS} millis`),
          Effect.map((maybeOutcome) => {
            if (Option.isNone(maybeOutcome)) {
              return RawConfigMessage.ValidationCompleted({
                feedback: { kind: 'unavailable', text },
              });
            }
            const outcome = maybeOutcome.value;
            if (!outcome.ok) {
              return RawConfigMessage.ValidationCompleted({
                feedback: { kind: 'unavailable', text },
              });
            }
            return RawConfigMessage.ValidationCompleted({
              feedback: feedbackOf(outcome.value.issue, text),
            });
          }),
        );
    }),
  );
}

export const RawConfigCommandLayers = Layer.mergeAll(RunRemoteValidation.layer);

const SCHEMA_EXAMPLE = `{
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
}`;

export const RawConfigView = Html.component({
  name: 'RawConfigView',
  props: RawConfigProps,
  model: RawConfigModel,
  message: RawConfigMessage,
  events: RawConfigEvent,
}).make({
  init: ($) =>
    $.set({
      feedback: { kind: 'idle' },
      schemaOpen: false,
      dismissedImportSeq: $.props.lastImport?.seq ?? null,
      jumpSeq: 0,
      jumpLine: null,
    }),
  subscriptions: ({ props }) => {
    const active = props.visible && props.rawOpen && !props.locked;
    return [
      active &&
        Subscription.make(
          'validate-trigger',
          [props.format, props.doc.revision, props.doc.dirty, props.editSequence],
          () => Stream.succeed(RawConfigMessage.ValidationNeeded()),
        ),
    ];
  },
  update: {
    ValidationNeeded: ($) => {
      const active = $.props.visible && $.props.rawOpen && !$.props.locked;
      if (!active) {
        return $.evolve({ feedback: { kind: 'idle' as const } }).run(
          Command.interrupt(DebounceValidation),
          Command.interrupt(RunRemoteValidation),
        );
      }
      return $.evolve({ feedback: { kind: 'idle' as const } }).run(
        Command.interrupt(RunRemoteValidation),
        DebounceValidation.make({ text: $.props.doc.text, format: $.props.format }),
      );
    },
    ValidationDebounced: ($, { text, format }) => {
      const active = $.props.visible && $.props.rawOpen && !$.props.locked;
      const raw = Redacted.value(text);
      if (!active || raw !== Redacted.value($.props.doc.text)) return $.model;
      if (tooLarge(raw)) {
        return $.evolve({
          feedback: { kind: 'issue' as const, text, message: CONFIG_TOO_LARGE, at: null },
        });
      }
      const parsed = parseConfigTree(raw, format);
      if (!parsed.ok) {
        return $.evolve({ feedback: feedbackOf(parsed.issue, text) });
      }
      return $.evolve({ feedback: { kind: 'checking' as const } }).run(
        RunRemoteValidation.make({ text }),
      );
    },
    ValidationCompleted: ($, { feedback }) => {
      const active = $.props.visible && $.props.rawOpen && !$.props.locked;
      if (!active) return $.model;
      const currentRaw = Redacted.value($.props.doc.text);
      const nextFeedback = currentFeedbackFor(feedback, currentRaw);
      if (nextFeedback.kind === 'idle') return $.model;
      return $.evolve({ feedback: nextFeedback });
    },
    EditorTextChanged: ($, { text }) =>
      $.evolve({
        feedback: { kind: 'idle' as const },
        dismissedImportSeq: $.props.lastImport?.seq ?? $.model.dismissedImportSeq,
      }).emit(
        RawConfigEvent.ChangedDoc({
          doc: { text, revision: $.props.doc.revision, dirty: true },
        }),
      ),
    ToggledRawOpen: ($) => {
      const nextOpen = !$.props.rawOpen;
      const step = nextOpen
        ? $.emit(RawConfigEvent.ToggledRawOpen({ open: true }))
        : $.evolve({ feedback: { kind: 'idle' as const } })
            .run(Command.interrupt(DebounceValidation), Command.interrupt(RunRemoteValidation))
            .emit(RawConfigEvent.ToggledRawOpen({ open: false }));
      return step;
    },
    ToggledSchemaOpen: ($) => $.evolve({ schemaOpen: !$.model.schemaOpen }),
    ClickedJumpToLine: ($, { line }) => $.evolve({ jumpSeq: $.model.jumpSeq + 1, jumpLine: line }),
    ClickedFormat: ($) => {
      if ($.props.locked) return $.model;
      const t = translator($.props.locale as Locale);
      const result = formatDraftLogic($.props.doc.text, $.props.format, t);
      if (!result.ok) {
        return $.evolve({ feedback: result.feedback });
      }
      if (!result.changed) return $.model;
      return $.evolve({
        feedback: { kind: 'idle' as const },
        dismissedImportSeq: $.props.lastImport?.seq ?? $.model.dismissedImportSeq,
      }).emit(
        RawConfigEvent.ChangedDoc({
          doc: { text: result.text, revision: $.props.doc.revision, dirty: true },
        }),
      );
    },
    ClickedRevealConfig: ($) => $.emit(RawConfigEvent.RequestedRevealConfig()),
    ClickedOpenConfigInEditor: ($) => $.emit(RawConfigEvent.RequestedOpenConfigInEditor()),
    ClickedImportExternal: ($) => {
      if ($.props.locked || $.props.doc.dirty) return $.model;
      return $.emit(RawConfigEvent.RequestedImportExternal());
    },
    ClickedReset: ($) => $.emit(RawConfigEvent.RequestedDiscardRawConfig()),
    ClickedSave: ($) => $.emit(RawConfigEvent.RequestedSaveRawConfig()),
  },
  view: (h, model) => {
    const props = h.props;
    if (!props.visible) return h.text('');

    const t = translator(props.locale as Locale);
    const fieldId = 'raw-config-editor';
    const currentRawText = Redacted.value(props.doc.text);
    const savedRawText = Redacted.value(props.savedConfigText);
    const current: Feedback = currentFeedbackFor(model.feedback, currentRawText);
    // Native Save stays authoritative; this only blocks a flagged or not-yet-checked draft.
    const saveReady = current.kind === 'ok' || current.kind === 'unavailable';
    const invalid = current.kind === 'issue';
    const importNotice =
      props.lastImport !== null && props.lastImport.seq !== model.dismissedImportSeq
        ? formatImportNotice(props.lastImport.count)
        : null;
    const issueLine = current.kind === 'issue' ? (current.at?.line ?? null) : null;

    return h.section.class('panel raw-panel').children(
      h.button
        .attr('type', 'button')
        .class('raw-heading')
        .attr('aria-expanded', String(props.rawOpen))
        .on('click', () => RawConfigMessage.ToggledRawOpen())
        .children(
          h.span.children(
            h.strong.children(t('raw.title')),
            h.small.children(t('raw.subtitle', { filename: props.filename })),
          ),
          iconChevronRight(h, 'size-4 raw-chevron'),
        ),
      props.rawOpen
        ? h.div.class('raw-body').children(
            h.div
              .key('raw-toolbar')
              .class('mt-3 mb-2 flex items-center justify-between gap-2')
              .children(
                h.p
                  .class('mono config-path m-0 text-[12px] text-mac-label-secondary')
                  .children(props.configPath),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'ghost')
                  .attr('data-size', 'icon')
                  .class(buttonClasses('ghost', 'icon'))
                  .attr('aria-label', 'Schema reference')
                  .attr('aria-expanded', String(model.schemaOpen))
                  .on('click', () => RawConfigMessage.ToggledSchemaOpen())
                  .children(iconCircleHelp(h, 'size-[15px]')),
              ),
            model.schemaOpen
              ? h.div
                  .key('raw-schema-popover')
                  .class('schema-popover')
                  .children(
                    h.p
                      .class('m-0 mb-1.5 text-[12px] text-mac-label-secondary')
                      .children(
                        t('raw.intro'),
                        ' ',
                        props.format === 'jsonc' ? t('raw.jsonc') : t('raw.json'),
                      ),
                    h.pre
                      .class('mono m-0 overflow-x-auto text-[11px] leading-[1.5]')
                      .children(SCHEMA_EXAMPLE),
                  )
              : null,
            h.div
              .key('raw-editor-field')
              .class('field')
              .children(
                h.span
                  .attr('id', `${fieldId}-label`)
                  .class(
                    'flex items-center text-mac-body leading-none font-semibold text-mac-label select-none',
                  )
                  .children(props.filename),
                h.div
                  .key('raw-code-editor')
                  .class(invalid ? 'raw-code-editor raw-code-editor-error' : 'raw-code-editor')
                  .onMount(
                    AttachCodeMirror({
                      text: props.doc.text,
                      revision: props.doc.revision,
                      dirty: props.doc.dirty,
                      locked: props.locked,
                      invalid,
                      fieldId,
                      jumpSeq: model.jumpSeq,
                      jumpLine: model.jumpLine,
                    }).pipe(Mount.map((text) => RawConfigMessage.EditorTextChanged({ text }))),
                  ),
                h.div.class('flex flex-wrap items-center justify-between gap-2').children(
                  h.small
                    .attr('id', `${fieldId}-feedback`)
                    .class(
                      current.kind === 'issue' ? 'raw-feedback raw-feedback-error' : 'raw-feedback',
                    )
                    .attr('role', 'status')
                    .children(importNotice ?? feedbackText(current, t)),
                  issueLine !== null
                    ? h.button
                        .attr('type', 'button')
                        .attr('data-slot', 'button')
                        .attr('data-variant', 'link')
                        .attr('data-size', 'xl')
                        .class(buttonClasses('link', 'xl'))
                        .on('click', () => RawConfigMessage.ClickedJumpToLine({ line: issueLine }))
                        .children(`Line ${issueLine}`)
                    : null,
                ),
              ),
            h.div
              .key('raw-actions')
              .class('raw-actions')
              .children(
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .class(buttonClasses('secondary', 'xl'))
                  .disabled(props.locked)
                  .on('click', () => RawConfigMessage.ClickedRevealConfig())
                  .children(t('raw.showInFinder')),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .class(buttonClasses('secondary', 'xl'))
                  .disabled(props.locked)
                  .on('click', () => RawConfigMessage.ClickedOpenConfigInEditor())
                  .children('Open in External Editor'),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .class(buttonClasses('secondary', 'xl'))
                  .disabled(props.locked || props.doc.dirty)
                  .on('click', () => RawConfigMessage.ClickedImportExternal())
                  .children('Import from Claude / Cursor'),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .class(buttonClasses('secondary', 'xl'))
                  .disabled(props.locked)
                  .on('click', () => RawConfigMessage.ClickedFormat())
                  .children(t('raw.format')),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .class(buttonClasses('secondary', 'xl'))
                  .disabled(props.locked || currentRawText === savedRawText)
                  .on('click', () => RawConfigMessage.ClickedReset())
                  .children(t('raw.reset')),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'default')
                  .attr('data-size', 'xl')
                  .attr('aria-describedby', `${fieldId}-feedback`)
                  .class(buttonClasses('default', 'xl'))
                  .disabled(props.locked || !props.doc.dirty || !saveReady)
                  .on('click', () => RawConfigMessage.ClickedSave())
                  .children(t('raw.save', { filename: props.filename })),
              ),
          )
        : null,
    );
  },
});
