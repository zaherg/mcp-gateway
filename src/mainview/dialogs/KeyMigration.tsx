import { type RefObject, useState } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { Modal } from '@mcp-gateway/mainview/components/ui';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { KeyMigration as Slots } from '@mcp-gateway/shared/types';

interface KeyMigration {
  slots: Slots;
  dirty: boolean;
  busy: boolean;
  /** The failed move's sanitized reason, from the shared operation error. */
  error: string | null;
  filename: string;
  fallbackFocus: RefObject<HTMLElement | null>;
  onKeep: () => void;
  onClose: () => void;
  /** Moves exactly the slots the user reviewed, never ones that became eligible since. */
  onMove: (slots: Slots) => Promise<boolean>;
}

/** Two steps before an all-or-nothing, one-way move. Closing at any point changes nothing. */
export const KeyMigration = ({
  slots,
  dirty,
  busy,
  error,
  filename,
  fallbackFocus,
  onKeep,
  onClose,
  onMove,
}: KeyMigration) => {
  const { t } = useI18n();
  const [step, setStep] = useState<'what' | 'confirm' | 'done' | 'failed'>('what');
  // Frozen on Continue: the live list can change while the dialog is open and empties on success.
  const [reviewed, setReviewed] = useState(slots);
  const names = (list: Slots) => [
    ...(list.gateway ? [t('keys.global')] : []),
    ...list.servers.map((name) => t('keys.server', { name })),
  ];
  const shown = names(step === 'what' ? slots : reviewed);
  const move = async () => setStep((await onMove(reviewed)) ? 'done' : 'failed');
  return (
    <Modal title={t('keys.title')} onClose={onClose} fallbackFocus={fallbackFocus}>
      {dirty && step !== 'done' ? (
        <>
          <p className="dialog-intro">{t('keys.saveFirst')}</p>
          <div className="dialog-actions">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
          </div>
        </>
      ) : step === 'what' ? (
        <>
          <p className="dialog-intro">{t('keys.step1')}</p>
          <p>{t('keys.intro', { filename })}</p>
          <p>{t('keys.downgrade')}</p>
          <h3>{t('keys.list')}</h3>
          <ul>
            {shown.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <div className="dialog-actions">
            <Button onClick={onKeep}>{t('keys.keep')}</Button>
            <Button
              variant="default"
              disabled={shown.length === 0}
              onClick={() => {
                setReviewed(slots);
                setStep('confirm');
              }}
            >
              {t('keys.continue')}
            </Button>
          </div>
        </>
      ) : step === 'confirm' ? (
        <>
          <p className="dialog-intro">{t('keys.step2')}</p>
          <p>{t('keys.oneWay')}</p>
          <div className="dialog-actions">
            <Button disabled={busy} onClick={() => setStep('what')}>
              {t('keys.back')}
            </Button>
            <Button variant="default" disabled={busy} onClick={() => void move()}>
              {shown.length === 1 ? t('keys.moveOne') : t('keys.moveMany', { count: shown.length })}
            </Button>
          </div>
        </>
      ) : step === 'done' ? (
        <>
          <p role="status">{t('keys.moved')}</p>
          <div className="dialog-actions">
            <Button variant="default" onClick={onClose}>
              {t('keys.done')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p role="alert">{t('keys.failed')}</p>
          {error && <p className="inline-error">{error}</p>}
          <div className="dialog-actions">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            {/* Back to review: a stale or changed list must be confirmed again, not resent. */}
            <Button variant="default" disabled={busy} onClick={() => setStep('what')}>
              {t('keys.tryAgain')}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
};
