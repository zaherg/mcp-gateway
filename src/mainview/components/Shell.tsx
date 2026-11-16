import { BookOpen, Network } from 'lucide-react';
import { type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import type { Editor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { MessageKey } from '@mcp-gateway/shared/i18n';
import type { AppSnapshot, QuitStatus, SocialLinkTarget } from '@mcp-gateway/shared/rpc';
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

interface Shell {
  tab: Tab;
  setTab: (tab: Tab) => void;
  snapshot: AppSnapshot | null;
  busy: boolean;
  quitting: boolean;
  editor: Editor | null;
  deleting: string | null;
  quitStatus: QuitStatus;
  interactiveQuit: { current: () => boolean };
  fallbackFocus: RefObject<HTMLButtonElement | null>;
  onOpenSocialLink: (target: SocialLinkTarget) => void;
  socialLinksDisabled: boolean;
  sidebarUpdates: ReactNode;
  gatewayToggle: ReactNode;
  children: ReactNode;
  dialogs: ReactNode;
}

export const Shell = ({
  tab,
  setTab,
  snapshot,
  busy,
  quitting,
  editor,
  deleting,
  quitStatus,
  interactiveQuit,
  fallbackFocus,
  onOpenSocialLink,
  socialLinksDisabled,
  sidebarUpdates,
  gatewayToggle,
  children,
  dialogs,
}: Shell) => {
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
          <span>MCP Gateway</span>
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
          {/* Brand marks: Simple Icons (https://simpleicons.org), CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). */}
          {/* biome-ignore lint/a11y/useSemanticElements: A fieldset adds form semantics; this row only groups external-link buttons. */}
          <div
            className="sidebar-social-links electrobun-webkit-app-region-no-drag"
            role="group"
            aria-label={t('shell.projectLinks')}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xl"
              className="sidebar-social-link"
              aria-label={t('shell.link.docs')}
              title={t('shell.link.docs')}
              disabled={socialLinksDisabled}
              onClick={() => onOpenSocialLink('docs')}
            >
              <BookOpen aria-hidden="true" focusable="false" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xl"
              className="sidebar-social-link"
              aria-label={t('shell.link.github')}
              title={t('shell.link.github')}
              disabled={socialLinksDisabled}
              onClick={() => onOpenSocialLink('github')}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xl"
              className="sidebar-social-link"
              aria-label={t('shell.link.x')}
              title={t('shell.link.x')}
              disabled={socialLinksDisabled}
              onClick={() => onOpenSocialLink('x')}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
              </svg>
            </Button>
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
                  : t(
                      (snapshot?.language.available.length ?? 0) > 1
                        ? 'shell.subtitle.settingsWithLanguage'
                        : 'shell.subtitle.settings',
                    )}
            </p>
          </div>
          <div className="page-actions">
            {gatewayToggle}
            <Button
              data-action="quit"
              disabled={
                busy ||
                quitting ||
                !!editor ||
                !!deleting ||
                (!snapshot && quitStatus.phase !== 'failed')
              }
              onClick={() => interactiveQuit.current()}
            >
              {quitting
                ? t('shell.quitting')
                : quitStatus.phase === 'failed'
                  ? t('shell.retryQuit')
                  : t('common.quitApp')}
            </Button>
          </div>
        </header>
        {children}
      </main>
      {dialogs}
    </div>
  );
};
