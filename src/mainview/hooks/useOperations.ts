import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { Document } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { AppResult, AppSnapshot, UpdateStatus } from '@mcp-gateway/shared/rpc';

interface OperationsOptions {
  quitGeneration: RefObject<number>;
  generation: RefObject<number>;
  setBusy: (busy: boolean) => void;
  updateBusy: boolean;
  setUpdateBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  setErrorOccurrence: (occurrence: string | null) => void;
  setNotice: (notice: string) => void;
  setSnapshot: Dispatch<SetStateAction<AppSnapshot | null>>;
  setDoc: (doc: Document | null) => void;
}

export const useOperations = ({
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
}: OperationsOptions) => {
  const { t } = useI18n();
  const run = async (
    operation: () => Promise<AppResult<AppSnapshot | null>>,
    message: string,
    saved = false,
  ) => {
    const terminalGeneration = quitGeneration.current;
    setBusy(true);
    setError(null);
    setErrorOccurrence(null);
    setNotice('');
    generation.current++;
    try {
      const result = await operation();
      if (terminalGeneration !== quitGeneration.current) return false;
      if (!result.ok) {
        setErrorOccurrence(result.error.occurrenceId ?? null);
        const failure = `${result.error.code}: ${result.error.message}`;
        setError(saved ? t('operations.saveFailed', { error: failure }) : failure);
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
      if (terminalGeneration === quitGeneration.current) setError(t('operations.nativeFailed'));
      return false;
    } finally {
      if (terminalGeneration === quitGeneration.current) generation.current++;
      setBusy(false);
    }
  };

  const runUpdate = async (
    operation: () => Promise<AppResult<UpdateStatus>>,
    message: string,
  ): Promise<boolean> => {
    if (updateBusy) return false;
    const terminalGeneration = quitGeneration.current;
    setUpdateBusy(true);
    setError(null);
    setNotice('');
    try {
      const result = await operation();
      if (terminalGeneration !== quitGeneration.current) return false;
      if (!result.ok) {
        setErrorOccurrence(result.error.occurrenceId ?? null);
        setError(`${result.error.code}: ${result.error.message}`);
        return false;
      }
      setSnapshot((previous) => (previous ? { ...previous, update: result.value } : previous));
      setNotice(message);
      return true;
    } catch {
      if (terminalGeneration === quitGeneration.current) setError(t('operations.updateFailed'));
      return false;
    } finally {
      setUpdateBusy(false);
    }
  };

  return { run, runUpdate };
};
