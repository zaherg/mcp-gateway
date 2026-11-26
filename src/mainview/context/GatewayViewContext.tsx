import {
  createContext,
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  onMenuCommand,
  onSnapshotChanged,
  setUnsavedRawConfigChecker,
} from '@mcp-gateway/mainview/client';
import type { Tab } from '@mcp-gateway/mainview/components/Shell';
import {
  type Document,
  type Editor,
  emptyEditor,
  formConfig,
  keyValueRowsToRecord,
  recordToKeyValueRows,
} from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useOperations } from '@mcp-gateway/mainview/hooks/useOperations';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import { changelogSection } from '@mcp-gateway/shared/changelog';
import {
  type ConfigFormat,
  editConfigDocument,
  SAFE_NAME,
} from '@mcp-gateway/shared/config-document';
import type { LanguagePreference } from '@mcp-gateway/shared/i18n';
import type {
  AppClient,
  AppResult,
  AppSnapshot,
  MenuCommand,
  QuitStatus,
  UpdateStatus,
} from '@mcp-gateway/shared/rpc';
import type {
  ConfigFile,
  GatewaySnapshot,
  KeyMigration as KeyMigrationSlots,
} from '@mcp-gateway/shared/types';
import changelog from '../../../CHANGELOG.md?raw';

export type ActiveModal =
  | { kind: 'serverEditor'; editor: Editor }
  | { kind: 'keyMigration' }
  | { kind: 'updates' }
  | null;

export interface Rename {
  from: string;
  to: string;
}

const IDLE_QUIT_STATUS: QuitStatus = {
  attempt: 0,
  phase: 'idle',
  error: null,
};

export interface GatewayViewContextValue {
  client: AppClient;
  snapshot: AppSnapshot | null;
  gateway: GatewaySnapshot | undefined;
  config: ConfigFile | null;
  doc: Document | null;
  dirty: boolean;
  stale: boolean;
  format: ConfigFormat;
  filename: string;
  tab: Tab;
  activeModal: ActiveModal;
  editor: Editor | null;
  editorError: string | null;
  existingNames: ReadonlySet<string>;
  rawOpen: boolean;
  showToken: boolean;
  busy: boolean;
  updateBusy: boolean;
  error: string | null;
  configurationLocked: boolean;
  quitting: boolean;
  quitStatus: QuitStatus;
  quitStatusKnown: boolean;
  updateState: UpdateStatus | undefined;
  updateRestarting: boolean;
  whatsNewPending: boolean;
  updatesTriggerDisabled: boolean;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
  updatesTrigger: RefObject<HTMLButtonElement | null>;
  setTab: (tab: Tab) => void;
  setRawOpen: (open: boolean) => void;
  setShowToken: (show: boolean) => void;
  setDoc: (doc: Document) => void;
  setEditor: (editor: Editor | null) => void;
  setEditorError: (error: string | null) => void;
  changeEditor: (patch: Partial<Editor>) => void;
  clearError: () => void;
  commitConfig: (nextConfig: ConfigFile, rename?: Rename) => Promise<boolean>;
  saveRawConfig: (text?: string, expectedRevision?: string) => Promise<boolean>;
  discardRawConfig: () => Promise<void>;
  reloadFromDisk: () => void;
  openServerEditor: (name?: string) => void;
  applyServer: (event: FormEvent) => Promise<void>;
  closeModal: () => void;
  openKeyMigration: () => void;
  openUpdatesModal: () => void;
  requestUpdateRestart: () => Promise<void>;
  closeWhatsNew: () => void;
  toggleServer: (name: string, disabled: boolean) => Promise<void>;
  deleteServer: (name: string) => Promise<void>;
  changeLanguage: (preference: LanguagePreference) => void;
  revealConfig: () => void;
  openConfigInEditor: () => void;
  importExternalServers: () => Promise<number | null>;
  dismissKeyReminder: () => void;
  migrateKeys: (slots: KeyMigrationSlots) => Promise<boolean>;
  run: (
    operation: () => Promise<AppResult<AppSnapshot | null>>,
    message?: string,
    saved?: boolean,
    draft?: boolean,
    submittedText?: string,
  ) => Promise<boolean>;
  runUpdate: (
    operation: () => Promise<AppResult<UpdateStatus>>,
    message?: string,
  ) => Promise<boolean>;
}

const GatewayViewContext = createContext<GatewayViewContextValue | null>(null);

interface GatewayViewProviderProps {
  client: AppClient;
  children: ReactNode;
}

export const GatewayViewProvider = ({ client, children }: GatewayViewProviderProps) => {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [doc, setDocState] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [whatsNewClosed, setWhatsNewClosed] = useState(false);
  const [updatesRequested, setUpdatesRequested] = useState(false);
  const fallbackFocus = useRef<HTMLButtonElement>(null);
  const updatesTrigger = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const docRef = useRef(doc);
  docRef.current = doc;
  const editor = activeModal?.kind === 'serverEditor' ? activeModal.editor : null;
  const setEditor = useCallback((nextEditor: Editor | null) => {
    setActiveModal((previous) => {
      if (nextEditor !== null) return { kind: 'serverEditor', editor: nextEditor };
      return previous?.kind === 'serverEditor' ? null : previous;
    });
  }, []);
  const editingRef = useRef(false);
  editingRef.current = editor !== null;
  const generation = useRef(0);
  const quitGeneration = useRef(0);
  const editSequence = useRef(0);
  const { t, setLocale } = useI18n();
  const snapshotLocale = snapshot?.language.locale;
  useEffect(() => {
    if (snapshotLocale) setLocale(snapshotLocale);
  }, [snapshotLocale, setLocale]);
  useEffect(() => {
    setUnsavedRawConfigChecker(() => Boolean(docRef.current?.dirty));
    return () => setUnsavedRawConfigChecker(() => false);
  }, []);
  const updateState = snapshot?.update;
  const updateRestarting = updateState?.phase === 'restarting';
  const dirty = doc?.dirty ?? false;

  const quitStatus = IDLE_QUIT_STATUS;
  const quitStatusKnown = true;
  const quitting = false;
  const configurationLocked = Boolean(updateRestarting);

  const { run, runUpdate } = useOperations({
    quitGeneration,
    generation,
    editSequence,
    docRef,
    setBusy,
    updateBusy,
    setUpdateBusy,
    setError,
    setSnapshot,
    setDoc: setDocState,
  });

  const applyIncomingSnapshot = useCallback(
    (nextSnapshot: AppSnapshot, startedEditSeq = editSequence.current) => {
      setSnapshot(nextSnapshot);
      if (
        !docRef.current?.dirty &&
        !editingRef.current &&
        startedEditSeq === editSequence.current
      ) {
        const nextGateway = nextSnapshot.gateway;
        const cleanDoc = {
          text: nextGateway.configText,
          revision: nextGateway.revision,
          dirty: false,
        };
        docRef.current = cleanDoc;
        setDocState(cleanDoc);
      }
    },
    [],
  );

  const confirmDiscard = useCallback(async (): Promise<boolean> => {
    try {
      const result = await client.confirmDiscard();
      if (result.ok) return result.value;
      setError(`${result.error.code}: ${result.error.message}`);
    } catch {
      setError(t('app.confirmUnavailable'));
    }
    return false;
  }, [client, t]);

  const requestUpdateRestart = async () => {
    if (updateRestarting || snapshot?.update.phase !== 'ready') return;
    if (docRef.current?.dirty && !(await confirmDiscard())) return;
    setActiveModal((previous) => (previous?.kind === 'updates' ? null : previous));
    await run(async () => {
      const result = await client.updatesRestart();
      return result.ok ? { ok: true, value: null } : result;
    }, t('quit.restartRequested'));
  };

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => {
    let cancelled = false;
    const current = generation.current;
    const startedEditSeq = editSequence.current;

    void (async () => {
      try {
        const result = await client.snapshot();
        if (cancelled || current !== generation.current) return;
        if (!result.ok) {
          setError(`${result.error.code}: ${result.error.message}`);
          return;
        }
        applyIncomingSnapshot(result.value, startedEditSeq);
      } catch {
        if (!cancelled) setError(t('app.statusUnavailable'));
      }
    })();

    const subscribeSnapshot = client.onSnapshotChanged ?? onSnapshotChanged;
    const unsubscribeSnapshot = subscribeSnapshot((nextSnapshot) => {
      if (cancelled) return;
      applyIncomingSnapshot(nextSnapshot);
    });

    return () => {
      cancelled = true;
      unsubscribeSnapshot();
    };
  }, [applyIncomingSnapshot, client, t]);

  const whatsNewPending = Boolean(
    snapshot?.whatsNew && !whatsNewClosed && changelogSection(changelog, snapshot.whatsNew),
  );
  const updatesOpen = activeModal?.kind === 'updates';
  const competingDialog =
    activeModal?.kind === 'serverEditor' ||
    activeModal?.kind === 'keyMigration' ||
    (activeModal === null && whatsNewPending);
  const updatesTriggerDisabled =
    busy || configurationLocked || quitting || updateRestarting || competingDialog;

  useEffect(() => {
    if (!updateRestarting) return;
    setActiveModal((previous) => (previous?.kind === 'updates' ? null : previous));
    setUpdatesRequested(false);
  }, [updateRestarting]);

  useEffect(() => {
    if (!updatesRequested || !updateState) return;
    if (!updateState.supported) {
      setActiveModal((previous) => (previous?.kind === 'updates' ? null : previous));
      setUpdatesRequested(false);
      return;
    }
    if (updatesOpen) {
      setUpdatesRequested(false);
      return;
    }
    if (updatesTriggerDisabled) return;
    setUpdatesRequested(false);
    updatesTrigger.current?.focus();
    setActiveModal({ kind: 'updates' });
  }, [updatesOpen, updatesRequested, updatesTriggerDisabled, updateState]);

  const format: ConfigFormat = snapshot?.gateway.configFormat ?? 'json';
  const filename = snapshot?.gateway.configPath.split('/').at(-1) ?? 'mcp.json';
  const gateway = snapshot?.gateway;
  const stale = !!doc && !!gateway && doc.dirty && doc.revision !== gateway.revision;

  const saveRawConfig = async (
    text = docRef.current?.text,
    expectedRevision = docRef.current?.revision,
  ) => {
    if (configurationLocked || text === undefined || expectedRevision === undefined) return false;
    return run(
      () => client.saveConfig({ text, expectedRevision }),
      t('app.configSaved'),
      true,
      true,
      text,
    );
  };

  const commitConfig = async (nextConfig: ConfigFile, rename?: Rename): Promise<boolean> => {
    const currentDoc = docRef.current;
    if (configurationLocked || !currentDoc) return false;
    const nextText = editConfigDocument(
      gateway?.configText ?? currentDoc.text,
      nextConfig,
      format,
      rename ? { path: ['mcpServers'], ...rename } : undefined,
    );
    return saveRawConfig(nextText, gateway?.revision ?? currentDoc.revision);
  };

  const setDoc = useCallback((nextDoc: Document) => {
    editSequence.current += 1;
    docRef.current = nextDoc;
    setDocState(nextDoc);
  }, []);

  const reloadFromDisk = useCallback(() => {
    if (configurationLocked || !gateway) return;
    editSequence.current += 1;
    const cleanDoc = { text: gateway.configText, revision: gateway.revision, dirty: false };
    docRef.current = cleanDoc;
    setDocState(cleanDoc);
    setError(null);
  }, [configurationLocked, gateway]);

  const parsed = doc ? formConfig(doc.text, format) : null;
  // An unreadable stored key leaves the file valid: keep the form, whose Generate is the repair.
  const config =
    snapshot?.gateway.configError &&
    snapshot.gateway.configError.code !== 'KeyUnavailable' &&
    !doc?.dirty
      ? null
      : parsed;
  const existingNames = new Set(Object.keys(config?.mcpServers ?? {}));

  const discardRawConfig = async () => {
    if (configurationLocked || !gateway || !(await confirmDiscard())) return;
    reloadFromDisk();
  };

  const deleteServer = async (name: string) => {
    if (configurationLocked || !config) return;
    const confirmed = await client.confirmDeleteServer({ name });
    if (!confirmed.ok || !confirmed.value) return;
    const servers = { ...config.mcpServers };
    delete servers[name];
    await commitConfig({ ...config, mcpServers: servers });
  };

  const revealConfig = () => {
    if (busy || configurationLocked) return;
    void run(() => client.revealConfig(), '');
  };

  const openConfigInEditor = () => {
    if (busy || configurationLocked) return;
    void run(() => client.openConfigInEditor(), '');
  };

  const importExternalServers = async (): Promise<number | null> => {
    const currentDoc = docRef.current;
    if (busy || configurationLocked || !currentDoc || currentDoc.dirty) return null;
    let count: number | null = null;
    const ok = await run(
      async () => {
        const result = await client.importExternalServers({
          expectedRevision: gateway?.revision ?? currentDoc.revision,
        });
        if (!result.ok) return result;
        count = result.value.importedCount;
        return { ok: true, value: result.value.snapshot };
      },
      '',
      true,
      false,
      currentDoc.text,
    );
    return ok ? count : null;
  };

  const dismissKeyReminder = () => {
    if (busy || configurationLocked) return;
    void run(() => client.dismissKeyReminder(), '');
  };

  // Saved mode reloads the form and raw editor from the new revision, so no draft keeps the plaintext.
  const migrateKeys = async (slots: KeyMigrationSlots): Promise<boolean> => {
    if (busy || configurationLocked || !doc || dirty) return false;
    return run(
      () =>
        client.migrateKeys({
          gateway: slots.gateway,
          servers: slots.servers,
          expectedRevision: doc.revision,
        }),
      t('keys.moved'),
      true,
      false,
      doc.text,
    );
  };

  const changeLanguage = (preference: LanguagePreference) => {
    if (busy || configurationLocked) return;
    void run(() => client.setLanguage({ preference }), '');
  };

  const changeEditor = (patch: Partial<Editor>) => {
    if (configurationLocked) return;
    setActiveModal((previous) =>
      previous?.kind === 'serverEditor'
        ? { kind: 'serverEditor', editor: { ...previous.editor, ...patch } }
        : previous,
    );
  };

  const openServerEditor = useCallback(
    (name?: string) => {
      if (configurationLocked) return;
      const next = emptyEditor();
      if (name && config) {
        const server = config.mcpServers[name];
        if (!server) return;
        next.original = name;
        next.name = name;
        next.disabled = server.disabled ?? false;
        next.legacyProtocol = server.legacyProtocol ?? false;
        // Keep the raw reference text; only main expands it on save.
        next.token = server.token;
        next.tokenRef = server.tokenRef;
        if ('url' in server) {
          next.type = 'http';
          next.url = server.url;
          next.headers = recordToKeyValueRows(server.headers);
        } else {
          next.command = server.command;
          next.args = [...(server.args ?? [])];
          next.env = recordToKeyValueRows(server.env);
          next.cwd = server.cwd ?? '';
        }
      }
      setEditorError(null);
      setActiveModal({ kind: 'serverEditor', editor: next });
    },
    [config, configurationLocked],
  );

  const handleMenuCommand = useRef<(command: MenuCommand) => void>(() => {});
  handleMenuCommand.current = (command: MenuCommand) => {
    switch (command) {
      case 'tab:overview':
        setTab('overview');
        break;
      case 'tab:logs':
        setTab('logs');
        break;
      case 'tab:settings':
        setTab('settings');
        break;
      case 'tab:raw-config':
        setTab('settings');
        setRawOpen(true);
        break;
      case 'server:add':
        if (config && !configurationLocked) {
          setTab('overview');
          openServerEditor();
        }
        break;
      case 'updates:open':
        setUpdatesRequested(true);
        break;
      case 'gateway:reload':
        void (async () => {
          if (docRef.current?.dirty && !(await confirmDiscard())) return;
          const result = await client.snapshot();
          if (result.ok) {
            setSnapshot(result.value);
            editSequence.current += 1;
            const cleanDoc = {
              text: result.value.gateway.configText,
              revision: result.value.gateway.revision,
              dirty: false,
            };
            docRef.current = cleanDoc;
            setDocState(cleanDoc);
            setError(null);
          }
        })();
        break;
    }
  };

  useEffect(() => {
    const subscribeMenu = client.onMenuCommand ?? onMenuCommand;
    return subscribeMenu((command) => handleMenuCommand.current(command));
  }, [client]);

  const applyServer = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor || !config || configurationLocked) return;
    const trimmedName = editor.name.trim();
    // Saving would reject the name anyway; "__proto__" would also replace the draft's prototype
    // below instead of adding a server, silently dropping a renamed one.
    if (!SAFE_NAME.test(trimmedName)) {
      setEditorError(t('app.serverFieldsInvalid'));
      return;
    }
    if (trimmedName !== editor.original && Object.hasOwn(config.mcpServers, trimmedName)) {
      setEditorError(t('app.serverExists'));
      return;
    }
    // An empty custom field is a mistake, not a request to inherit the global key.
    if (editor.token === '') {
      setEditorError(t('app.serverKeyEmpty'));
      return;
    }
    let args: string[] | undefined;
    let env: Record<string, string> | undefined;
    let headers: Record<string, string> | undefined;
    try {
      if (editor.type === 'stdio') {
        if (!Array.isArray(editor.args) || !editor.args.every((arg) => typeof arg === 'string'))
          throw new Error(t('app.argumentsInvalid'));
        args = editor.args;
        env = keyValueRowsToRecord(editor.env, t('app.environmentInvalid'));
      } else {
        headers = keyValueRowsToRecord(editor.headers, t('app.headersInvalid'));
      }
    } catch (failure) {
      setEditorError(failure instanceof Error ? failure.message : t('app.serverFieldsInvalid'));
      return;
    }
    // Spread last: these keys follow the transport fields in the saved file.
    const shared = {
      disabled: editor.disabled,
      // Omitted when off, so older versions can still read the file.
      legacyProtocol: editor.legacyProtocol || undefined,
      // Undefined removes the property, which restores global inheritance.
      token: editor.token,
      tokenRef: editor.tokenRef,
    };
    const server =
      editor.type === 'stdio'
        ? { command: editor.command, args, env, cwd: editor.cwd || undefined, ...shared }
        : { url: editor.url, headers, ...shared };
    const servers = { ...config.mcpServers };
    if (editor.original) delete servers[editor.original];
    servers[trimmedName] = server;
    const ok = await commitConfig(
      { ...config, mcpServers: servers },
      editor.original && editor.original !== trimmedName
        ? { from: editor.original, to: trimmedName }
        : undefined,
    );
    if (ok) setEditor(null);
  };

  const toggleServer = async (name: string, disabled: boolean) => {
    if (configurationLocked || !config || !doc || dirty) return;
    const server = config.mcpServers[name];
    if (!server) return;
    await commitConfig({
      ...config,
      mcpServers: { ...config.mcpServers, [name]: { ...server, disabled } },
    });
  };

  const closeModal = useCallback(() => setActiveModal(null), []);
  const openKeyMigration = useCallback(() => setActiveModal({ kind: 'keyMigration' }), []);
  const openUpdatesModal = useCallback(() => setUpdatesRequested(true), []);
  const closeWhatsNew = useCallback(() => {
    // Close now; a failed save is logged by main and the notes return next launch.
    setWhatsNewClosed(true);
    void client.dismissWhatsNew().catch(() => undefined);
  }, [client]);

  const value: GatewayViewContextValue = {
    client,
    snapshot,
    gateway,
    config,
    doc,
    dirty,
    stale,
    format,
    filename,
    tab,
    activeModal,
    editor,
    editorError,
    existingNames,
    rawOpen,
    showToken,
    busy,
    updateBusy,
    error,
    configurationLocked,
    quitting,
    quitStatus,
    quitStatusKnown,
    updateState,
    updateRestarting,
    whatsNewPending,
    updatesTriggerDisabled,
    fallbackFocus,
    updatesTrigger,
    setTab,
    setRawOpen,
    setShowToken,
    setDoc,
    setEditor,
    setEditorError,
    changeEditor,
    clearError,
    commitConfig,
    saveRawConfig,
    discardRawConfig,
    reloadFromDisk,
    openServerEditor,
    applyServer,
    closeModal,
    openKeyMigration,
    openUpdatesModal,
    requestUpdateRestart,
    closeWhatsNew,
    toggleServer,
    deleteServer,
    changeLanguage,
    revealConfig,
    openConfigInEditor,
    importExternalServers,
    dismissKeyReminder,
    migrateKeys,
    run,
    runUpdate,
  };

  return <GatewayViewContext.Provider value={value}>{children}</GatewayViewContext.Provider>;
};

export const useGatewayView = (): GatewayViewContextValue => {
  const context = useContext(GatewayViewContext);
  if (!context) {
    throw new Error('useGatewayView must be used within a GatewayViewProvider');
  }
  return context;
};
