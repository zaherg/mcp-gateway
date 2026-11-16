import type { RefObject } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { Translate } from '@mcp-gateway/shared/i18n';
import type { UpdateStatus } from '@mcp-gateway/shared/rpc';

interface Presentation {
  title: string;
  detail: string | null;
  ariaLabel: string;
  announcement: string;
}

const phaseLabels = (update: UpdateStatus, t: Translate): readonly [string, string | null] => {
  switch (update.phase) {
    case 'idle':
      return [t('common.updates'), null];
    case 'checking':
      return [t('sidebarUpdates.checking'), null];
    case 'available':
      return [
        t('sidebarUpdates.available'),
        update.availableVersion ?? t('sidebarUpdates.openDetails'),
      ];
    case 'downloading':
      return [t('sidebarUpdates.downloading'), update.availableVersion];
    case 'ready':
      return [t('sidebarUpdates.ready'), t('sidebarUpdates.restartToInstall')];
    case 'restarting':
      return [t('sidebarUpdates.restarting'), null];
    case 'error':
      return [t('sidebarUpdates.attention'), t('sidebarUpdates.openDetails')];
  }
};

const describeUpdate = (update: UpdateStatus, t: Translate): Presentation => {
  const [title, detail] = phaseLabels(update, t);
  const version = update.availableVersion;
  if (update.phase === 'idle') {
    const checked = Boolean(update.checkedAt);
    return {
      title,
      detail,
      ariaLabel: checked ? t('sidebarUpdates.upToDateAria') : t('sidebarUpdates.notCheckedAria'),
      announcement: checked ? t('sidebarUpdates.upToDateAnnounce') : '',
    };
  }
  if (update.phase === 'ready') {
    return {
      title,
      detail,
      ariaLabel: version
        ? t('sidebarUpdates.readyAriaVersion', { version })
        : t('sidebarUpdates.readyAria'),
      announcement: version
        ? t('sidebarUpdates.readyAnnounceVersion', { version })
        : t('sidebarUpdates.readyAnnounce'),
    };
  }
  return {
    title,
    detail,
    ariaLabel: detail
      ? t('sidebarUpdates.ariaWithDetail', { title, detail })
      : t('sidebarUpdates.aria', { title }),
    announcement:
      detail && version
        ? t('sidebarUpdates.announceVersion', { title: title.replace('…', ''), version })
        : title,
  };
};

interface SidebarUpdates {
  updateState: UpdateStatus | undefined;
  disabled: boolean;
  onOpen: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

export const SidebarUpdates = ({ updateState, disabled, onOpen, triggerRef }: SidebarUpdates) => {
  const { t } = useI18n();
  if (!updateState?.supported) return null;
  const { title, detail, ariaLabel, announcement } = describeUpdate(updateState, t);
  return (
    <div className="sidebar-updates electrobun-webkit-app-region-no-drag">
      <span className="sr-only" role="status">
        {announcement}
      </span>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        className="sidebar-updates-button"
        data-phase={updateState.phase}
        aria-haspopup="dialog"
        aria-label={ariaLabel}
        disabled={disabled || updateState.phase === 'restarting'}
        onClick={onOpen}
      >
        <span className="sidebar-updates-title">{title}</span>
        {detail && <span className="sidebar-updates-detail">{detail}</span>}
      </Button>
    </div>
  );
};
