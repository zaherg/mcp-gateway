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
import {
  buttonClasses,
  INPUT_CLASSES,
  iconArrowDownToLine,
  iconCheck,
  iconChevronsUpDown,
  iconCircleHelp,
  iconCopy,
  renderAlert,
  SELECT_CLASSES,
  SELECT_OPTION_CLASSES,
} from '@mcp-gateway/mainview/effect-ui';
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

const resolveTranslator = (locale: string) => translator(locale as Locale);

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
                    .class(SELECT_OPTION_CLASSES)
                    .children(t('logs.allLevels')),
                  ...LOG_LEVELS.map((value) =>
                    h.option
                      .key(value)
                      .attr('value', value)
                      .class(SELECT_OPTION_CLASSES)
                      .children(value),
                  ),
                ),
              iconChevronsUpDown(h),
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
                    .class(SELECT_OPTION_CLASSES)
                    .children(t('logs.allServers')),
                  ...serverOptions.map((value) =>
                    h.option
                      .key(value)
                      .attr('value', value)
                      .class(SELECT_OPTION_CLASSES)
                      .children(value),
                  ),
                ),
              iconChevronsUpDown(h),
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
            .class(buttonClasses(model.followTail ? 'default' : 'secondary', 'xl'))
            .on('click', LogsMessage.ToggledFollowTail())
            .children(iconArrowDownToLine(h), ' Follow Tail'),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .disabled(clearing)
            .class(buttonClasses('secondary', 'xl'))
            .on('click', LogsMessage.ClickedClear())
            .children(t('logs.clear')),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('aria-label', t('logs.sensitiveTitle'))
            .attr('aria-expanded', String(model.infoOpen))
            .attr('title', `${t('logs.sensitiveTitle')} ${t('logs.sensitiveBody')}`)
            .class(buttonClasses('ghost', 'icon'))
            .on('click', LogsMessage.ToggledInfo())
            .children(iconCircleHelp(h)),
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
        model.readError !== null &&
          renderAlert(h, {
            dismissLabel: t('common.dismissError'),
            onDismiss: LogsMessage.DismissedReadError(),
            content: model.readError,
          }),
        model.clearError !== null &&
          renderAlert(h, {
            dismissLabel: t('common.dismissError'),
            onDismiss: LogsMessage.DismissedClearError(),
            content: model.clearError,
          }),
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
                            .class(buttonClasses('ghost', 'icon', 'ml-auto'))
                            .on(
                              'click',
                              LogsMessage.ClickedCopy({ entryId: entry.id, text: copyText }),
                            )
                            .children(copied ? iconCheck(h) : iconCopy(h)),
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
