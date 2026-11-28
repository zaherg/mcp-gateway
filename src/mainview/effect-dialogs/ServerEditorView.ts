import { UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Redacted, Schema } from 'effect';

import {
  bearPreset,
  createKeyValueRow,
  hasInvalidKeyValueRows,
  type KeyValueRow,
  rowsToEnvPreview,
  type ServerEditorState,
  ServerEditorStateSchema,
} from '@mcp-gateway/mainview/effect-dialogs/server-editor-logic';
import {
  buttonClasses,
  iconEye,
  iconEyeOff,
  iconLock,
  iconMinus,
  iconPlus,
  inputClasses,
  renderAlert,
  renderCheckboxRow,
  renderField,
  renderModal,
  renderNativeSelect,
  SELECT_OPTION_CLASSES,
} from '@mcp-gateway/mainview/effect-ui';
import { generateToken } from '@mcp-gateway/mainview/lib/token';
import { SAFE_NAME, sensitiveEnvOverrides } from '@mcp-gateway/shared/config-document';
import { type Locale, translator } from '@mcp-gateway/shared/i18n';

export const ServerEditorProps = Schema.Struct({
  locale: Schema.String,
  editor: ServerEditorStateSchema,
  existingNames: Schema.Array(Schema.String),
  editorError: Schema.NullOr(Schema.String),
  configurationLocked: Schema.Boolean,
});

export const ServerEditorModel = Schema.Struct({
  /** Local working draft so rapid synchronous field updates never overwrite each other. */
  editor: ServerEditorStateSchema,
  /** Local reveal only; resets whenever the dialog unmounts. */
  showKey: Schema.Boolean,
  dismissedEnvSignature: Schema.NullOr(Schema.String),
});

const KeyValueFieldSchema = Schema.Literals(['env', 'headers']);

export const ServerEditorMessage = UiSchema.TaggedEnum({
  ChangedEditor: { editor: ServerEditorStateSchema },
  ChangedName: { name: Schema.String },
  ChangedTransport: { transport: Schema.Literals(['stdio', 'http']) },
  ChangedCommand: { command: Schema.String },
  ChangedCwd: { cwd: Schema.String },
  ChangedUrl: { url: Schema.String },
  AddedArg: {},
  UpdatedArg: { index: Schema.Number, value: Schema.String },
  RemovedArg: { index: Schema.Number },
  AddedKeyValueRow: { field: KeyValueFieldSchema },
  UpdatedKeyValueRowKey: { field: KeyValueFieldSchema, id: Schema.String, key: Schema.String },
  UpdatedKeyValueRowValue: {
    field: KeyValueFieldSchema,
    id: Schema.String,
    value: Schema.Redacted(Schema.String),
  },
  ToggledKeyValueRowSecret: { field: KeyValueFieldSchema, id: Schema.String },
  RemovedKeyValueRow: { field: KeyValueFieldSchema, id: Schema.String },
  ChangedAuthMode: { mode: Schema.Literals(['global', 'custom']) },
  ChangedToken: { token: Schema.Redacted(Schema.String) },
  ToggledLegacyProtocol: { checked: Schema.Boolean },
  ToggledDisabled: { checked: Schema.Boolean },
  ToggledShowKey: {},
  DismissedEnvWarning: { signature: Schema.String },
  DismissedError: {},
  ClickedBearPreset: {},
  ClickedGenerateKey: {},
  Submitted: {},
  Closed: {},
});

export const ServerEditorEvent = UiSchema.TaggedEnum({
  ChangedEditor: { editor: ServerEditorStateSchema },
  Submitted: {},
  Closed: {},
  DismissedError: {},
});

const patchEditor = (
  editor: ServerEditorState,
  patch: Partial<ServerEditorState>,
): ServerEditorState => ({ ...editor, ...patch });

const updateRows = (
  editor: ServerEditorState,
  field: 'env' | 'headers',
  transform: (rows: readonly KeyValueRow[]) => KeyValueRow[],
): ServerEditorState => {
  const nextRows = transform(field === 'env' ? editor.env : editor.headers);
  return patchEditor(editor, field === 'env' ? { env: nextRows } : { headers: nextRows });
};

const renderArgsList = (
  h: Html.H<typeof ServerEditorMessage.Type>,
  args: readonly string[],
  readOnly: boolean,
) =>
  h.div.class('args-list flex flex-col gap-1.5').children(
    ...args.map((arg, index) =>
      h.div
        .key(`arg-${index}`)
        .class('flex items-center gap-1.5')
        .children(
          h.input
            .attr('data-slot', 'input')
            .attr('readonly', readOnly ? '' : undefined)
            .attr('placeholder', `--arg-${index + 1}`)
            .class(inputClasses())
            .value(arg)
            .on('input', (event) => ServerEditorMessage.UpdatedArg({ index, value: event.value }))
            .on(
              'keydown',
              (event) =>
                event.key === 'Enter' && !readOnly ? ServerEditorMessage.AddedArg() : undefined,
              { preventDefault: true },
            ),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('data-variant', 'ghost')
            .attr('data-size', 'icon')
            .class(buttonClasses('ghost', 'icon'))
            .disabled(readOnly)
            .attr('aria-label', `Remove argument ${index + 1}`)
            .on('click', () => ServerEditorMessage.RemovedArg({ index }))
            .children(iconMinus(h, 'size-3.5')),
        ),
    ),
    h.div.children(
      h.button
        .attr('type', 'button')
        .attr('data-slot', 'button')
        .attr('data-variant', 'secondary')
        .attr('data-size', 'xl')
        .class(buttonClasses('secondary', 'xl'))
        .disabled(readOnly)
        .on('click', () => ServerEditorMessage.AddedArg())
        .children(iconPlus(h, 'size-3.5'), ' Add Argument'),
    ),
  );

const renderKeyValueTable = (
  h: Html.H<typeof ServerEditorMessage.Type>,
  field: 'env' | 'headers',
  rows: readonly KeyValueRow[],
  readOnly: boolean,
) =>
  h.div.class('kv-table flex flex-col gap-1.5').children(
    ...rows.map((row) => {
      const rawValue = Redacted.value(row.value);
      const isEnvRef = /\$\{[^}]+\}/.test(rawValue);
      return h.div
        .key(row.id)
        .class('flex items-center gap-1.5')
        .children(
          h.input
            .attr('data-slot', 'input')
            .attr('readonly', readOnly ? '' : undefined)
            .attr('placeholder', 'KEY')
            .class(inputClasses())
            .value(row.key)
            .on('input', (event) =>
              ServerEditorMessage.UpdatedKeyValueRowKey({ field, id: row.id, key: event.value }),
            ),
          h.input
            .attr('data-slot', 'input')
            .attr('type', row.secret ? 'password' : 'text')
            .attr('readonly', readOnly ? '' : undefined)
            // biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder syntax for env var.
            .attr('placeholder', 'value or ${ENV_VAR}')
            .class(inputClasses())
            .value(rawValue)
            .on('input', (event) =>
              ServerEditorMessage.UpdatedKeyValueRowValue({
                field,
                id: row.id,
                value: Redacted.make(event.value),
              }),
            ),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('data-variant', 'ghost')
            .attr('data-size', 'icon')
            .class(buttonClasses('ghost', 'icon'))
            .disabled(readOnly)
            .attr('aria-label', row.secret ? 'Show value' : 'Mask value')
            .attr(
              'title',
              isEnvRef
                ? 'Environment variable reference'
                : row.secret
                  ? 'Show value'
                  : 'Mask secret value',
            )
            .on('click', () => ServerEditorMessage.ToggledKeyValueRowSecret({ field, id: row.id }))
            .children(
              isEnvRef
                ? iconLock(h, 'size-3.5')
                : row.secret
                  ? iconEyeOff(h, 'size-3.5')
                  : iconEye(h, 'size-3.5'),
            ),
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('data-variant', 'ghost')
            .attr('data-size', 'icon')
            .class(buttonClasses('ghost', 'icon'))
            .disabled(readOnly)
            .attr('aria-label', `Remove ${row.key || 'row'}`)
            .on('click', () => ServerEditorMessage.RemovedKeyValueRow({ field, id: row.id }))
            .children(iconMinus(h, 'size-3.5')),
        );
    }),
    h.div.children(
      h.button
        .attr('type', 'button')
        .attr('data-slot', 'button')
        .attr('data-variant', 'secondary')
        .attr('data-size', 'xl')
        .class(buttonClasses('secondary', 'xl'))
        .disabled(readOnly)
        .on('click', () => ServerEditorMessage.AddedKeyValueRow({ field }))
        .children(iconPlus(h, 'size-3.5'), ' Add Row'),
    ),
  );

export const ServerEditorView = Html.component({
  name: 'ServerEditorView',
  props: ServerEditorProps,
  model: ServerEditorModel,
  message: ServerEditorMessage,
  events: ServerEditorEvent,
}).make({
  init: ($) => $.set({ editor: $.props.editor, showKey: false, dismissedEnvSignature: null }),
  update: {
    ChangedEditor: ($, { editor }) =>
      $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor })),
    ChangedName: ($, { name }) => {
      const editor = patchEditor($.model.editor, { name });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ChangedTransport: ($, { transport }) => {
      const editor = patchEditor($.model.editor, { type: transport });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ChangedCommand: ($, { command }) => {
      const editor = patchEditor($.model.editor, { command });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ChangedCwd: ($, { cwd }) => {
      const editor = patchEditor($.model.editor, { cwd });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ChangedUrl: ($, { url }) => {
      const editor = patchEditor($.model.editor, { url });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    AddedArg: ($) => {
      const editor = patchEditor($.model.editor, { args: [...$.model.editor.args, ''] });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    UpdatedArg: ($, { index, value }) => {
      const next = [...$.model.editor.args];
      next[index] = value;
      const editor = patchEditor($.model.editor, { args: next });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    RemovedArg: ($, { index }) => {
      const editor = patchEditor($.model.editor, {
        args: $.model.editor.args.filter((_, idx) => idx !== index),
      });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    AddedKeyValueRow: ($, { field }) => {
      const editor = updateRows($.model.editor, field, (rows) => [...rows, createKeyValueRow()]);
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    UpdatedKeyValueRowKey: ($, { field, id, key }) => {
      const editor = updateRows($.model.editor, field, (rows) =>
        rows.map((row) => (row.id === id ? { ...row, key } : row)),
      );
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    UpdatedKeyValueRowValue: ($, { field, id, value }) => {
      const editor = updateRows($.model.editor, field, (rows) =>
        rows.map((row) => (row.id === id ? { ...row, value } : row)),
      );
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ToggledKeyValueRowSecret: ($, { field, id }) => {
      const editor = updateRows($.model.editor, field, (rows) =>
        rows.map((row) => (row.id === id ? { ...row, secret: !row.secret } : row)),
      );
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    RemovedKeyValueRow: ($, { field, id }) => {
      const editor = updateRows($.model.editor, field, (rows) =>
        rows.filter((row) => row.id !== id),
      );
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ChangedAuthMode: ($, { mode }) => {
      const editor = patchEditor($.model.editor, {
        token: mode === 'custom' ? Redacted.make('') : null,
        tokenRef: null,
      });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ChangedToken: ($, { token }) => {
      const editor = patchEditor($.model.editor, { token });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ToggledLegacyProtocol: ($, { checked }) => {
      const editor = patchEditor($.model.editor, { legacyProtocol: checked });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ToggledDisabled: ($, { checked }) => {
      const editor = patchEditor($.model.editor, { disabled: checked });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ToggledShowKey: ($) => $.evolve({ showKey: !$.model.showKey }),
    DismissedEnvWarning: ($, { signature }) => $.evolve({ dismissedEnvSignature: signature }),
    DismissedError: ($) => $.emit(ServerEditorEvent.DismissedError()),
    ClickedBearPreset: ($) => {
      const editor = patchEditor($.model.editor, bearPreset($.model.editor.name));
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    ClickedGenerateKey: ($) => {
      const editor = patchEditor($.model.editor, {
        token: Redacted.make(generateToken()),
        tokenRef: null,
      });
      return $.evolve({ editor }).emit(ServerEditorEvent.ChangedEditor({ editor }));
    },
    Submitted: ($) => $.emit(ServerEditorEvent.Submitted()),
    Closed: ($) => $.emit(ServerEditorEvent.Closed()),
  },
  view: (h, model) => {
    const { existingNames, editorError, configurationLocked } = h.props;
    const editor = model.editor;
    const t = translator(h.props.locale as Locale);
    const trimmedName = editor.name.trim();
    const isDuplicateName =
      trimmedName.length > 0 &&
      trimmedName !== editor.original &&
      existingNames.includes(trimmedName);
    const isInvalidName = trimmedName.length > 0 && !SAFE_NAME.test(trimmedName);
    const hasInvalidEnv = editor.type === 'stdio' && hasInvalidKeyValueRows(editor.env);
    const hasInvalidHeaders = editor.type === 'http' && hasInvalidKeyValueRows(editor.headers);
    const sensitiveKeys =
      editor.type === 'stdio' ? sensitiveEnvOverrides(rowsToEnvPreview(editor.env)) : [];
    const envSignature = sensitiveKeys.join(',');

    const nameInput = h.input
      .attr('id', 'server-editor-name')
      .attr('data-slot', 'input')
      .attr('aria-describedby', 'server-editor-name-help')
      .attr('aria-invalid', isDuplicateName || isInvalidName ? 'true' : undefined)
      .attr('required', '')
      .attr('readonly', configurationLocked ? '' : undefined)
      .class(inputClasses())
      .value(editor.name)
      .on('input', (event) => ServerEditorMessage.ChangedName({ name: event.value }));

    const authValue = editor.token === null && editor.tokenRef === null ? 'global' : 'custom';

    return renderModal(h, {
      titleId: 'server-editor-title',
      title: editor.original ? t('common.editServer') : t('editor.addTitle'),
      closeLabel: t('common.closeDialog'),
      busy: configurationLocked,
      onClose: ServerEditorMessage.Closed(),
      body: [
        h.form
          .on('submit', () => ServerEditorMessage.Submitted(), { preventDefault: true })
          .children(
            h.p
              .class('dialog-intro')
              .children(configurationLocked ? t('editor.lockedIntro') : t('editor.intro')),
            editorError
              ? renderAlert(h, {
                  kind: 'error',
                  dismissLabel: t('common.dismissError'),
                  onDismiss: ServerEditorMessage.DismissedError(),
                  content: editorError,
                })
              : null,
            renderField(h, {
              id: 'server-editor-name',
              label: t('editor.name'),
              help: t('editor.nameHelp', { path: '/mcp/server-name' }),
              control: nameInput,
            }),
            isDuplicateName || isInvalidName
              ? h.p
                  .class('inline-error')
                  .attr('role', 'alert')
                  .children(isDuplicateName ? t('app.serverExists') : t('app.serverFieldsInvalid'))
              : null,
            renderField(h, {
              id: 'server-editor-transport',
              label: t('editor.transport'),
              control: renderNativeSelect(h, {
                id: 'server-editor-transport',
                value: editor.type,
                disabled: configurationLocked,
                onChange: (value) =>
                  ServerEditorMessage.ChangedTransport({
                    transport: value === 'http' ? 'http' : 'stdio',
                  }),
                options: [
                  h.option
                    .attr('data-slot', 'native-select-option')
                    .attr('value', 'stdio')
                    .class(SELECT_OPTION_CLASSES)
                    .children(t('editor.transportStdio')),
                  h.option
                    .attr('data-slot', 'native-select-option')
                    .attr('value', 'http')
                    .class(SELECT_OPTION_CLASSES)
                    .children(t('common.streamableHttp')),
                ],
              }),
            }),
            ...(editor.type === 'stdio'
              ? [
                  renderField(h, {
                    id: 'server-editor-command',
                    label: t('editor.command'),
                    help: t('editor.commandHelp'),
                    control: h.input
                      .attr('id', 'server-editor-command')
                      .attr('data-slot', 'input')
                      .attr('aria-describedby', 'server-editor-command-help')
                      .attr('required', '')
                      .attr('readonly', configurationLocked ? '' : undefined)
                      .attr('placeholder', '/path/to/mcp-server')
                      .class(inputClasses())
                      .value(editor.command)
                      .on('input', (event) =>
                        ServerEditorMessage.ChangedCommand({ command: event.value }),
                      ),
                  }),
                  renderField(h, {
                    id: 'server-editor-args',
                    label: t('editor.args'),
                    control: renderArgsList(h, editor.args, configurationLocked),
                  }),
                  h.div.class('form-grid').children(
                    renderField(h, {
                      id: 'server-editor-env',
                      label: t('editor.env'),
                      control: renderKeyValueTable(h, 'env', editor.env, configurationLocked),
                    }),
                    renderField(h, {
                      id: 'server-editor-cwd',
                      label: t('editor.cwd'),
                      help: t('editor.cwdHelp'),
                      control: h.input
                        .attr('id', 'server-editor-cwd')
                        .attr('data-slot', 'input')
                        .attr('aria-describedby', 'server-editor-cwd-help')
                        .attr('readonly', configurationLocked ? '' : undefined)
                        .attr('placeholder', '/Users/you')
                        .class(inputClasses())
                        .value(editor.cwd)
                        .on('input', (event) =>
                          ServerEditorMessage.ChangedCwd({ cwd: event.value }),
                        ),
                    }),
                  ),
                  hasInvalidEnv
                    ? h.p
                        .class('inline-error')
                        .attr('role', 'alert')
                        .children(t('app.environmentInvalid'))
                    : null,
                  sensitiveKeys.length > 0 && model.dismissedEnvSignature !== envSignature
                    ? renderAlert(h, {
                        kind: 'warning',
                        dismissLabel: t('common.dismissError'),
                        onDismiss: ServerEditorMessage.DismissedEnvWarning({
                          signature: envSignature,
                        }),
                        content: `Overrides sensitive execution environment variable(s): ${sensitiveKeys.join(', ')}`,
                      })
                    : null,
                  h.div.class('preset-row').children(
                    h.button
                      .attr('type', 'button')
                      .attr('data-slot', 'button')
                      .attr('data-variant', 'secondary')
                      .attr('data-size', 'xl')
                      .class(buttonClasses('secondary', 'xl'))
                      .disabled(configurationLocked)
                      .on('click', () => ServerEditorMessage.ClickedBearPreset())
                      .children(t('editor.bearPreset')),
                    h.small.children(t('editor.bearNote')),
                  ),
                ]
              : [
                  renderField(h, {
                    id: 'server-editor-url',
                    label: t('editor.url'),
                    help: t('editor.urlHelp', { scheme: 'HTTP(S)' }),
                    control: h.input
                      .attr('id', 'server-editor-url')
                      .attr('data-slot', 'input')
                      .attr('aria-describedby', 'server-editor-url-help')
                      .attr('required', '')
                      .attr('readonly', configurationLocked ? '' : undefined)
                      .attr('placeholder', 'https://your-server.example/mcp')
                      .class(inputClasses())
                      .value(editor.url)
                      .on('input', (event) => ServerEditorMessage.ChangedUrl({ url: event.value })),
                  }),
                  renderField(h, {
                    id: 'server-editor-headers',
                    label: t('editor.headers'),
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal environment reference.
                    help: t('editor.headersHelp', { example: '${API_TOKEN}' }),
                    control: renderKeyValueTable(h, 'headers', editor.headers, configurationLocked),
                  }),
                  hasInvalidHeaders
                    ? h.p
                        .class('inline-error')
                        .attr('role', 'alert')
                        .children(t('app.headersInvalid'))
                    : null,
                ]),
            renderField(h, {
              id: 'server-editor-auth',
              label: t('editor.auth'),
              help: t('editor.authHelp'),
              control: renderNativeSelect(h, {
                id: 'server-editor-auth',
                value: authValue,
                disabled: configurationLocked,
                ariaDescribedBy: 'server-editor-auth-help',
                onChange: (value) =>
                  ServerEditorMessage.ChangedAuthMode({
                    mode: value === 'custom' ? 'custom' : 'global',
                  }),
                options: [
                  h.option
                    .attr('data-slot', 'native-select-option')
                    .attr('value', 'global')
                    .class(SELECT_OPTION_CLASSES)
                    .children(t('editor.authGlobal')),
                  h.option
                    .attr('data-slot', 'native-select-option')
                    .attr('value', 'custom')
                    .class(SELECT_OPTION_CLASSES)
                    .children(t('editor.authCustom')),
                ],
              }),
            }),
            editor.tokenRef !== null
              ? renderField(h, {
                  id: 'server-editor-key-stored',
                  label: t('editor.key'),
                  help: t('editor.keyHelp'),
                  control: h.p.class('m-0 text-[13px]').children(t('keys.stored')),
                })
              : null,
            editor.token !== null
              ? renderField(h, {
                  id: 'server-editor-key',
                  label: t('editor.key'),
                  help: t('editor.keyHelp'),
                  control: h.div.class('token-input').children(
                    h.input
                      .attr('id', 'server-editor-key')
                      .attr('data-slot', 'input')
                      .attr('autocomplete', 'off')
                      .attr('spellcheck', 'false')
                      .attr('aria-describedby', 'server-editor-key-help')
                      .attr('type', model.showKey ? 'text' : 'password')
                      .attr('readonly', configurationLocked ? '' : undefined)
                      // biome-ignore lint/suspicious/noTemplateCurlyInString: placeholder syntax for env var.
                      .attr('placeholder', '${PRIVATE_MCP_TOKEN}')
                      .class(inputClasses())
                      .value(Redacted.value(editor.token))
                      .on('input', (event) =>
                        ServerEditorMessage.ChangedToken({ token: Redacted.make(event.value) }),
                      ),
                    h.button
                      .attr('type', 'button')
                      .attr('data-slot', 'button')
                      .attr('data-variant', 'ghost')
                      .attr('data-size', 'icon-lg')
                      .class(buttonClasses('ghost', 'icon-lg'))
                      .attr('aria-label', model.showKey ? t('editor.hideKey') : t('editor.showKey'))
                      .on('click', () => ServerEditorMessage.ToggledShowKey())
                      .children(model.showKey ? iconEyeOff(h, 'size-4') : iconEye(h, 'size-4')),
                  ),
                })
              : null,
            editor.token !== null || editor.tokenRef !== null
              ? h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'lg')
                  .class(buttonClasses('secondary', 'lg'))
                  .disabled(configurationLocked)
                  // A new literal replaces a Keychain reference; that is also the repair for an unreadable item.
                  .on('click', () => ServerEditorMessage.ClickedGenerateKey())
                  .children(t('editor.generateKey'))
              : null,
            renderCheckboxRow(h, {
              id: 'server-editor-legacy',
              key: 'server-editor-legacy',
              label: t('editor.legacy'),
              checked: editor.legacyProtocol,
              disabled: configurationLocked,
              onToggle: (checked) => ServerEditorMessage.ToggledLegacyProtocol({ checked }),
            }),
            renderCheckboxRow(h, {
              id: 'server-editor-disabled',
              key: 'server-editor-disabled',
              label: t('editor.disabled'),
              checked: editor.disabled,
              disabled: configurationLocked,
              onToggle: (checked) => ServerEditorMessage.ToggledDisabled({ checked }),
            }),
            h.div.class('dialog-actions').children(
              h.button
                .attr('type', 'button')
                .attr('data-slot', 'button')
                .attr('data-variant', 'secondary')
                .attr('data-size', 'xl')
                .class(buttonClasses('secondary', 'xl'))
                .on('click', () => ServerEditorMessage.Closed())
                .children(t('common.cancel')),
              h.button
                .attr('type', 'submit')
                .attr('data-slot', 'button')
                .attr('data-variant', 'default')
                .attr('data-size', 'xl')
                .class(buttonClasses('default', 'xl'))
                .disabled(
                  configurationLocked ||
                    isDuplicateName ||
                    isInvalidName ||
                    hasInvalidEnv ||
                    hasInvalidHeaders,
                )
                .children(t('editor.apply')),
            ),
            h.small.class('dialog-footnote').children(t('editor.footnote')),
          ),
      ],
    });
  },
});
