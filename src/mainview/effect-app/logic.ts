import { Redacted } from 'effect';

import type {
  AppModelValue,
  AppSnapshotRedacted,
  GatewaySnapshotRedacted,
  UpdateStatusValue,
  VisibleErrorValue,
} from '@mcp-gateway/mainview/effect-app/schemas';
import {
  type DocumentRedacted,
  formConfig,
  keyValueRowsToRecord,
  type ServerEditorState,
} from '@mcp-gateway/mainview/effect-dialogs/server-editor-logic';
import { changelogSection } from '@mcp-gateway/shared/changelog';
import {
  type ConfigFormat,
  editConfigDocument,
  SAFE_NAME,
} from '@mcp-gateway/shared/config-document';
import type { Locale, Translate } from '@mcp-gateway/shared/i18n';
import type { ConfigFile } from '@mcp-gateway/shared/types';

export interface Rename {
  readonly from: string;
  readonly to: string;
}

export interface DerivedAppState {
  readonly gateway: GatewaySnapshotRedacted | undefined;
  readonly format: ConfigFormat;
  readonly filename: string;
  readonly dirty: boolean;
  readonly stale: boolean;
  readonly config: ConfigFile | null;
  readonly existingNames: ReadonlySet<string>;
  readonly rawOperationalError: VisibleErrorValue | null;
  readonly operationalError: VisibleErrorValue | null;
  readonly updateState: UpdateStatusValue | undefined;
  readonly updateRestarting: boolean;
  readonly configurationLocked: boolean;
  readonly whatsNewPending: boolean;
  readonly updatesOpen: boolean;
  readonly competingDialog: boolean;
  readonly updatesTriggerDisabled: boolean;
}

export const initialAppModel = (
  locale: Locale = 'en_US',
  title = 'MCP Gateway',
): AppModelValue => ({
  locale,
  title,
  snapshot: null,
  doc: null,
  editSequence: 0,
  generation: 0,
  error: null,
  dismissedOpErrorId: null,
  busy: false,
  updateBusy: false,
  activeModal: null,
  serverEditorOpenSeq: 0,
  editorError: null,
  keyMigrationStatus: 'idle',
  lastImport: null,
  showToken: false,
  rawOpen: false,
  whatsNewClosed: false,
  updatesRequested: false,
  tab: 'overview',
});

export const cleanDocFromSnapshot = (snapshot: AppSnapshotRedacted): DocumentRedacted => ({
  text: snapshot.gateway.configText,
  revision: snapshot.gateway.revision,
  dirty: false,
});

export const applyIncomingSnapshot = (
  model: AppModelValue,
  nextSnapshot: AppSnapshotRedacted,
  startedEditSeq: number = model.editSequence,
): AppModelValue => {
  const shouldReplaceDoc =
    !model.doc?.dirty &&
    model.activeModal?.kind !== 'serverEditor' &&
    startedEditSeq === model.editSequence;
  return {
    ...model,
    locale: nextSnapshot.language.locale,
    snapshot: nextSnapshot,
    doc: shouldReplaceDoc ? cleanDocFromSnapshot(nextSnapshot) : model.doc,
  };
};

export interface OperationSuccessOptions {
  readonly saved: boolean;
  readonly startedEditSeq: number;
  readonly submittedText: Redacted.Redacted<string> | null;
}

export const applyOperationSuccess = (
  model: AppModelValue,
  nextSnapshot: AppSnapshotRedacted,
  options: OperationSuccessOptions,
): AppModelValue => {
  let nextDoc = model.doc;
  if (options.saved) {
    const currentDoc = model.doc;
    const expectedText = options.submittedText ?? currentDoc?.text ?? null;
    if (
      currentDoc &&
      expectedText &&
      model.editSequence === options.startedEditSeq &&
      Redacted.value(currentDoc.text) === Redacted.value(expectedText)
    ) {
      nextDoc = cleanDocFromSnapshot(nextSnapshot);
    } else if (currentDoc) {
      nextDoc = {
        text: currentDoc.text,
        revision: nextSnapshot.gateway.revision,
        dirty: Redacted.value(currentDoc.text) !== Redacted.value(nextSnapshot.gateway.configText),
      };
    }
  }
  return {
    ...model,
    locale: nextSnapshot.language.locale,
    snapshot: nextSnapshot,
    doc: nextDoc,
  };
};

export const computeDerivedState = (
  model: AppModelValue,
  changelogText: string,
): DerivedAppState => {
  const snapshot = model.snapshot;
  const gateway = snapshot?.gateway;
  const format: ConfigFormat = gateway?.configFormat ?? 'json';
  const filename = gateway?.configPath.split('/').at(-1) ?? 'mcp.json';
  const doc = model.doc;
  const dirty = doc?.dirty ?? false;
  const stale = Boolean(doc && gateway && doc.dirty && doc.revision !== gateway.revision);

  const parsed = doc ? formConfig(Redacted.value(doc.text), format) : null;
  // An unreadable stored key leaves the file valid: keep the form, whose Generate is the repair.
  const config =
    gateway?.configError && gateway.configError.code !== 'KeyUnavailable' && !doc?.dirty
      ? null
      : parsed;
  const existingNames = new Set(Object.keys(config?.mcpServers ?? {}));

  const rawOperationalError = gateway?.operationalError ?? null;
  const operationalError =
    rawOperationalError &&
    rawOperationalError.occurrenceId !== model.dismissedOpErrorId &&
    !model.error
      ? rawOperationalError
      : null;

  const updateState = snapshot?.update;
  const updateRestarting = updateState?.phase === 'restarting';
  const configurationLocked = Boolean(updateRestarting);

  const whatsNewPending = Boolean(
    snapshot?.whatsNew &&
      !model.whatsNewClosed &&
      changelogSection(changelogText, snapshot.whatsNew),
  );
  const updatesOpen = model.activeModal?.kind === 'updates';
  const competingDialog =
    model.activeModal?.kind === 'serverEditor' ||
    model.activeModal?.kind === 'keyMigration' ||
    (model.activeModal === null && whatsNewPending);
  const updatesTriggerDisabled =
    model.busy || configurationLocked || updateRestarting || competingDialog;

  return {
    gateway,
    format,
    filename,
    dirty,
    stale,
    config,
    existingNames,
    rawOperationalError,
    operationalError,
    updateState,
    updateRestarting,
    configurationLocked,
    whatsNewPending,
    updatesOpen,
    competingDialog,
    updatesTriggerDisabled,
  };
};

export const resolveUpdatesRequest = (
  model: AppModelValue,
  changelogText: string,
): AppModelValue => {
  const derived = computeDerivedState(model, changelogText);
  if (derived.updateRestarting) {
    const nextModal = model.activeModal?.kind === 'updates' ? null : model.activeModal;
    if (nextModal === model.activeModal && !model.updatesRequested) {
      return model;
    }
    return { ...model, activeModal: nextModal, updatesRequested: false };
  }
  if (!model.updatesRequested || !derived.updateState) {
    return model;
  }
  if (!derived.updateState.supported) {
    const nextModal = model.activeModal?.kind === 'updates' ? null : model.activeModal;
    return { ...model, activeModal: nextModal, updatesRequested: false };
  }
  if (derived.updatesOpen) {
    return { ...model, updatesRequested: false };
  }
  if (derived.updatesTriggerDisabled) {
    return model;
  }
  return {
    ...model,
    updatesRequested: false,
    activeModal: { kind: 'updates' },
  };
};

export type CommitPayloadResult =
  | {
      readonly ok: true;
      readonly text: Redacted.Redacted<string>;
      readonly expectedRevision: string;
    }
  | { readonly ok: false; readonly error: string }
  | null;

export const buildCommitPayload = (
  model: AppModelValue,
  nextConfig: ConfigFile,
  rename?: Rename,
): CommitPayloadResult => {
  if (!model.doc) return null;
  const gateway = model.snapshot?.gateway;
  const format: ConfigFormat = gateway?.configFormat ?? 'json';
  const baseText = gateway ? Redacted.value(gateway.configText) : Redacted.value(model.doc.text);
  try {
    const nextText = editConfigDocument(
      baseText,
      nextConfig,
      format,
      rename ? { path: ['mcpServers'], ...rename } : undefined,
    );
    return {
      ok: true,
      text: Redacted.make(nextText),
      expectedRevision: gateway?.revision ?? model.doc.revision,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export type ServerApplyPlan =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly nextConfig: ConfigFile; readonly rename?: Rename };

export const planServerApply = (
  editor: ServerEditorState,
  config: ConfigFile,
  t: Translate,
): ServerApplyPlan => {
  const trimmedName = editor.name.trim();
  // Saving would reject the name anyway; "__proto__" would also replace the draft's prototype
  // below instead of adding a server, silently dropping a renamed one.
  if (!SAFE_NAME.test(trimmedName)) {
    return { ok: false, error: t('app.serverFieldsInvalid') };
  }
  if (trimmedName !== editor.original && Object.hasOwn(config.mcpServers, trimmedName)) {
    return { ok: false, error: t('app.serverExists') };
  }
  const rawToken = editor.token !== null ? Redacted.value(editor.token) : undefined;
  // An empty custom field is a mistake, not a request to inherit the global key.
  if (rawToken === '') {
    return { ok: false, error: t('app.serverKeyEmpty') };
  }
  let args: string[] | undefined;
  let env: Record<string, string> | undefined;
  let headers: Record<string, string> | undefined;
  try {
    if (editor.type === 'stdio') {
      if (!Array.isArray(editor.args) || !editor.args.every((arg) => typeof arg === 'string')) {
        return { ok: false, error: t('app.argumentsInvalid') };
      }
      args = [...editor.args];
      env = keyValueRowsToRecord(editor.env, t('app.environmentInvalid'));
    } else {
      headers = keyValueRowsToRecord(editor.headers, t('app.headersInvalid'));
    }
  } catch (failure) {
    return {
      ok: false,
      error: failure instanceof Error ? failure.message : t('app.serverFieldsInvalid'),
    };
  }
  // Spread last: these keys follow the transport fields in the saved file.
  const shared = {
    disabled: editor.disabled,
    // Omitted when off, so older versions can still read the file.
    legacyProtocol: editor.legacyProtocol || undefined,
    // Undefined removes the property, which restores global inheritance.
    token: rawToken,
    tokenRef: editor.tokenRef ?? undefined,
  };
  const server =
    editor.type === 'stdio'
      ? { command: editor.command, args, env, cwd: editor.cwd || undefined, ...shared }
      : { url: editor.url, headers, ...shared };
  const servers = { ...config.mcpServers };
  if (editor.original) delete servers[editor.original];
  servers[trimmedName] = server;
  const rename =
    editor.original && editor.original !== trimmedName
      ? { from: editor.original, to: trimmedName }
      : undefined;
  return {
    ok: true,
    nextConfig: { ...config, mcpServers: servers },
    ...(rename ? { rename } : {}),
  };
};
