import { Activity } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { Banners } from '@mcp-gateway/mainview/components/banners/Banners';
import { DraftBar } from '@mcp-gateway/mainview/components/DraftBar';
import { GatewayStrip } from '@mcp-gateway/mainview/components/GatewayStrip';
import { Shell } from '@mcp-gateway/mainview/components/Shell';
import { ConfirmDialogs } from '@mcp-gateway/mainview/dialogs/ConfirmDialogs';
import {
  type Document,
  type Editor,
  emptyEditor,
  formConfig,
  ServerEditor,
} from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useOperations } from '@mcp-gateway/mainview/hooks/useOperations';
import { useQuit } from '@mcp-gateway/mainview/hooks/useQuit';
import { Logs } from '@mcp-gateway/mainview/Logs';
import { Overview } from '@mcp-gateway/mainview/views/Overview';
import { RawConfig } from '@mcp-gateway/mainview/views/RawConfig';
import { Settings } from '@mcp-gateway/mainview/views/Settings';
import { Updates } from '@mcp-gateway/mainview/views/Updates';
import { editConfigDocument } from '@mcp-gateway/shared/config-document';
import type { AppClient, AppSnapshot } from '@mcp-gateway/shared/rpc';
import { needsLoginRetry } from '@mcp-gateway/shared/rpc';
import type { GatewayConfig } from '@mcp-gateway/shared/types';

export const App = ({ client }: { client: AppClient }) => {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorOccurrence, setErrorOccurrence] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const fallbackFocus = useRef<HTMLButtonElement>(null);
  const updatesHeading = useRef<HTMLHeadingElement>(null);
  const [tab, setTab] = useState<'overview' | 'settings' | 'logs'>('overview');
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const dismiss = (id: string) => setDismissed((previous) => new Set([...previous, id]));
  const errorOccurrenceRef = useRef(errorOccurrence);
  errorOccurrenceRef.current = errorOccurrence;
  const pollFailed = useRef(false);
  const docRef = useRef(doc);
  docRef.current = doc;
  const editingRef = useRef(false);
  editingRef.current = editor !== null || deleting !== null;
  const generation = useRef(0);
  const updateState = snapshot?.update;
  const updateRestarting = updateState?.phase === 'restarting';
  const dirty = doc?.dirty ?? false;

  const {
    quitStatus,
    quitStatusKnown,
    requestingQuit,
    quitReadError,
    quitting,
    shutdownStarted,
    configurationLocked,
    requestQuit,
    requestUpdateRestart,
    interactiveQuit,
    quitRequestPending,
    quitGeneration,
  } = useQuit({
    client,
    snapshot,
    updateRestarting,
    generation,
    confirmQuit,
    setConfirmQuit,
    setConfirmUpdate,
    setError,
    setNotice,
    busy,
    dirty,
    editor,
    deleting,
  });

  const { run, runUpdate } = useOperations({
    quitGeneration,
    generation,
    setBusy,
    updateBusy,
    setUpdateBusy,
    setError,
    setErrorOccurrence,
    setNotice,
    setSnapshot,
    setDoc,
  });

  useEffect(() => {
    // Only a new authoritative snapshot can retire an acknowledgement. A local
    // action may clear its banner before polling has observed the same core issue.
    const active = new Set([
      `config-${snapshot?.gateway.configError?.occurrenceId}`,
      `operation-${snapshot?.gateway.operationalError?.occurrenceId}`,
      `login-${snapshot?.login.occurrenceId}`,
      `stale-${snapshot?.gateway.revision}`,
      `operation-${errorOccurrenceRef.current}`,
      `config-${errorOccurrenceRef.current}`,
      `quit-${quitStatus.attempt}`,
      `update-${snapshot?.update.phase}-${snapshot?.update.availableVersion ?? ''}-${snapshot?.update.error ?? ''}`,
    ]);
    setDismissed((previous) => {
      const retained = Array.from(previous).filter((id) => active.has(id));
      return retained.length === previous.size ? previous : new Set(retained);
    });
  }, [snapshot, quitStatus.attempt]);

  const dismissLocalError = () => {
    setError(null);
    if (errorOccurrence) {
      dismiss(`operation-${errorOccurrence}`);
      dismiss(`config-${errorOccurrence}`);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const current = generation.current;
      try {
        const result = await client.snapshot();
        if (cancelled || current !== generation.current || quitRequestPending.current) return;
        if (!result.ok) {
          if (!pollFailed.current) {
            setErrorOccurrence(result.error.occurrenceId ?? null);
            setError(`${result.error.code}: ${result.error.message}`);
          }
          pollFailed.current = true;
          return;
        }
        pollFailed.current = false;
        setSnapshot(result.value);
        if (!docRef.current?.dirty && !editingRef.current) {
          const gateway = result.value.gateway;
          setDoc({ text: gateway.configText, revision: gateway.revision, dirty: false });
        }
      } catch {
        if (!cancelled && !pollFailed.current) {
          setErrorOccurrence(null);
          setError('Could not read application status. The native connection may be unavailable.');
        }
        pollFailed.current = true;
      } finally {
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, quitRequestPending]);

  useEffect(() => {
    const showUpdates = () => {
      setTab('settings');
      requestAnimationFrame(() => updatesHeading.current?.focus());
    };
    window.addEventListener('mcp-gateway:show-updates', showUpdates);
    return () => window.removeEventListener('mcp-gateway:show-updates', showUpdates);
  }, []);

  const format = snapshot?.gateway.configFormat ?? 'json';
  const filename = snapshot?.gateway.configPath.split('/').at(-1) ?? 'mcp.json';
  const update = (config: GatewayConfig, rename?: { from: string; to: string }) => {
    if (configurationLocked) return;
    setDoc((previous) => {
      if (!previous) return previous;
      const text = editConfigDocument(
        previous.text,
        config,
        format,
        rename ? { path: ['mcpServers'], ...rename } : undefined,
      );
      return { ...previous, text, dirty: previous.dirty || text !== previous.text };
    });
    setNotice('');
  };
  const parsed = doc ? formConfig(doc.text, format) : null;
  const config = snapshot?.gateway.configError && !doc?.dirty ? null : parsed;
  const gateway = snapshot?.gateway;
  const updateReady = updateState?.phase === 'ready';
  const stale = !!doc && !!gateway && doc.revision !== gateway.revision;
  const retryLogin = !!(
    config &&
    snapshot &&
    !gateway?.configError &&
    !stale &&
    needsLoginRetry(snapshot.login, config.gateway.launchAtLogin ?? false)
  );
  // The retry action lives in the Settings draft bar, so only Settings offers it.
  const showLoginRetry = retryLogin && tab === 'settings';
  const save = async (text = doc?.text) => {
    if (configurationLocked || !doc || text === undefined) return false;
    return run(
      () => client.saveConfig({ text, expectedRevision: doc.revision }),
      'Configuration saved.',
      true,
    );
  };
  const changeEditor = (patch: Partial<Editor>) => {
    if (configurationLocked) return;
    setEditor((previous) => (previous ? { ...previous, ...patch } : null));
  };
  const openEditor = (name?: string) => {
    if (configurationLocked) return;
    const next = emptyEditor();
    if (name && config) {
      const server = config.mcpServers[name];
      if (!server) return;
      next.original = name;
      next.name = name;
      next.disabled = server.disabled ?? false;
      next.legacyProtocol = server.legacyProtocol ?? false;
      if ('url' in server) {
        next.type = 'http';
        next.url = server.url;
        next.headers = JSON.stringify(server.headers ?? {}, null, 2);
      } else {
        next.command = server.command;
        next.args = JSON.stringify(server.args ?? [], null, 2);
        next.env = JSON.stringify(server.env ?? {}, null, 2);
        next.cwd = server.cwd ?? '';
      }
    }
    setEditorError(null);
    setEditor(next);
  };
  const applyServer = (event: FormEvent) => {
    event.preventDefault();
    if (!editor || !config || configurationLocked) return;
    if (editor.name !== editor.original && Object.hasOwn(config.mcpServers, editor.name)) {
      setEditorError('A server with this name already exists.');
      return;
    }
    let args: string[] | undefined;
    let env: Record<string, string> | undefined;
    let headers: Record<string, string> | undefined;
    try {
      if (editor.type === 'stdio') {
        const parsedArgs = JSON.parse(editor.args || '[]');
        if (!Array.isArray(parsedArgs) || !parsedArgs.every((arg) => typeof arg === 'string'))
          throw new Error('Arguments must be a JSON array of strings.');
        args = parsedArgs;
        const parsedEnv = JSON.parse(editor.env || '{}');
        if (
          parsedEnv === null ||
          typeof parsedEnv !== 'object' ||
          Array.isArray(parsedEnv) ||
          !Object.values(parsedEnv).every((value) => typeof value === 'string')
        )
          throw new Error('Environment must be a JSON object with string values.');
        env = parsedEnv as Record<string, string>;
      } else {
        const parsedHeaders = JSON.parse(editor.headers || '{}');
        if (
          parsedHeaders === null ||
          typeof parsedHeaders !== 'object' ||
          Array.isArray(parsedHeaders) ||
          !Object.values(parsedHeaders).every((value) => typeof value === 'string')
        )
          throw new Error('Headers must be a JSON object with string values.');
        headers = parsedHeaders as Record<string, string>;
      }
    } catch (failure) {
      setEditorError(failure instanceof Error ? failure.message : 'The server fields are invalid.');
      return;
    }
    const server =
      editor.type === 'stdio'
        ? {
            command: editor.command,
            args,
            env,
            cwd: editor.cwd || undefined,
            disabled: editor.disabled,
            // Omitted when off, so older versions can still read the file.
            legacyProtocol: editor.legacyProtocol || undefined,
          }
        : {
            url: editor.url,
            headers,
            disabled: editor.disabled,
            legacyProtocol: editor.legacyProtocol || undefined,
          };
    const servers = { ...config.mcpServers };
    if (editor.original) delete servers[editor.original];
    servers[editor.name] = server;
    update(
      { ...config, mcpServers: servers },
      editor.original && editor.original !== editor.name
        ? { from: editor.original, to: editor.name }
        : undefined,
    );
    setEditor(null);
  };
  const toggleEndpoint = async (name: string, disabled: boolean) => {
    if (configurationLocked || !config || !doc || dirty) return;
    const server = config.mcpServers[name];
    if (!server) return;
    const text = editConfigDocument(
      doc.text,
      { ...config, mcpServers: { ...config.mcpServers, [name]: { ...server, disabled } } },
      format,
    );
    // Save this text: `doc` in this closure still holds the text from before the change.
    setDoc({ ...doc, text, dirty: true });
    await save(text);
  };

  return (
    <Shell
      tab={tab}
      setTab={setTab}
      snapshot={snapshot}
      busy={busy}
      quitting={quitting}
      editor={editor}
      deleting={deleting}
      quitStatus={quitStatus}
      interactiveQuit={interactiveQuit}
      dialogs={
        <>
          <ConfirmDialogs
            confirmQuit={confirmQuit}
            setConfirmQuit={setConfirmQuit}
            quitting={quitting}
            requestQuit={requestQuit}
            confirmUpdate={confirmUpdate}
            updateReady={updateReady}
            updateState={updateState}
            dirty={dirty}
            updateRestarting={updateRestarting}
            requestUpdateRestart={requestUpdateRestart}
            setConfirmUpdate={setConfirmUpdate}
            deleting={deleting}
            setDeleting={setDeleting}
            configurationLocked={configurationLocked}
            parsed={parsed}
            update={update}
            fallbackFocus={fallbackFocus}
          />
          {editor && (
            <ServerEditor
              editor={editor}
              editorError={editorError}
              configurationLocked={configurationLocked}
              fallbackFocus={fallbackFocus}
              onChange={changeEditor}
              onClose={() => setEditor(null)}
              onSubmit={applyServer}
              onDismissError={() => setEditorError(null)}
            />
          )}
        </>
      }
    >
      <Banners
        error={error}
        dismissLocalError={dismissLocalError}
        updateState={updateState}
        tab={tab}
        dismissed={dismissed}
        dismiss={dismiss}
        quitting={quitting}
        quitStatus={quitStatus}
        shutdownStarted={shutdownStarted}
        updateRestarting={updateRestarting}
        quitStatusKnown={quitStatusKnown}
        requestingQuit={requestingQuit}
        quitReadError={quitReadError}
        notice={notice}
        setNotice={setNotice}
        gateway={gateway}
        errorOccurrence={errorOccurrence}
        config={config}
        configurationLocked={configurationLocked}
        snapshot={snapshot ?? undefined}
        loginWanted={parsed?.gateway.launchAtLogin ?? false}
        loginInDraftBar={retryLogin && !dirty}
        stale={stale}
      />
      {(!snapshot || !doc) && tab === 'logs' ? (
        <Logs client={client} servers={[]} />
      ) : !snapshot || !doc ? (
        <section className="panel loading" aria-busy="true">
          <Activity size={22} />
          <h2>Connecting to the application</h2>
          <p>Waiting for the native application…</p>
        </section>
      ) : (
        <>
          <fieldset disabled={busy} className="workspace">
            <DraftBar
              dirty={dirty}
              retryLogin={showLoginRetry}
              configurationLocked={configurationLocked}
              snapshot={snapshot}
              setDoc={setDoc}
              setError={setError}
              save={save}
            />
            {tab === 'logs' ? (
              <Logs client={client} servers={gateway?.servers.map((server) => server.name) ?? []} />
            ) : tab === 'overview' ? (
              <>
                <GatewayStrip
                  gateway={gateway}
                  dirty={dirty}
                  configurationLocked={configurationLocked}
                  run={run}
                  client={client}
                />
                <Overview
                  gateway={gateway}
                  config={config}
                  dirty={dirty}
                  configurationLocked={configurationLocked}
                  run={run}
                  client={client}
                  openEditor={openEditor}
                  toggleEndpoint={toggleEndpoint}
                  setDeleting={setDeleting}
                  setEditor={setEditor}
                  setEditorError={setEditorError}
                />
              </>
            ) : (
              <Settings
                config={config}
                gateway={gateway}
                snapshot={snapshot}
                configurationLocked={configurationLocked}
                update={update}
                showToken={showToken}
                setShowToken={setShowToken}
                filename={filename}
              />
            )}
            {tab === 'settings' && updateState && (
              <Updates
                updateState={updateState}
                updateBusy={updateBusy}
                configurationLocked={configurationLocked}
                busy={busy}
                quitStatusKnown={quitStatusKnown}
                quitStatus={quitStatus}
                editor={editor}
                deleting={deleting}
                runUpdate={runUpdate}
                client={client}
                setConfirmUpdate={setConfirmUpdate}
                updatesHeading={updatesHeading}
              />
            )}
            {tab !== 'logs' && (
              <RawConfig
                doc={doc}
                setDoc={setDoc}
                configurationLocked={configurationLocked}
                format={format}
                filename={filename}
                gateway={gateway}
                dirty={dirty}
                retryLogin={showLoginRetry}
                save={save}
                rawOpen={rawOpen}
                setRawOpen={setRawOpen}
                fallbackFocus={fallbackFocus}
                setNotice={setNotice}
              />
            )}
          </fieldset>
          <footer className="page-footer">
            <span>
              <span className={`dot ${gateway?.running ? 'online' : ''}`} />
              {gateway?.running ? 'Listener active' : 'No active listener'}
            </span>
            <span>Closing this window keeps the app running. Use Quit to stop it.</span>
          </footer>
        </>
      )}
    </Shell>
  );
};
