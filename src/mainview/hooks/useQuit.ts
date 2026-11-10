import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

import type { Editor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import type { AppClient, AppSnapshot, QuitStatus } from '@mcp-gateway/shared/rpc';

export const useQuit = ({
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
}: {
  client: AppClient;
  snapshot: AppSnapshot | null;
  updateRestarting: boolean;
  generation: RefObject<number>;
  confirmQuit: boolean;
  setConfirmQuit: (confirm: boolean) => void;
  setConfirmUpdate: (confirm: boolean) => void;
  setError: (error: string | null) => void;
  setNotice: (notice: string) => void;
  busy: boolean;
  dirty: boolean;
  editor: Editor | null;
  deleting: string | null;
}) => {
  const [quitStatus, setQuitStatus] = useState<QuitStatus>({
    attempt: 0,
    phase: 'idle',
    error: null,
  });
  const [quitStatusKnown, setQuitStatusKnown] = useState(false);
  const [requestingQuit, setRequestingQuit] = useState(false);
  const [quitReadError, setQuitReadError] = useState(false);
  const quitAttempt = useRef(0);
  const quitGeneration = useRef(0);
  const quitRequestPending = useRef(false);
  const quitting = requestingQuit || quitStatus.phase === 'pending' || quitStatus.phase === 'ready';
  const shutdownStarted = requestingQuit || quitStatus.phase !== 'idle' || updateRestarting;
  const configurationLocked = !quitStatusKnown || shutdownStarted;

  const acceptQuitStatus = useCallback(
    (status: QuitStatus) => {
      if (status.attempt < quitAttempt.current) return;
      quitAttempt.current = status.attempt;
      setQuitStatusKnown(true);
      setQuitStatus(status);
      if (status.phase !== 'idle') setConfirmQuit(false);
      if (status.phase === 'failed') setNotice('');
    },
    [setConfirmQuit, setNotice],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const pollQuit = async () => {
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
    };
    void pollQuit();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, acceptQuitStatus]);

  // Quit and Restart to update share one request protocol; only the call and the texts differ.
  const requestTerminal = async (
    request: AppClient['quit'],
    pendingNotice: string,
    failureMessage: string,
  ): Promise<void> => {
    setRequestingQuit(true);
    setQuitStatusKnown(false);
    quitRequestPending.current = true;
    quitGeneration.current++;
    setError(null);
    setNotice('');
    try {
      const result = await request();
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return;
      }
      acceptQuitStatus(result.value.status);
      if (result.value.status.phase !== 'failed') setNotice(pendingNotice);
    } catch {
      setError(failureMessage);
    } finally {
      quitRequestPending.current = false;
      setRequestingQuit(false);
    }
  };

  const requestQuit = async () => {
    if (quitRequestPending.current) return;
    setConfirmQuit(false);
    await requestTerminal(
      () => client.quit(),
      'Quit requested. Waiting for gateway cleanup.',
      'Could not request Quit. Check application status before retrying.',
    );
  };

  const requestUpdateRestart = async () => {
    if (quitting || updateRestarting) return;
    if (snapshot?.update.phase !== 'ready') return;
    setConfirmUpdate(false);
    generation.current++;
    await requestTerminal(
      () => client.updatesRestart(),
      'Restart requested. Waiting for gateway cleanup.',
      'Could not request the update restart. Check application status before retrying.',
    );
  };

  const interactiveQuit = useRef<() => boolean>(() => false);
  interactiveQuit.current = () => {
    if (confirmQuit || quitting || quitRequestPending.current) return true;
    if (busy || (!snapshot && quitStatus.phase !== 'failed')) {
      setError('Quit could not be requested while the window is busy. Try again when it is ready.');
      return true;
    }
    setConfirmUpdate(false);
    if ((dirty || editor || deleting) && !shutdownStarted) setConfirmQuit(true);
    else void requestQuit();
    return true;
  };
  useEffect(() => {
    const request = (event: Event) => {
      if (interactiveQuit.current()) event.preventDefault();
    };
    window.addEventListener('mcp-gateway:request-quit', request);
    return () => window.removeEventListener('mcp-gateway:request-quit', request);
  }, []);

  return {
    quitStatus,
    quitStatusKnown,
    requestingQuit,
    quitReadError,
    quitting,
    shutdownStarted,
    configurationLocked,
    acceptQuitStatus,
    requestQuit,
    requestUpdateRestart,
    interactiveQuit,
    quitRequestPending,
    quitGeneration,
  };
};
