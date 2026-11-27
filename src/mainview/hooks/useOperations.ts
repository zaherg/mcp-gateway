import type { Dispatch, RefObject, SetStateAction } from 'react';

import type { Document } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { AppResult, AppSnapshot, UpdateStatus } from '@mcp-gateway/shared/rpc';

interface OperationsOptions {
  quitGeneration: RefObject<number>;
  generation: RefObject<number>;
  editSequence: RefObject<number>;
  docRef: RefObject<Document | null>;
  setBusy: (busy: boolean) => void;
  updateBusy: boolean;
  setUpdateBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  setSnapshot: Dispatch<SetStateAction<AppSnapshot | null>>;
  setDoc: (doc: Document | null) => void;
}

export const useOperations = ({
  quitGeneration,
  generation,
  editSequence,
  docRef,
  setBusy,
  updateBusy,
  setUpdateBusy,
  setError,
  setSnapshot,
  setDoc,
}: OperationsOptions) => {
  const { t } = useI18n();
  const run = async (
    operation: () => Promise<AppResult<AppSnapshot | null>>,
    _message = '',
    saved = false,
    // A key move needs a clean form, so its failure has no draft to mention.
    draft = saved,
    submittedText?: string,
  ) => {
    const terminalGeneration = quitGeneration.current;
    const startedEditSeq = editSequence.current;
    setBusy(true);
    setError(null);
    generation.current++;
    try {
      const result = await operation();
      if (terminalGeneration !== quitGeneration.current) return false;
      if (!result.ok) {
        const failure = `${result.error.code}: ${result.error.message}`;
        setError(draft ? t('operations.saveFailed', { error: failure }) : failure);
        return false;
      }
      if (result.value) {
        setSnapshot(result.value);
        if (saved) {
          const currentDoc = docRef.current;
          const expectedText = submittedText ?? currentDoc?.text;
          if (editSequence.current === startedEditSeq && currentDoc?.text === expectedText) {
            setDoc({
              text: result.value.gateway.configText,
              revision: result.value.gateway.revision,
              dirty: false,
            });
          } else if (currentDoc) {
            setDoc({
              text: currentDoc.text,
              revision: result.value.gateway.revision,
              dirty: currentDoc.text !== result.value.gateway.configText,
            });
          }
        }
      }
      return true;
    } catch {
      if (terminalGeneration === quitGeneration.current) setError(t('operations.nativeFailed'));
      return false;
    } finally {
      if (terminalGeneration === quitGeneration.current) generation.current++;
      setBusy(false);
    }
  };

  const runUpdate = async (operation: () => Promise<AppResult<UpdateStatus>>, _message = '') => {
    if (updateBusy) return false;
    const terminalGeneration = quitGeneration.current;
    setUpdateBusy(true);
    setError(null);
    try {
      const result = await operation();
      if (terminalGeneration !== quitGeneration.current) return false;
      if (!result.ok) {
        setError(`${result.error.code}: ${result.error.message}`);
        return false;
      }
      setSnapshot((previous) => (previous ? { ...previous, update: result.value } : previous));
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
