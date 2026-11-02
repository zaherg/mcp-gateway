import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  Eye,
  EyeOff,
  Globe,
  Network,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import {
  Children,
  cloneElement,
  type FormEvent,
  isValidElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  type ConfigFormat,
  editConfigDocument,
  parseConfigDocument,
} from "../shared/config-document";
import {
  type AppClient,
  type AppResult,
  type AppSnapshot,
  needsLoginRetry,
  type QuitStatus,
} from "../shared/rpc";
import type { GatewayConfig, HttpServerConfig, StdioServerConfig } from "../shared/types";
import { Alert } from "./Alert";
import { Logs } from "./Logs";

type Backend = StdioServerConfig | HttpServerConfig;
type Document = { text: string; revision: string; dirty: boolean };
type Editor = {
  original: string | null;
  name: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  disabled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}
function isBackend(value: unknown): value is Backend {
  if (!isRecord(value) || (value.disabled !== undefined && typeof value.disabled !== "boolean"))
    return false;
  if ("url" in value)
    return (
      typeof value.url === "string" && (value.headers === undefined || stringMap(value.headers))
    );
  return (
    typeof value.command === "string" &&
    (value.args === undefined ||
      (Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string"))) &&
    (value.env === undefined || stringMap(value.env)) &&
    (value.cwd === undefined || typeof value.cwd === "string")
  );
}
// This guard is for rendering only. Native validation remains authoritative on every save.
function formConfig(text: string, format: ConfigFormat): GatewayConfig | null {
  try {
    const value = parseConfigDocument(text, format);
    if (!isRecord(value) || !isRecord(value.gateway) || !isRecord(value.mcpServers)) return null;
    const gateway = value.gateway;
    if (
      typeof gateway.host !== "string" ||
      typeof gateway.port !== "number" ||
      typeof gateway.token !== "string" ||
      (gateway.autoStart !== undefined && typeof gateway.autoStart !== "boolean") ||
      (gateway.launchAtLogin !== undefined && typeof gateway.launchAtLogin !== "boolean") ||
      !Object.values(value.mcpServers).every(isBackend)
    )
      return null;
    // Preserve all fields from the source document, including unknown fields for native rejection.
    return {
      ...value,
      gateway: { ...gateway, host: gateway.host, port: gateway.port, token: gateway.token },
      mcpServers: Object.fromEntries(
        Object.entries(value.mcpServers).filter((entry): entry is [string, Backend] =>
          isBackend(entry[1]),
        ),
      ),
    };
  } catch {
    return null;
  }
}
const emptyEditor = (): Editor => ({
  original: null,
  name: "",
  type: "stdio",
  command: "",
  args: "[]",
  env: "{}",
  cwd: "",
  url: "",
  headers: "{}",
  disabled: false,
});

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  const id = useId();
  function associate(node: ReactNode): ReactNode {
    if (!isValidElement<{ id?: string; "aria-describedby"?: string; children?: ReactNode }>(node))
      return node;
    if (typeof node.type === "string" && ["input", "select", "textarea"].includes(node.type)) {
      return cloneElement(node, { id, "aria-describedby": help ? `${id}-help` : undefined });
    }
    return node.props.children
      ? cloneElement(node, { children: Children.map(node.props.children, associate) })
      : node;
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {Children.map(children, associate)}
      {help && <small id={`${id}-help`}>{help}</small>}
    </div>
  );
}
function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
function Modal({
  title,
  children,
  onClose,
  fallbackFocus,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  fallbackFocus: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener instanceof HTMLElement && opener.isConnected && !opener.matches(":disabled"))
        opener.focus();
      else fallbackFocus.current?.focus();
    };
  }, [fallbackFocus]);
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function App({ client }: { client: AppClient }) {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorOccurrence, setErrorOccurrence] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [quitStatus, setQuitStatus] = useState<QuitStatus>({
    attempt: 0,
    phase: "idle",
    error: null,
  });
  const [requestingQuit, setRequestingQuit] = useState(false);
  const [quitReadError, setQuitReadError] = useState(false);
  const quitAttempt = useRef(0);
  const quitGeneration = useRef(0);
  const quitRequestPending = useRef(false);
  const quitting = requestingQuit || quitStatus.phase === "pending" || quitStatus.phase === "ready";
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<"overview" | "settings" | "logs">("overview");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const dismiss = (id: string) => setDismissed((previous) => new Set([...previous, id]));
  const errorOccurrenceRef = useRef(errorOccurrence);
  errorOccurrenceRef.current = errorOccurrence;
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
    ]);
    setDismissed((previous) => {
      const retained = Array.from(previous).filter((id) => active.has(id));
      return retained.length === previous.size ? previous : new Set(retained);
    });
  }, [snapshot, quitStatus.attempt]);
  function dismissLocalError() {
    setError(null);
    if (errorOccurrence) {
      dismiss(`operation-${errorOccurrence}`);
      dismiss(`config-${errorOccurrence}`);
    }
  }
  const pollFailed = useRef(false);
  const docRef = useRef(doc);
  docRef.current = doc;
  const editingRef = useRef(false);
  editingRef.current = editor !== null || deleting !== null;
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const current = generation.current;
      try {
        const result = await client.snapshot();
        if (cancelled || current !== generation.current) return;
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
          setError("Could not read application status. The native connection may be unavailable.");
        }
        pollFailed.current = true;
      } finally {
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client]);

  const acceptQuitStatus = useCallback((status: QuitStatus) => {
    if (status.attempt < quitAttempt.current) return;
    quitAttempt.current = status.attempt;
    setQuitStatus(status);
    if (status.phase === "failed") setNotice("");
  }, []);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function pollQuit() {
      const current = quitGeneration.current;
      try {
        const result = await client.quitStatus();
        if (cancelled || current !== quitGeneration.current || quitRequestPending.current) return;
        setQuitReadError(!result.ok);
        if (result.ok) acceptQuitStatus(result.value);
      } catch {
        if (!cancelled) setQuitReadError(true);
      } finally {
        if (!cancelled) timer = setTimeout(pollQuit, 2000);
      }
    }
    void pollQuit();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, acceptQuitStatus]);

  const format = snapshot?.gateway.configFormat ?? "json";
  const filename = snapshot?.gateway.configPath.split("/").at(-1) ?? "mcp.json";
  function update(config: GatewayConfig, rename?: { from: string; to: string }) {
    setDoc((previous) => {
      if (!previous) return previous;
      const text = editConfigDocument(
        previous.text,
        config,
        format,
        rename ? { path: ["mcpServers"], ...rename } : undefined,
      );
      return { ...previous, text, dirty: previous.dirty || text !== previous.text };
    });
    setNotice("");
  }
  async function run(
    operation: () => Promise<AppResult<AppSnapshot | null>>,
    message: string,
    saved = false,
  ) {
    setBusy(true);
    setError(null);
    setErrorOccurrence(null);
    setNotice("");
    generation.current++;
    try {
      const result = await operation();
      if (!result.ok) {
        setErrorOccurrence(result.error.occurrenceId ?? null);
        setError(
          `${result.error.code}: ${result.error.message}${saved ? " Your draft is preserved. Review external changes before retrying." : ""}`,
        );
        return false;
      }
      if (result.value) {
        setSnapshot(result.value);
        if (saved)
          setDoc({
            text: result.value.gateway.configText,
            revision: result.value.gateway.revision,
            dirty: false,
          });
      }
      setNotice(message);
      return true;
    } catch {
      setError(
        "The native operation failed. Your draft is preserved. Check application status before retrying.",
      );
      return false;
    } finally {
      generation.current++;
      setBusy(false);
    }
  }
  async function requestQuit() {
    setConfirmQuit(false);
    setRequestingQuit(true);
    quitRequestPending.current = true;
    quitGeneration.current++;
    setError(null);
    setNotice("");
    try {
      const result = await client.quit();
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      acceptQuitStatus(result.value.status);
      if (result.value.status.phase !== "failed")
        setNotice("Quit requested. Waiting for gateway cleanup.");
    } catch {
      setError("Could not request Quit. Check application status before retrying.");
    } finally {
      quitRequestPending.current = false;
      setRequestingQuit(false);
    }
  }
  const parsed = doc ? formConfig(doc.text, format) : null;
  const config = snapshot?.gateway.configError && !doc?.dirty ? null : parsed;
  const gateway = snapshot?.gateway;
  const dirty = doc?.dirty ?? false;
  const stale = !!doc && !!gateway && doc.revision !== gateway.revision;
  const retryLogin = !!(
    config &&
    snapshot &&
    !gateway?.configError &&
    !stale &&
    needsLoginRetry(snapshot.login, config.gateway.launchAtLogin ?? false)
  );
  async function save(text = doc?.text) {
    if (!doc || text === undefined) return false;
    return run(
      () => client.saveConfig({ text, expectedRevision: doc.revision }),
      "Configuration saved.",
      true,
    );
  }
  function openEditor(name?: string) {
    const next = emptyEditor();
    if (name && config) {
      const server = config.mcpServers[name];
      if (!server) return;
      next.original = name;
      next.name = name;
      next.disabled = server.disabled ?? false;
      if ("url" in server) {
        next.type = "http";
        next.url = server.url;
        next.headers = JSON.stringify(server.headers ?? {}, null, 2);
      } else {
        next.command = server.command;
        next.args = JSON.stringify(server.args ?? [], null, 2);
        next.env = JSON.stringify(server.env ?? {}, null, 2);
        next.cwd = server.cwd ?? "";
      }
    }
    setEditorError(null);
    setEditor(next);
  }
  function applyServer(event: FormEvent) {
    event.preventDefault();
    if (!editor || !parsed) return;
    // Polling retains this document while the dialog is open, even if disk becomes invalid.
    const config = parsed;
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(editor.name))
        throw new Error(
          "Use 1 to 64 letters, numbers, hyphens or underscores; begin with a letter or number.",
        );
      if (editor.name !== editor.original && Object.hasOwn(config.mcpServers, editor.name))
        throw new Error("A server with this name already exists.");
      let server: Backend;
      if (editor.type === "stdio") {
        const args: unknown = JSON.parse(editor.args);
        const env: unknown = JSON.parse(editor.env);
        if (!Array.isArray(args) || !args.every((arg): arg is string => typeof arg === "string"))
          throw new Error("Arguments must be a JSON array of strings.");
        if (!stringMap(env))
          throw new Error("Environment must be a JSON object with string values.");
        if (!editor.command.trim())
          throw new Error("Enter a command executable, not a shell command string.");
        server = {
          command: editor.command,
          args,
          env,
          ...(editor.cwd ? { cwd: editor.cwd } : {}),
          disabled: editor.disabled,
        };
      } else {
        const headers: unknown = JSON.parse(editor.headers);
        if (!stringMap(headers))
          throw new Error("Headers must be a JSON object with string values.");
        if (!editor.url) throw new Error("Enter an upstream URL.");
        server = { url: editor.url, headers, disabled: editor.disabled };
      }
      // Opening and applying a form must not materialize omitted optional defaults.
      const original = editor.original ? config.mcpServers[editor.original] : undefined;
      if (original) {
        if (server.disabled === false && original.disabled === undefined) delete server.disabled;
        if ("url" in server && "url" in original) {
          if (!original.headers && Object.keys(server.headers ?? {}).length === 0)
            delete server.headers;
        } else if ("command" in server && "command" in original) {
          if (!original.args && server.args?.length === 0) delete server.args;
          if (!original.env && Object.keys(server.env ?? {}).length === 0) delete server.env;
        }
      }
      const servers = { ...config.mcpServers };
      if (editor.original) delete servers[editor.original];
      servers[editor.name] = server;
      update(
        { ...config, mcpServers: servers },
        editor.original ? { from: editor.original, to: editor.name } : undefined,
      );
      setEditor(null);
    } catch (cause) {
      setEditorError(
        cause instanceof SyntaxError
          ? "Invalid JSON. Check the arguments, environment or headers."
          : cause instanceof Error
            ? cause.message
            : "Invalid server settings.",
      );
    }
  }
  async function toggleEndpoint(name: string, disabled: boolean) {
    if (!config || !doc || dirty) return;
    const server = config.mcpServers[name];
    if (!server) return;
    const text = editConfigDocument(
      doc.text,
      {
        ...config,
        mcpServers: { ...config.mcpServers, [name]: { ...server, disabled } },
      },
      format,
    );
    // Keep the attempted change visible even if validation or revision checks reject it.
    setDoc({ ...doc, text, dirty: true });
    await save(text);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <Network size={22} />
          </span>
          <span>
            MCP Gateway<small>LOCAL CONNECTIONS</small>
          </span>
        </div>
        <nav aria-label="Main navigation">
          <button
            type="button"
            className={tab === "overview" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("overview")}
          >
            <Server size={17} /> Overview <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className={tab === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("settings")}
          >
            <Settings2 size={17} /> Settings <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className={tab === "logs" ? "nav-item active" : "nav-item"}
            onClick={() => setTab("logs")}
          >
            <Terminal size={17} /> Logs <ChevronRight size={14} />
          </button>
        </nav>
        <div className="sidebar-footer">
          <ShieldCheck size={18} />
          <span>
            LAN-only access<small>Authenticated, unencrypted HTTP.</small>
          </span>
        </div>
      </aside>
      <main>
        <header className="page-heading">
          <div>
            <p className="eyebrow">YOUR LOCAL MCP WORKSPACE</p>
            <h1>
              {tab === "overview"
                ? "MCP server connections"
                : tab === "logs"
                  ? "Local diagnostic logs"
                  : "Gateway settings"}
            </h1>
            <p className="subtitle">
              {tab === "overview"
                ? "Manage separate MCP endpoints for authorized clients on your LAN."
                : tab === "logs"
                  ? "Inspect backend output locally. Diagnostic values are not redacted."
                  : "Control the listener, startup behavior, and authoritative configuration."}
            </p>
          </div>
          <div>
            <span className="mac-badge">
              {snapshot ? (snapshot.platform === "linux" ? "Linux" : "macOS") : "Desktop"} · local
            </span>
            <button
              type="button"
              className="button"
              data-action="quit"
              disabled={
                busy ||
                quitting ||
                !!editor ||
                !!deleting ||
                (!snapshot && quitStatus.phase !== "failed")
              }
              onClick={() => (dirty ? setConfirmQuit(true) : void requestQuit())}
            >
              {quitting
                ? "Quitting…"
                : quitStatus.phase === "failed"
                  ? "Retry Quit"
                  : "Quit MCP Gateway"}
            </button>
          </div>
        </header>
        <div className="announcements" aria-live="polite">
          {error && <Alert onDismiss={dismissLocalError}>{error}</Alert>}
          {!quitting &&
            quitStatus.phase === "failed" &&
            !dismissed.has(`quit-${quitStatus.attempt}`) && (
              <Alert onDismiss={() => dismiss(`quit-${quitStatus.attempt}`)}>
                {quitStatus.error}
              </Alert>
            )}
          {quitReadError && (
            <p role="status">Could not read Quit status. Cleanup completion is unknown.</p>
          )}
          {notice && (
            <Alert kind="success" label="Dismiss notification" onDismiss={() => setNotice("")}>
              {notice}
            </Alert>
          )}
          {gateway?.configError &&
            (!error || errorOccurrence !== gateway.configError.occurrenceId) &&
            !dismissed.has(`config-${gateway.configError.occurrenceId}`) && (
              <Alert onDismiss={() => dismiss(`config-${gateway.configError?.occurrenceId}`)}>
                Configuration unavailable: {gateway.configError.message} Open the configuration
                editor to repair the authoritative file.{" "}
                {config
                  ? "The retained draft remains editable. Review external changes before saving."
                  : "Structured editing is paused."}
              </Alert>
            )}
          {gateway?.operationalError &&
            (!error || errorOccurrence !== gateway.operationalError.occurrenceId) &&
            !dismissed.has(`operation-${gateway.operationalError.occurrenceId}`) && (
              <Alert
                onDismiss={() => dismiss(`operation-${gateway.operationalError?.occurrenceId}`)}
              >
                {gateway.operationalError.code}: {gateway.operationalError.message}
              </Alert>
            )}
          {snapshot?.login.error &&
            (parsed?.gateway.launchAtLogin || snapshot.login.supported) &&
            !dismissed.has(`login-${snapshot.login.occurrenceId}`) && (
              <Alert
                kind="warning"
                onDismiss={() => dismiss(`login-${snapshot.login.occurrenceId}`)}
              >
                Login startup: {snapshot.login.error}
              </Alert>
            )}
          {stale && !dismissed.has(`stale-${gateway?.revision}`) && (
            <Alert
              kind="warning"
              role="status"
              onDismiss={() => dismiss(`stale-${gateway?.revision}`)}
            >
              The configuration changed outside this window. Your draft and its original revision
              are preserved. A stale save will be refused. Copy your changes from the configuration
              editor before reloading.
            </Alert>
          )}
        </div>
        {!snapshot || !doc ? (
          <section className="panel loading" aria-busy="true">
            <Activity size={22} />
            <h2>Connecting to the application</h2>
            <p>Waiting for the native application…</p>
          </section>
        ) : (
          <>
            <fieldset disabled={busy} className="workspace">
              <section className="gateway-strip panel" aria-label="Gateway status">
                <div className={`status-orb ${gateway?.running ? "online" : ""}`}>
                  <Network size={25} />
                </div>
                <div className="gateway-summary">
                  <div className="inline">
                    <h2>Gateway</h2>
                    <span className={`badge ${gateway?.running ? "teal" : ""}`}>
                      {gateway?.running ? "Running" : "Stopped"}
                    </span>
                  </div>
                  <p className="mono">
                    {gateway?.running
                      ? (gateway.address ?? "Listener starting")
                      : "No active listener"}
                  </p>
                </div>
                <div className="gateway-actions">
                  <button
                    type="button"
                    className={gateway?.running ? "button" : "button primary"}
                    disabled={!gateway?.running && (dirty || !!gateway?.configError)}
                    onClick={() =>
                      void run(
                        () => (gateway?.running ? client.stop() : client.start()),
                        gateway?.running ? "Gateway stopped." : "Gateway started.",
                      )
                    }
                  >
                    {gateway?.running ? "Stop gateway" : "Start gateway"}
                    <ArrowUpRight size={15} />
                  </button>
                </div>
              </section>
              {(dirty || retryLogin) && (
                <div className="draft-bar">
                  <span>
                    <strong>{dirty ? "Unsaved changes" : "Login registration unresolved"}</strong>
                    <small>
                      {dirty
                        ? "Live endpoints still use the saved configuration."
                        : "Save again to retry the requested login setting."}
                    </small>
                  </span>
                  <div>
                    {dirty && (
                      <button
                        type="button"
                        className="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              "Discard all unsaved changes and load the latest configuration?",
                            )
                          ) {
                            setDoc({
                              text: snapshot.gateway.configText,
                              revision: snapshot.gateway.revision,
                              dirty: false,
                            });
                            setError(null);
                          }
                        }}
                      >
                        Discard
                      </button>
                    )}
                    <button type="button" className="button primary" onClick={() => void save()}>
                      {dirty ? "Save changes" : "Retry login registration"}
                    </button>
                  </div>
                </div>
              )}
              {tab === "logs" ? (
                <Logs
                  client={client}
                  servers={gateway?.servers.map((server) => server.name) ?? []}
                />
              ) : tab === "overview" ? (
                <>
                  <section aria-labelledby="servers-heading">
                    <div className="section-heading">
                      <div>
                        <h2 id="servers-heading">
                          Your servers{" "}
                          <span className="count">
                            {config ? Object.keys(config.mcpServers).length : "?"}
                          </span>
                        </h2>
                        <p>A separate endpoint for each configured MCP server.</p>
                      </div>
                      <button
                        type="button"
                        className="button primary"
                        disabled={!config}
                        onClick={() => openEditor()}
                      >
                        <Plus size={16} /> Add server
                      </button>
                    </div>
                    <div className="server-grid">
                      {config &&
                        Object.entries(config.mcpServers).map(([name, server]) => {
                          const live = gateway?.servers.find((item) => item.name === name);
                          const status = live?.status ?? (server.disabled ? "disabled" : "stopped");
                          const http = "url" in server;
                          return (
                            <article className="server-card panel" key={name}>
                              <div className="card-top">
                                <span className={`server-icon ${http ? "blue" : ""}`}>
                                  {http ? <Globe size={21} /> : <Terminal size={21} />}
                                </span>
                                <span
                                  className={`badge ${status === "mounted" ? "teal" : status === "error" ? "red" : ""}`}
                                >
                                  {status === "mounted"
                                    ? "Mounted"
                                    : status === "disabled"
                                      ? "Disabled"
                                      : status === "error"
                                        ? "Error"
                                        : "Stopped"}
                                </span>
                              </div>
                              <h3>{name}</h3>
                              <p className="transport">
                                {http ? "STREAMABLE HTTP" : "LOCAL STDIO"}
                              </p>
                              <p
                                className="server-detail mono"
                                title={http ? server.url : server.command}
                              >
                                {http ? server.url : server.command}
                              </p>
                              <div className="endpoint">
                                <span className="mono">/mcp/{name}</span>
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label={`Copy endpoint for ${name}`}
                                  disabled={!live || dirty}
                                  onClick={() =>
                                    void run(
                                      () => client.copyEndpoint({ name }),
                                      "Endpoint copied to clipboard.",
                                    )
                                  }
                                >
                                  <Copy size={14} />
                                </button>
                              </div>
                              {live?.error && <p className="inline-error">{live.error.message}</p>}
                              <div className="card-actions">
                                <button
                                  type="button"
                                  className="text-button"
                                  onClick={() => openEditor(name)}
                                >
                                  Edit server
                                </button>
                                <button
                                  type="button"
                                  className="text-button"
                                  disabled={dirty || !!gateway?.configError}
                                  onClick={() => void toggleEndpoint(name, !server.disabled)}
                                >
                                  {server.disabled ? "Start" : "Stop"}
                                </button>
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label={`Restart ${name}`}
                                  disabled={
                                    dirty ||
                                    !gateway?.running ||
                                    server.disabled ||
                                    !!gateway?.configError
                                  }
                                  onClick={() =>
                                    void run(
                                      () => client.restartServer({ name }),
                                      `${name} restarted.`,
                                    )
                                  }
                                >
                                  <RefreshCw size={15} />
                                </button>
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label={`Delete ${name}`}
                                  onClick={() => setDeleting(name)}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                              <button
                                type="button"
                                className="client-copy"
                                disabled={!live || dirty}
                                onClick={() =>
                                  void run(
                                    () => client.copyClientConfig({ name }),
                                    "Client configuration copied. It contains your bearer token; keep it private.",
                                  )
                                }
                              >
                                <Code2 size={14} /> Copy client configuration{" "}
                                <ArrowUpRight size={13} />
                              </button>
                            </article>
                          );
                        })}
                    </div>
                    {config && Object.keys(config.mcpServers).length === 0 && (
                      <div className="empty-state panel">
                        <div className="empty-icon">
                          <Server size={29} />
                        </div>
                        <h3>No servers configured</h3>
                        <p>
                          Add a local command or an existing HTTP server.
                          <br />
                          Each gets its own shareable MCP endpoint.
                        </p>
                        <button
                          type="button"
                          className="button"
                          onClick={() => {
                            const preset = emptyEditor();
                            preset.name = "bear";
                            preset.command = "/Applications/Bear.app/Contents/MacOS/bearcli";
                            preset.args = '["mcp-server"]';
                            setEditorError(null);
                            setEditor(preset);
                          }}
                        >
                          Use macOS Bear preset <ArrowUpRight size={14} />
                        </button>
                        <small>
                          Optional, macOS only. Bear can expose all accessible notes and tools.
                        </small>
                      </div>
                    )}
                    {!config && (
                      <div className="panel empty-state">
                        <Code2 size={26} />
                        <h3>Repair configuration to continue</h3>
                        <p>
                          No defaults have been substituted. Your original configuration text
                          remains available below.
                        </p>
                      </div>
                    )}
                    <p className="fine-print">
                      <CircleHelp size={14} /> Mounted means the route is available, not that a
                      backend handshake has succeeded. Endpoint Start/Stop saves its enabled state;
                      starting the gateway is separate.
                    </p>
                  </section>
                  <section className="network-note">
                    <ShieldCheck size={22} />
                    <div>
                      <h3>A local network, not a private tunnel.</h3>
                      <p>
                        LAN traffic uses unencrypted HTTP, including the bearer token and tool data.
                        Use only a trusted network. Keep this computer awake for access; DHCP can
                        change its address. Remote-device reachability is not verified here.
                      </p>
                    </div>
                  </section>
                </>
              ) : (
                <section className="panel settings-panel">
                  <div className="section-heading">
                    <div>
                      <h2>Gateway preferences</h2>
                      <p>Changes take effect after saving the full {filename}.</p>
                    </div>
                    <Settings2 size={20} />
                  </div>
                  {config ? (
                    <>
                      <div className="form-grid">
                        <Field
                          label="Interface / address"
                          help="Select a local IPv4 interface. Loopback is available only on this computer."
                        >
                          <input
                            aria-label="Interface / address"
                            list="interfaces"
                            value={config.gateway.host}
                            onChange={(event) =>
                              update({
                                ...config,
                                gateway: { ...config.gateway, host: event.target.value },
                              })
                            }
                          />
                          <datalist id="interfaces">
                            {gateway?.interfaces.map((item) => (
                              <option key={`${item.name}-${item.address}`} value={item.address}>
                                {item.name}
                                {item.loopback ? " · this computer only" : " · LAN"}
                              </option>
                            ))}
                          </datalist>
                        </Field>
                        <Field label="Port">
                          <input
                            type="number"
                            min="1"
                            max="65535"
                            value={config.gateway.port === 0 ? "" : config.gateway.port}
                            onChange={(event) =>
                              update({
                                ...config,
                                // Keep an empty port editable; zero is explicitly rejected by native validation.
                                gateway: {
                                  ...config.gateway,
                                  port: event.target.value === "" ? 0 : event.target.valueAsNumber,
                                },
                              })
                            }
                          />
                        </Field>
                      </div>
                      <Field
                        label="Bearer token"
                        help="32–512 non-space ASCII characters. Client configurations include this secret."
                      >
                        <div className="token-input">
                          <input
                            autoComplete="off"
                            spellCheck={false}
                            type={showToken ? "text" : "password"}
                            value={config.gateway.token}
                            onChange={(event) =>
                              update({
                                ...config,
                                gateway: { ...config.gateway, token: event.target.value },
                              })
                            }
                          />
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={showToken ? "Hide bearer token" : "Show bearer token"}
                            onClick={() => setShowToken(!showToken)}
                          >
                            {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
                          </button>
                        </div>
                      </Field>
                      <button
                        type="button"
                        className="button small"
                        onClick={() => {
                          const bytes = crypto.getRandomValues(new Uint8Array(32));
                          update({
                            ...config,
                            gateway: {
                              ...config.gateway,
                              token: Array.from(bytes, (byte) =>
                                byte.toString(16).padStart(2, "0"),
                              ).join(""),
                            },
                          });
                        }}
                      >
                        Generate secure token
                      </button>
                      <div className="startup-settings">
                        <Toggle
                          label="Launch app at login"
                          description={
                            snapshot.platform === "linux"
                              ? "Automatic login registration is unavailable on Linux."
                              : "Open MCP Gateway in the background when you sign in to macOS."
                          }
                          disabled={snapshot.platform === "linux"}
                          checked={config.gateway.launchAtLogin ?? false}
                          onChange={(value) =>
                            update({
                              ...config,
                              gateway: { ...config.gateway, launchAtLogin: value },
                            })
                          }
                        />
                        <div className="login-status">
                          <span className="badge">
                            Actual login registration:{" "}
                            {snapshot.login.supported
                              ? snapshot.login.enabled
                                ? "Enabled"
                                : "Disabled"
                              : "Unsupported"}
                          </span>
                          {snapshot.login.error && (
                            <p className="inline-error">{snapshot.login.error}</p>
                          )}
                          <small>
                            {snapshot.platform === "linux"
                              ? "Gateway automatic start remains available below."
                              : "Desired setting above is separate from the actual macOS registration shown here."}
                          </small>
                        </div>
                        <Toggle
                          label="Start gateway when the app opens"
                          description="Begin listening automatically, independently of login startup."
                          checked={config.gateway.autoStart ?? false}
                          onChange={(value) =>
                            update({ ...config, gateway: { ...config.gateway, autoStart: value } })
                          }
                        />
                      </div>
                    </>
                  ) : (
                    <p>Structured preferences are paused until the configuration is repaired.</p>
                  )}
                </section>
              )}
              {tab !== "logs" && (
                <section className="panel raw-panel">
                  <button
                    type="button"
                    className="raw-heading"
                    ref={recoveryButton}
                    aria-expanded={rawOpen}
                    onClick={() => setRawOpen(!rawOpen)}
                  >
                    <Code2 size={18} />
                    <span>
                      <strong>Authoritative configuration</strong>
                      <small>{filename} · advanced editing & recovery</small>
                    </span>
                    <ChevronRight className={rawOpen ? "expanded" : ""} size={18} />
                  </button>
                  {rawOpen && (
                    <div className="raw-body">
                      <p className="mono config-path">{gateway?.configPath}</p>
                      <p>
                        Full file contents, including credentials. Invalid saves are rejected
                        without discarding your draft. Preserve a copy of your edits before
                        reloading external changes.{" "}
                        {format === "jsonc"
                          ? "JSONC accepts // and /* */ comments and trailing commas."
                          : "Strict JSON: comments and trailing commas are not allowed."}{" "}
                        Changing the filename requires reopening the app.
                      </p>
                      <Field label={filename}>
                        <textarea
                          className="code-editor"
                          spellCheck={false}
                          value={doc.text}
                          onChange={(event) => {
                            setDoc({ ...doc, text: event.target.value, dirty: true });
                            setNotice("");
                          }}
                        />
                      </Field>
                      <button
                        type="button"
                        className="button primary"
                        disabled={!dirty && !retryLogin}
                        onClick={() => void save()}
                      >
                        <ArrowDownToLine size={15} /> Save {filename}
                      </button>
                    </div>
                  )}
                </section>
              )}
            </fieldset>
            <footer className="page-footer">
              <span>
                <span className={`dot ${gateway?.running ? "online" : ""}`} />
                {gateway?.running ? "Listener active" : "No active listener"}
              </span>
              <span>
                {snapshot.platform === "linux"
                  ? "Closing minimizes to the taskbar; the gateway and logs keep running. Use Quit to stop the app."
                  : "Closing this window keeps the app running. Use Quit to stop it."}
              </span>
            </footer>
          </>
        )}
      </main>
      {confirmQuit && (
        <Modal
          title="Quit MCP Gateway?"
          onClose={() => setConfirmQuit(false)}
          fallbackFocus={recoveryButton}
        >
          <p>Your unsaved changes will be discarded. Quit stops the gateway and its backends.</p>
          <div className="dialog-actions">
            <button type="button" className="button" onClick={() => setConfirmQuit(false)}>
              Cancel
            </button>
            <button type="button" className="button danger" onClick={() => void requestQuit()}>
              Discard changes and quit
            </button>
          </div>
        </Modal>
      )}
      {editor && (
        <Modal
          title={editor.original ? "Edit server" : "Add a server"}
          onClose={() => setEditor(null)}
          fallbackFocus={recoveryButton}
        >
          <form onSubmit={applyServer}>
            <p className="dialog-intro">Connect a local tool or an existing MCP endpoint.</p>
            {editorError && <Alert onDismiss={() => setEditorError(null)}>{editorError}</Alert>}
            <Field
              label="Server name"
              help="Used in /mcp/server-name. Letters, numbers, hyphens and underscores."
            >
              <input
                required
                value={editor.name}
                onChange={(event) => setEditor({ ...editor, name: event.target.value })}
              />
            </Field>
            <Field label="Transport">
              <select
                value={editor.type}
                onChange={(event) =>
                  setEditor({ ...editor, type: event.target.value === "http" ? "http" : "stdio" })
                }
              >
                <option value="stdio">Local command (stdio)</option>
                <option value="http">Streamable HTTP</option>
              </select>
            </Field>
            {editor.type === "stdio" ? (
              <>
                <Field
                  label="Command"
                  help="Executable path only. Arguments are passed separately, never through a shell."
                >
                  <input
                    required
                    value={editor.command}
                    placeholder="/path/to/mcp-server"
                    onChange={(event) => setEditor({ ...editor, command: event.target.value })}
                  />
                </Field>
                <Field label="Arguments (JSON array)">
                  <textarea
                    spellCheck={false}
                    value={editor.args}
                    onChange={(event) => setEditor({ ...editor, args: event.target.value })}
                  />
                </Field>
                <div className="form-grid">
                  <Field label="Environment (JSON object)">
                    <textarea
                      spellCheck={false}
                      value={editor.env}
                      onChange={(event) => setEditor({ ...editor, env: event.target.value })}
                    />
                  </Field>
                  <Field label="Working directory" help="Optional absolute path.">
                    <input
                      value={editor.cwd}
                      placeholder="/Users/you"
                      onChange={(event) => setEditor({ ...editor, cwd: event.target.value })}
                    />
                  </Field>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    setEditor({
                      ...editor,
                      name: editor.name || "bear",
                      command: "/Applications/Bear.app/Contents/MacOS/bearcli",
                      args: '["mcp-server"]',
                    })
                  }
                >
                  Fill macOS Bear preset (all accessible notes & tools)
                </button>
              </>
            ) : (
              <>
                <Field
                  label="Upstream URL"
                  help="HTTP(S), without embedded credentials or fragments."
                >
                  <input
                    required
                    value={editor.url}
                    placeholder="https://your-server.example/mcp"
                    onChange={(event) => setEditor({ ...editor, url: event.target.value })}
                  />
                </Field>
                <Field
                  label="Headers (JSON object)"
                  help="String values only. Prefer environment references such as ${API_TOKEN}."
                >
                  <textarea
                    spellCheck={false}
                    value={editor.headers}
                    onChange={(event) => setEditor({ ...editor, headers: event.target.value })}
                  />
                </Field>
              </>
            )}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={editor.disabled}
                onChange={(event) => setEditor({ ...editor, disabled: event.target.checked })}
              />{" "}
              Disabled (do not mount this endpoint)
            </label>
            <div className="dialog-actions">
              <button type="button" className="button" onClick={() => setEditor(null)}>
                Cancel
              </button>
              <button type="submit" className="button primary">
                Apply to draft
              </button>
            </div>
            <small className="dialog-footnote">
              Review and save changes to update the running gateway.
            </small>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Delete server?"
          onClose={() => setDeleting(null)}
          fallbackFocus={recoveryButton}
        >
          <p className="dialog-intro">
            Remove <strong>{deleting}</strong> from the configuration? Its endpoint will stop when
            you save. This does not delete backend data.
          </p>
          <div className="dialog-actions">
            <button type="button" className="button" onClick={() => setDeleting(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                if (!parsed) return;
                const servers = { ...parsed.mcpServers };
                delete servers[deleting];
                update({ ...parsed, mcpServers: servers });
                setDeleting(null);
              }}
            >
              Delete server
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
