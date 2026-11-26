import { Network } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';

import { useGatewayView } from '@mcp-gateway/mainview/context/GatewayViewContext';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { MessageKey } from '@mcp-gateway/shared/i18n';
import type { AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { NetworkKind } from '@mcp-gateway/shared/types';

// Sidebar notice for the saved listener address: [title, detail].
const NETWORK_NOTICES: Record<NetworkKind, readonly [MessageKey, MessageKey]> = {
  loopback: ['shell.network.loopback', 'shell.network.loopbackDetail'],
  lan: ['shell.network.lan', 'shell.network.lanDetail'],
  tailscale: ['shell.network.tailscale', 'shell.network.tunneledDetail'],
  tunnel: ['shell.network.tunnel', 'shell.network.tunneledDetail'],
};
const NO_NETWORK_NOTICE = ['shell.network.unavailable', 'shell.network.unavailableDetail'] as const;
const LOADING_NOTICE = ['shell.network.loading', 'shell.network.loadingDetail'] as const;

const networkNotice = (snapshot: AppSnapshot | null): readonly [MessageKey, MessageKey] => {
  if (!snapshot) return LOADING_NOTICE;
  const network = snapshot.gateway.network;
  return network ? NETWORK_NOTICES[network] : NO_NETWORK_NOTICE;
};

export type Tab = 'overview' | 'settings' | 'logs';

interface ShellProps {
  sidebarUpdates: ReactNode;
  gatewayToggle: ReactNode;
  children: ReactNode;
  dialogs: ReactNode;
}

export const Shell = ({ sidebarUpdates, gatewayToggle, children, dialogs }: ShellProps) => {
  const { tab, setTab, snapshot, fallbackFocus } = useGatewayView();
  const { t } = useI18n();
  const mainRef = useRef<HTMLElement>(null);
  const [networkTitle, networkDetail] = networkNotice(snapshot);

  // The shared scroller keeps its offset across tabs; reset it on navigation only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tab` is the trigger, not a value the effect reads.
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [tab]);

  return (
    <div className="app-shell">
      <div className="window-titlebar electrobun-webkit-app-region-drag" aria-hidden="true" />
      <aside className="sidebar electrobun-webkit-app-region-drag">
        <div className="brand">
          <span className="brand-mark">
            <Network size={18} />
          </span>
          <span>{document.title}</span>
        </div>
        <nav
          aria-label={t('shell.mainNavigation')}
          className="electrobun-webkit-app-region-no-drag"
        >
          <button
            type="button"
            className={tab === 'overview' ? 'nav-item active' : 'nav-item'}
            ref={fallbackFocus}
            onClick={() => setTab('overview')}
          >
            {t('shell.tab.overview')}
          </button>
          <button
            type="button"
            className={tab === 'settings' ? 'nav-item active' : 'nav-item'}
            onClick={() => setTab('settings')}
          >
            {t('shell.tab.settings')}
          </button>
          <button
            type="button"
            className={tab === 'logs' ? 'nav-item active' : 'nav-item'}
            onClick={() => setTab('logs')}
          >
            {t('shell.tab.logs')}
          </button>
        </nav>
        <div className="sidebar-bottom">
          {sidebarUpdates}
          <div className="sidebar-footer">
            <span className={`led ${snapshot?.gateway.running ? 'on' : ''}`} />
            <span>
              {t(networkTitle)}
              <small>{t(networkDetail)}</small>
            </span>
          </div>
        </div>
      </aside>
      <main ref={mainRef} data-tab={tab}>
        <header className="page-heading">
          <div>
            <h1>
              {tab === 'overview'
                ? t('shell.title.overview')
                : tab === 'logs'
                  ? t('shell.title.logs')
                  : t('shell.title.settings')}
            </h1>
            <p className="subtitle">
              {tab === 'overview'
                ? t('shell.subtitle.overview')
                : tab === 'logs'
                  ? t('shell.subtitle.logs')
                  : t('shell.subtitle.settings')}
            </p>
          </div>
          <div className="page-actions">{gatewayToggle}</div>
        </header>
        {children}
      </main>
      {dialogs}
    </div>
  );
};
