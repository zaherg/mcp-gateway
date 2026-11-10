import { ChevronRight, Network, Server, Settings2, ShieldCheck, Terminal } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef } from 'react';

import { Button } from '@mcp-gateway/mainview/components/mac/button';
import type { Editor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import type { AppSnapshot, QuitStatus } from '@mcp-gateway/shared/rpc';

export type Tab = 'overview' | 'settings' | 'logs';

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
  children,
  dialogs,
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  snapshot: AppSnapshot | null;
  busy: boolean;
  quitting: boolean;
  editor: Editor | null;
  deleting: string | null;
  quitStatus: QuitStatus;
  interactiveQuit: { current: () => boolean };
  children: ReactNode;
  dialogs: ReactNode;
}) => {
  const mainRef = useRef<HTMLElement>(null);

  // The shared scroller keeps its offset across tabs; reset it on navigation only.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tab` is the trigger, not a value the effect reads.
  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [tab]);

  return (
    <div className="app-shell">
      <aside className="sidebar electrobun-webkit-app-region-drag">
        <div className="brand">
          <span className="brand-mark">
            <Network size={22} />
          </span>
          <span>
            MCP Gateway<small>LOCAL CONNECTIONS</small>
          </span>
        </div>
        <nav aria-label="Main navigation" className="electrobun-webkit-app-region-no-drag">
          <button
            type="button"
            className={tab === 'overview' ? 'nav-item active' : 'nav-item'}
            onClick={() => setTab('overview')}
          >
            <Server size={17} /> Overview <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className={tab === 'settings' ? 'nav-item active' : 'nav-item'}
            onClick={() => setTab('settings')}
          >
            <Settings2 size={17} /> Settings <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className={tab === 'logs' ? 'nav-item active' : 'nav-item'}
            onClick={() => setTab('logs')}
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
      <main ref={mainRef} data-tab={tab}>
        <header className="page-heading">
          <div>
            <p className="eyebrow">YOUR LOCAL MCP WORKSPACE</p>
            <h1>
              {tab === 'overview'
                ? 'MCP server connections'
                : tab === 'logs'
                  ? 'Local diagnostic logs'
                  : 'Gateway settings'}
            </h1>
            <p className="subtitle">
              {tab === 'overview'
                ? 'Manage separate MCP endpoints for authorized clients on your LAN.'
                : tab === 'logs'
                  ? 'Inspect backend output locally. Diagnostic values are not redacted.'
                  : 'Control the listener, startup behavior, and authoritative configuration.'}
            </p>
          </div>
          <div>
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
                ? 'Quitting…'
                : quitStatus.phase === 'failed'
                  ? 'Retry Quit'
                  : 'Quit MCP Gateway'}
            </Button>
          </div>
        </header>
        {children}
      </main>
      {dialogs}
    </div>
  );
};
