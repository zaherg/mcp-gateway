import type { AppSnapshot, QuitStatus, UpdateStatus } from "../../shared/rpc";
import type { GatewayConfig, GatewaySnapshot } from "../../shared/types";
import { Alert } from "./ui";

export function Banners({
  error,
  dismissLocalError,
  updateState,
  tab,
  dismissed,
  dismiss,
  quitting,
  quitStatus,
  shutdownStarted,
  updateRestarting,
  quitStatusKnown,
  requestingQuit,
  quitReadError,
  notice,
  setNotice,
  gateway,
  errorOccurrence,
  config,
  configurationLocked,
  snapshot,
  loginWanted,
  stale,
}: {
  error: string | null;
  dismissLocalError: () => void;
  updateState: UpdateStatus | undefined;
  tab: "overview" | "settings" | "logs";
  dismissed: Set<string>;
  dismiss: (id: string) => void;
  quitting: boolean;
  quitStatus: QuitStatus;
  shutdownStarted: boolean;
  updateRestarting: boolean;
  quitStatusKnown: boolean;
  requestingQuit: boolean;
  quitReadError: boolean;
  notice: string;
  setNotice: (notice: string) => void;
  gateway: GatewaySnapshot | undefined;
  errorOccurrence: string | null;
  config: GatewayConfig | null;
  configurationLocked: boolean;
  snapshot: AppSnapshot | undefined;
  loginWanted: boolean;
  stale: boolean;
}) {
  return (
    <div className="announcements" aria-live="polite">
      {error && <Alert onDismiss={dismissLocalError}>{error}</Alert>}
      {updateState &&
        (updateState.phase === "available" || updateState.phase === "ready") &&
        tab !== "settings" &&
        !dismissed.has(
          `update-${updateState.phase}-${updateState.availableVersion ?? ""}-${updateState.error ?? ""}`,
        ) && (
          <Alert
            kind="warning"
            role="status"
            label="Dismiss update notice"
            onDismiss={() =>
              dismiss(
                `update-${updateState.phase}-${updateState.availableVersion ?? ""}-${updateState.error ?? ""}`,
              )
            }
          >
            {updateState.phase === "ready"
              ? `Version ${updateState.availableVersion} is ready to install.`
              : `Version ${updateState.availableVersion} is available.`}{" "}
            Open Settings → Updates to review and confirm.
          </Alert>
        )}
      {updateState?.phase === "error" &&
        !dismissed.has(
          `update-${updateState.phase}-${updateState.availableVersion ?? ""}-${updateState.error ?? ""}`,
        ) && (
          <Alert
            onDismiss={() =>
              dismiss(
                `update-${updateState.phase}-${updateState.availableVersion ?? ""}-${updateState.error ?? ""}`,
              )
            }
          >
            Update: {updateState.error ?? "The update operation failed."}
          </Alert>
        )}
      {!quitting &&
        quitStatus.phase === "failed" &&
        !dismissed.has(`quit-${quitStatus.attempt}`) && (
          <Alert onDismiss={() => dismiss(`quit-${quitStatus.attempt}`)}>{quitStatus.error}</Alert>
        )}
      {shutdownStarted && (
        <p role="status">
          Configuration is read-only because{" "}
          {updateRestarting ? "an update restart has started" : "Quit cleanup has started"}. Drafts
          can still be selected and copied, and Logs remain available.
        </p>
      )}
      {!quitStatusKnown && !requestingQuit && (
        <p role="status">Configuration is read-only until Quit status is confirmed.</p>
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
            Configuration unavailable: {gateway.configError.message} Open the configuration editor
            to repair the authoritative file.{" "}
            {config && !configurationLocked
              ? "The retained draft remains editable. Review external changes before saving."
              : "Structured editing is paused."}
          </Alert>
        )}
      {gateway?.operationalError &&
        (!error || errorOccurrence !== gateway.operationalError.occurrenceId) &&
        !dismissed.has(`operation-${gateway.operationalError.occurrenceId}`) && (
          <Alert onDismiss={() => dismiss(`operation-${gateway.operationalError?.occurrenceId}`)}>
            {gateway.operationalError.code}: {gateway.operationalError.message}
          </Alert>
        )}
      {snapshot?.login.error &&
        (loginWanted || snapshot.login.supported) &&
        !dismissed.has(`login-${snapshot.login.occurrenceId}`) && (
          <Alert kind="warning" onDismiss={() => dismiss(`login-${snapshot.login.occurrenceId}`)}>
            Login startup: {snapshot.login.error}
          </Alert>
        )}
      {stale && !dismissed.has(`stale-${gateway?.revision}`) && (
        <Alert kind="warning" role="status" onDismiss={() => dismiss(`stale-${gateway?.revision}`)}>
          The configuration changed outside this window. Your draft and its original revision are
          preserved. A stale save will be refused. Copy your changes from the configuration editor
          before reloading.
        </Alert>
      )}
    </div>
  );
}
