import type { RefObject } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import type { UpdateStatus } from '@mcp-gateway/shared/rpc';

interface Presentation {
  title: string;
  detail: string | null;
  ariaLabel: string;
  announcement: string;
}

const phaseLabels = (update: UpdateStatus): readonly [string, string | null] => {
  switch (update.phase) {
    case 'idle':
      return ['Updates', null];
    case 'checking':
      return ['Checking for updates…', null];
    case 'available':
      return ['Update available', update.availableVersion ?? 'Open update details'];
    case 'downloading':
      return ['Downloading update…', update.availableVersion];
    case 'ready':
      return ['Update ready', 'Restart to install'];
    case 'restarting':
      return ['Restarting…', null];
    case 'error':
      return ['Update needs attention', 'Open update details'];
  }
};

const describeUpdate = (update: UpdateStatus): Presentation => {
  const [title, detail] = phaseLabels(update);
  const version = update.availableVersion;
  if (update.phase === 'idle') {
    const checked = Boolean(update.checkedAt);
    return {
      title,
      detail,
      ariaLabel: checked ? 'Updates: up to date' : 'Updates: not checked yet',
      announcement: checked ? 'Updates: up to date.' : '',
    };
  }
  if (update.phase === 'ready') {
    return {
      title,
      detail,
      ariaLabel: version
        ? `Updates: Update ready, Restart to install (${version})`
        : 'Updates: Update ready, Restart to install',
      announcement: version
        ? `Update ${version} ready. Restart to install.`
        : 'Update ready. Restart to install.',
    };
  }
  return {
    title,
    detail,
    ariaLabel: detail ? `Updates: ${title}, ${detail}` : `Updates: ${title}`,
    announcement: detail && version ? `${title.replace('…', '')}: ${version}.` : title,
  };
};

interface SidebarUpdates {
  updateState: UpdateStatus | undefined;
  disabled: boolean;
  onOpen: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}

export const SidebarUpdates = ({ updateState, disabled, onOpen, triggerRef }: SidebarUpdates) => {
  if (!updateState?.supported) return null;
  const { title, detail, ariaLabel, announcement } = describeUpdate(updateState);
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
