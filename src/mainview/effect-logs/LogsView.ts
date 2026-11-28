import { Command, Component, UiSchema } from '@effect/ui';
import { Html, HtmlSubscription } from '@effect/ui/html';
import { Effect, Layer, Schema } from 'effect';

import {
  applyLogPage,
  availableLogServers,
  EMPTY_LOG_BUFFER,
  filterLogEntries,
  formatLogEntryForCopy,
} from '@mcp-gateway/mainview/effect-logs/buffer';
import { LogsDom, LogsRpc } from '@mcp-gateway/mainview/effect-logs/services';
import { type Locale, translator } from '@mcp-gateway/shared/i18n';
import { LOG_LEVELS, LOG_LIMITS, type LogEntry, type LogLevel } from '@mcp-gateway/shared/types';

export const LogLevelSchema = Schema.Literals(LOG_LEVELS);
export const LogLevelFilterSchema = Schema.Union([LogLevelSchema, Schema.Literal('')]);

export const LogEntrySchema = Schema.Struct({
  id: Schema.Number,
  time: Schema.String,
  server: Schema.NullOr(Schema.String),
  level: LogLevelSchema,
  source: Schema.Literals(['logger', 'stderr', 'controller']),
  text: Schema.String,
  truncated: Schema.Boolean,
});

export const LogPageSchema = Schema.Struct({
  entries: Schema.Array(LogEntrySchema),
  cursor: Schema.Number,
  generation: Schema.Number,
  gap: Schema.Boolean,
  hasMore: Schema.Boolean,
});

export const PollPhaseSchema = Schema.Literals(['polling', 'clearing']);

export const LogsProps = Schema.Struct({
  servers: Schema.Array(Schema.String),
  locale: Schema.String,
});

export const LogsModel = Schema.Struct({
  entries: Schema.Array(LogEntrySchema),
  cursor: Schema.Number,
  bufferGeneration: Schema.NullOr(Schema.Number),
  gap: Schema.Boolean,
  level: LogLevelFilterSchema,
  server: Schema.String,
  text: Schema.String,
  followTail: Schema.Boolean,
  infoOpen: Schema.Boolean,
  copiedId: Schema.NullOr(Schema.Number),
  readError: Schema.NullOr(Schema.String),
  clearError: Schema.NullOr(Schema.String),
  pollPhase: PollPhaseSchema,
});

export const LogsMessage = UiSchema.TaggedEnum({
  PollTicked: {},
  PollSucceeded: { page: LogPageSchema },
  PollFailed: { kind: Schema.Literals(['rpc', 'bridge']), message: Schema.String },
  ClickedClear: {},
  ClearSucceeded: {},
  ClearFailed: { kind: Schema.Literals(['rpc', 'bridge']), message: Schema.String },
  ChangedLevel: { level: Schema.String },
  ChangedServer: { server: Schema.String },
  ChangedSearch: { text: Schema.String },
  ToggledFollowTail: {},
  ScrolledList: {},
  MeasuredScrollBottom: { atBottom: Schema.Boolean },
  ToggledInfo: {},
  DismissedReadError: {},
  DismissedClearError: {},
  ClickedCopy: { entryId: Schema.Number, text: Schema.String },
  CopyCompleted: { entryId: Schema.Number, copied: Schema.Boolean },
  CopyBadgeExpired: { entryId: Schema.Number },
  PressedFindShortcut: {},
});

export class ReadLogsPage extends Command.Service<ReadLogsPage>()('mcp-gateway/logs/ReadLogsPage', {
  args: { after: Schema.Number },
  success: LogsMessage,
  mode: 'switch',
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* LogsRpc;
      return ({ after }) =>
        rpc.readLogs({ after }).pipe(
          Effect.match({
            onSuccess: (page) => LogsMessage.PollSucceeded({ page }),
            onFailure: (error) =>
              LogsMessage.PollFailed({ kind: error.kind, message: error.message }),
          }),
        );
    }),
  );
}

export class ClearLogs extends Command.Service<ClearLogs>()('mcp-gateway/logs/ClearLogs', {
  args: {},
  success: LogsMessage,
  mode: 'switch',
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const rpc = yield* LogsRpc;
      return () =>
        rpc.clearLogs().pipe(
          Effect.match({
            onSuccess: () => LogsMessage.ClearSucceeded(),
            onFailure: (error) =>
              LogsMessage.ClearFailed({ kind: error.kind, message: error.message }),
          }),
        );
    }),
  );
}

export class CopyLogEntry extends Command.Service<CopyLogEntry>()('mcp-gateway/logs/CopyLogEntry', {
  args: { entryId: Schema.Number, text: Schema.String },
  success: LogsMessage,
  mode: 'switch',
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const dom = yield* LogsDom;
      return ({ entryId, text }) =>
        dom
          .copyText(text)
          .pipe(Effect.map((copied) => LogsMessage.CopyCompleted({ entryId, copied })));
    }),
  );
}

export class FocusSearch extends Command.Service<FocusSearch>()('mcp-gateway/logs/FocusSearch', {
  args: {},
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const dom = yield* LogsDom;
      return () => dom.focusSearchInput().pipe(Effect.as(Component.noop));
    }),
  );
}

export class ScrollToBottom extends Command.Service<ScrollToBottom>()(
  'mcp-gateway/logs/ScrollToBottom',
  {
    args: {},
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const dom = yield* LogsDom;
      return () => dom.scrollToBottom().pipe(Effect.as(Component.noop));
    }),
  );
}

export class CheckScrollBottom extends Command.Service<CheckScrollBottom>()(
  'mcp-gateway/logs/CheckScrollBottom',
  {
    args: {},
    success: LogsMessage,
    mode: 'switch',
  },
) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const dom = yield* LogsDom;
      return () =>
        dom
          .isScrolledToBottom()
          .pipe(Effect.map((atBottom) => LogsMessage.MeasuredScrollBottom({ atBottom })));
    }),
  );
}

export const SchedulePollWait = Command.make(
  'mcp-gateway/logs/SchedulePollWait',
  { args: { delayMs: Schema.Number }, mode: 'switch' },
  ({ delayMs }) => Effect.sleep(`${delayMs} millis`).pipe(Effect.as(LogsMessage.PollTicked())),
);

export const ExpireCopyBadge = Command.make(
  'mcp-gateway/logs/ExpireCopyBadge',
  { args: { entryId: Schema.Number }, mode: 'switch' },
  ({ entryId }) =>
    Effect.sleep('1500 millis').pipe(Effect.as(LogsMessage.CopyBadgeExpired({ entryId }))),
);

export const LogsCommandLayers = Layer.mergeAll(
  ReadLogsPage.layer,
  ClearLogs.layer,
  CopyLogEntry.layer,
  FocusSearch.layer,
  ScrollToBottom.layer,
  CheckScrollBottom.layer,
);

const BUTTON_BASE =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none transition-[background-color,color,opacity] outline-none focus-visible:mac-focus-ring disabled:pointer-events-none data-disabled:pointer-events-none aria-invalid:mac-focus-ring [&_svg]:pointer-events-none [&_svg]:shrink-0';
const BUTTON_DEFAULT =
  'bg-mac-accent text-mac-accent-foreground active:brightness-90 disabled:opacity-45';
const BUTTON_SECONDARY =
  'bg-mac-control text-mac-label active:bg-mac-control-pressed disabled:bg-mac-control-disabled disabled:text-mac-label-tertiary';
const BUTTON_GHOST =
  'text-mac-label hover:bg-mac-fill-tertiary active:bg-mac-control-pressed disabled:text-mac-label-tertiary';
const BUTTON_XL = "h-9 rounded-full px-4 text-mac-body [&_svg:not([class*='size-'])]:size-4";
const BUTTON_ICON = "size-6 rounded-[6px] [&_svg:not([class*='size-'])]:size-3.5";

const SELECT_CLASSES =
  'h-9 w-full min-w-0 cursor-default appearance-none rounded-lg bg-mac-control py-0 pr-7 pl-3 text-mac-body font-medium text-mac-label outline-none select-none focus-visible:mac-focus-ring active:bg-mac-control-pressed disabled:pointer-events-none aria-invalid:mac-focus-ring';

const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-[6px] bg-mac-field px-2 text-mac-body font-medium text-mac-label shadow-[0_0_0_1px_var(--mac-field-border)] transition-[box-shadow] outline-none selection:bg-mac-accent/30 placeholder:font-normal placeholder:text-mac-label-tertiary disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:shadow-[0_0_0_1px_var(--mac-field-border),0_0_0_3.5px_color-mix(in_srgb,var(--mac-accent)_50%,transparent),inset_0_0_0_1px_color-mix(in_srgb,var(--mac-accent)_50%,transparent)]';

const ALERT_CLASSES =
  'group/alert relative grid w-full gap-0.5 rounded-[10px] px-3 py-2.5 text-left text-mac-body bg-mac-red/8 text-mac-red shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mac-red)_30%,transparent)] mb-4 flex items-center gap-2.5 text-mac-label';

type LogsHelper = Html.H<typeof LogsMessage.Type>;

const resolveTranslator = (locale: string) => translator(locale as Locale);

const svgIcon = (h: LogsHelper, sizeClass: string, paths: ReadonlyArray<string>) =>
  h.svg
    .class(sizeClass)
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(...paths.map((d) => h.path.attr('d', d)));

const chevronsUpDownIcon = (h: LogsHelper) =>
  h.svg
    .class('pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-mac-label')
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2.5')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .attr('data-slot', 'native-select-icon')
    .children(h.path.attr('d', 'm7 15 5 5 5-5'), h.path.attr('d', 'm7 9 5-5 5 5'));

const arrowDownToLineIcon = (h: LogsHelper) =>
  svgIcon(h, 'size-4', ['M12 17V3', 'm6 11 6 6 6-6', 'M19 21H5']);

const circleHelpIcon = (h: LogsHelper) =>
  svgIcon(h, 'size-3.5', [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
    'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3',
    'M12 17h.01',
  ]);

const copyIcon = (h: LogsHelper) =>
  svgIcon(h, 'size-3.5', [
    'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z',
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  ]);

const checkIcon = (h: LogsHelper) => svgIcon(h, 'size-3.5', ['M20 6 9 17l-5-5']);

const closeIcon = (h: LogsHelper) => svgIcon(h, 'size-3.5', ['M18 6 6 18', 'm6 6 12 12']);

const initialModel = (): typeof LogsModel.Type => ({
  entries: [...EMPTY_LOG_BUFFER.entries],
  cursor: EMPTY_LOG_BUFFER.cursor,
  bufferGeneration: EMPTY_LOG_BUFFER.bufferGeneration,
  gap: EMPTY_LOG_BUFFER.gap,
  level: '',
  server: '',
  text: '',
  followTail: true,
  infoOpen: false,
  copiedId: null,
  readError: null,
  clearError: null,
  pollPhase: 'polling',
});

export const LogsView = Html.component({
  name: 'LogsView',
  props: LogsProps,
  model: LogsModel,
  message: LogsMessage,
}).make({
  init: ($) => $.set(initialModel()).run(ReadLogsPage.make({ after: 0 })),
  update: {
    PollTicked: ($) =>
      $.model.pollPhase === 'polling'
        ? $.run(ReadLogsPage.make({ after: $.model.cursor }))
        : $.model,
    PollSucceeded: ($, { page }) => {
      if ($.model.pollPhase !== 'polling') return $.model;
      const nextBuffer = applyLogPage(
        {
          entries: $.model.entries,
          cursor: $.model.cursor,
          bufferGeneration: $.model.bufferGeneration,
          gap: $.model.gap,
        },
        page,
      );
      const nextStep = $.evolve({
        entries: [...nextBuffer.entries],
        cursor: nextBuffer.cursor,
        bufferGeneration: nextBuffer.bufferGeneration,
        gap: nextBuffer.gap,
        readError: null,
      }).run(SchedulePollWait.make({ delayMs: page.hasMore ? 0 : 2000 }));
      return $.model.followTail && page.entries.length > 0
        ? nextStep.run(ScrollToBottom.make())
        : nextStep;
    },
    PollFailed: ($, { kind, message }) => {
      if ($.model.pollPhase !== 'polling') return $.model;
      const t = resolveTranslator($.props.locale);
      return $.evolve({
        readError: kind === 'rpc' ? message : t('logs.readFailed'),
      }).run(SchedulePollWait.make({ delayMs: 2000 }));
    },
    ClickedClear: ($) => {
      if ($.model.pollPhase === 'clearing') return $.model;
      return $.evolve({
        pollPhase: 'clearing' as const,
        clearError: null,
      }).run(
        Command.interrupt(ReadLogsPage),
        Command.interrupt(SchedulePollWait),
        ClearLogs.make(),
      );
    },
    ClearSucceeded: ($) =>
      $.evolve({
        entries: [],
        cursor: 0,
        bufferGeneration: null,
        gap: false,
        readError: null,
        clearError: null,
        pollPhase: 'polling' as const,
      }).run(ReadLogsPage.make({ after: 0 })),
    ClearFailed: ($, { kind, message }) => {
      const t = resolveTranslator($.props.locale);
      return $.evolve({
        clearError: kind === 'rpc' ? message : t('logs.clearFailed'),
        pollPhase: 'polling' as const,
      }).run(ReadLogsPage.make({ after: $.model.cursor }));
    },
    ChangedLevel: ($, { level }) => {
      const nextLevel: LogLevel | '' = LOG_LEVELS.find((item) => item === level) ?? '';
      const step = $.evolve({ level: nextLevel });
      return $.model.followTail ? step.run(ScrollToBottom.make()) : step;
    },
    ChangedServer: ($, { server }) => {
      const step = $.evolve({ server });
      return $.model.followTail ? step.run(ScrollToBottom.make()) : step;
    },
    ChangedSearch: ($, { text }) => {
      const step = $.evolve({ text });
      return $.model.followTail ? step.run(ScrollToBottom.make()) : step;
    },
    ToggledFollowTail: ($) => {
      const next = !$.model.followTail;
      const step = $.evolve({ followTail: next });
      return next ? step.run(ScrollToBottom.make()) : step;
    },
    ScrolledList: ($) => $.run(CheckScrollBottom.make()),
    MeasuredScrollBottom: ($, { atBottom }) =>
      atBottom === $.model.followTail ? $.model : $.evolve({ followTail: atBottom }),
    ToggledInfo: ($) => $.evolve({ infoOpen: (open) => !open }),
    DismissedReadError: ($) => $.evolve({ readError: null }),
    DismissedClearError: ($) => $.evolve({ clearError: null }),
    ClickedCopy: ($, { entryId, text }) => $.run(CopyLogEntry.make({ entryId, text })),
    CopyCompleted: ($, { entryId, copied }) =>
      copied ? $.evolve({ copiedId: entryId }).run(ExpireCopyBadge.make({ entryId })) : $.model,
    CopyBadgeExpired: ($, { entryId }) =>
      $.model.copiedId === entryId ? $.evolve({ copiedId: null }) : $.model,
    PressedFindShortcut: ($) => $.run(FocusSearch.make()),
  },
  subscriptions: () => [
    HtmlSubscription.onDocument(
      'keydown',
      (event) =>
        (event.meta || event.ctrl) && event.key.toLowerCase() === 'f'
          ? LogsMessage.PressedFindShortcut()
          : undefined,
      { preventDefault: true },
    ),
  ],
  view: (h, model) => {
    const t = resolveTranslator(h.props.locale);
    const filtered = filterLogEntries(model.entries, {
      level: model.level,
      server: model.server,
      text: model.text,
    });
    const serverOptions = availableLogServers(h.props.servers, model.entries);
    const clearing = model.pollPhase === 'clearing' || h.isRunning(ClearLogs);

    const renderAlert = (text: string, onDismiss: typeof LogsMessage.Type) =>
      h.div
        .attr('data-slot', 'alert')
        .attr('role', 'alert')
        .class(ALERT_CLASSES)
        .children(
          h.span.class('min-w-0 flex-1 wrap-anywhere').children(text),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('aria-label', t('common.dismissError'))
            .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON)
            .on('click', onDismiss)
            .children(closeIcon(h)),
        );

    return h.section
      .class('panel logs-panel')
      .attr('aria-label', t('logs.title'))
      .children(
        h.div.class('log-toolbar').children(
          h.div
            .class('group/native-select relative w-fit shrink-0')
            .attr('data-slot', 'native-select-wrapper')
            .attr('data-size', 'default')
            .children(
              h.select
                .class(SELECT_CLASSES)
                .attr('data-slot', 'native-select')
                .attr('data-size', 'default')
                .attr('aria-label', t('logs.level'))
                .value(model.level)
                .on('change', ({ value }) => LogsMessage.ChangedLevel({ level: value }))
                .children(
                  h.option
                    .attr('value', '')
                    .class('bg-[Canvas] text-[CanvasText]')
                    .children(t('logs.allLevels')),
                  ...LOG_LEVELS.map((value) =>
                    h.option
                      .key(value)
                      .attr('value', value)
                      .class('bg-[Canvas] text-[CanvasText]')
                      .children(value),
                  ),
                ),
              chevronsUpDownIcon(h),
            ),
          h.div
            .class('group/native-select relative w-fit max-w-44 shrink-0')
            .attr('data-slot', 'native-select-wrapper')
            .attr('data-size', 'default')
            .children(
              h.select
                .class(SELECT_CLASSES)
                .attr('data-slot', 'native-select')
                .attr('data-size', 'default')
                .attr('aria-label', t('logs.server'))
                .value(model.server)
                .on('change', ({ value }) => LogsMessage.ChangedServer({ server: value }))
                .children(
                  h.option
                    .attr('value', '')
                    .class('bg-[Canvas] text-[CanvasText]')
                    .children(t('logs.allServers')),
                  ...serverOptions.map((value) =>
                    h.option
                      .key(value)
                      .attr('value', value)
                      .class('bg-[Canvas] text-[CanvasText]')
                      .children(value),
                  ),
                ),
              chevronsUpDownIcon(h),
            ),
          h.div.class('min-w-28 flex-1').children(
            h.input
              .class(INPUT_CLASSES)
              .attr('data-slot', 'input')
              .attr('aria-label', t('logs.search'))
              .attr('placeholder', `${t('logs.search')} (⌘F)`)
              .attr('maxlength', String(LOG_LIMITS.queryTextCharacters))
              .value(model.text)
              .on('input', ({ value }) => LogsMessage.ChangedSearch({ text: value }))
              .on('change', ({ value }) => LogsMessage.ChangedSearch({ text: value })),
          ),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('aria-pressed', String(model.followTail))
            .class(BUTTON_BASE, model.followTail ? BUTTON_DEFAULT : BUTTON_SECONDARY, BUTTON_XL)
            .on('click', LogsMessage.ToggledFollowTail())
            .children(arrowDownToLineIcon(h), ' Follow Tail'),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .disabled(clearing)
            .class(BUTTON_BASE, BUTTON_SECONDARY, BUTTON_XL)
            .on('click', LogsMessage.ClickedClear())
            .children(t('logs.clear')),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('aria-label', t('logs.sensitiveTitle'))
            .attr('aria-expanded', String(model.infoOpen))
            .attr('title', `${t('logs.sensitiveTitle')} ${t('logs.sensitiveBody')}`)
            .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON)
            .on('click', LogsMessage.ToggledInfo())
            .children(circleHelpIcon(h)),
        ),
        model.infoOpen &&
          h.div.class('schema-popover mb-3').children(
            h.p
              .class('m-0 text-[12px] text-mac-label')
              .children(h.strong.children(t('logs.sensitiveTitle')), ` ${t('logs.sensitiveBody')}`),
            h.p.class('m-0 mt-1 text-[11px] text-mac-label-secondary').children(
              t('logs.limits', {
                entries: LOG_LIMITS.entries,
                megabytes: LOG_LIMITS.bytes / 1024 / 1024,
                kilobytes: LOG_LIMITS.entryBytes / 1024,
              }),
            ),
          ),
        model.readError !== null && renderAlert(model.readError, LogsMessage.DismissedReadError()),
        model.clearError !== null &&
          renderAlert(model.clearError, LogsMessage.DismissedClearError()),
        model.gap &&
          h.p
            .attr('role', 'status')
            .class('mb-2 text-[12px] text-mac-label-secondary')
            .children(t('logs.gap')),
        h.section
          .class('log-entries')
          .attr('tabindex', '0')
          .attr('aria-label', t('logs.entries'))
          .on('scroll', LogsMessage.ScrolledList())
          .children(
            filtered.length > 0
              ? h.div.class('log-table').children(
                  ...filtered.map((entry: LogEntry) => {
                    const copied = model.copiedId === entry.id;
                    const copyText = formatLogEntryForCopy(entry, t('logs.appSource'));
                    return h.div
                      .key(String(entry.id))
                      .class('log-row')
                      .children(
                        h.div.class('log-row-header').children(
                          h.time.class('log-time').children(entry.time),
                          h.span.class(`log-level-pill ${entry.level}`).children(entry.level),
                          h.span.class('log-source').children(entry.server ?? t('logs.appSource')),
                          h.button
                            .attr('type', 'button')
                            .attr('data-slot', 'button')
                            .attr('aria-label', 'Copy log entry')
                            .class(BUTTON_BASE, BUTTON_GHOST, BUTTON_ICON, 'ml-auto')
                            .on(
                              'click',
                              LogsMessage.ClickedCopy({ entryId: entry.id, text: copyText }),
                            )
                            .children(copied ? checkIcon(h) : copyIcon(h)),
                        ),
                        h.div
                          .class('log-message')
                          .children(entry.text, entry.truncated ? ` (${t('logs.truncated')})` : ''),
                      );
                  }),
                )
              : h.p
                  .class('empty-state')
                  .children(model.entries.length > 0 ? t('logs.noMatches') : t('logs.empty')),
          ),
      );
  },
});
