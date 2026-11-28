import type { View } from '@effect/ui';
import type { Html } from '@effect/ui/html';

import type {
  AppSnapshotRedacted,
  GatewaySnapshotRedacted,
  Tab,
  UpdateStatusValue,
  VisibleErrorValue,
} from '@mcp-gateway/mainview/effect-app/schemas';
import { buttonClasses, iconAlertTriangle, iconNetwork } from '@mcp-gateway/mainview/effect-ui';
import { type Locale, type MessageKey, type Translate, translator } from '@mcp-gateway/shared/i18n';
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

const networkNotice = (snapshot: AppSnapshotRedacted | null) => {
  if (!snapshot) return LOADING_NOTICE;
  const network = snapshot.gateway.network;
  return network ? NETWORK_NOTICES[network] : NO_NETWORK_NOTICE;
};

const phaseLabels = (update: UpdateStatusValue, t: Translate): readonly [string, string | null] => {
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

const describeUpdate = (update: UpdateStatusValue, t: Translate) => {
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

export const renderSidebarUpdates = <M>(
  h: Html.H<M>,
  options: {
    readonly updateState: UpdateStatusValue | undefined;
    readonly disabled: boolean;
    readonly locale: string;
    readonly onOpen: M;
    readonly onRestart?: M;
  },
) => {
  const { updateState, disabled, locale, onOpen, onRestart } = options;
  if (!updateState?.supported) return null;
  const t = translator(locale as Locale);
  const { title, detail, ariaLabel, announcement } = describeUpdate(updateState, t);
  const isReady = updateState.phase === 'ready';
  const useRestart = isReady && onRestart !== undefined;
  let button = h.button
    .attr('type', 'button')
    .attr('data-slot', 'button')
    .attr('data-variant', 'ghost')
    .attr('data-size', 'xl')
    .attr('data-sidebar-updates-trigger', 'true')
    .attr('data-phase', updateState.phase)
    .attr('aria-label', ariaLabel)
    .class(buttonClasses('ghost', 'xl', 'sidebar-updates-button'))
    .disabled(disabled || updateState.phase === 'restarting')
    .on('click', () => (useRestart ? onRestart : onOpen));
  if (!useRestart) {
    button = button.attr('aria-haspopup', 'dialog');
  }
  return h.div
    .class('sidebar-updates electrobun-webkit-app-region-no-drag')
    .children(
      h.span.class('sr-only').attr('role', 'status').children(announcement),
      button.children(
        h.span.class('sidebar-updates-title').children(title),
        detail ? h.span.class('sidebar-updates-detail').children(detail) : null,
      ),
    );
};

export const renderGatewayToggle = <M>(
  h: Html.H<M>,
  options: {
    readonly gateway: GatewaySnapshotRedacted | undefined;
    readonly dirty: boolean;
    readonly configurationLocked: boolean;
    readonly locale: string;
    readonly onStart: M;
    readonly onStop: M;
  },
) => {
  const { gateway, dirty, configurationLocked, locale, onStart, onStop } = options;
  const t = translator(locale as Locale);
  const running = gateway?.running ?? false;
  // An unreadable stored key is retried by Start, for example after unlocking Keychain.
  const blocked =
    !running &&
    (dirty || (Boolean(gateway?.configError) && gateway?.configError?.code !== 'KeyUnavailable'));
  // A disabled button gets no pointer events, so the reason sits on a wrapper.
  const reason =
    configurationLocked || !blocked
      ? undefined
      : dirty
        ? t('toggle.saveFirst')
        : t('toggle.repairFirst');
  const variant = running ? 'secondary' : 'default';
  let wrapper = h.span.class('inline-flex');
  if (reason !== undefined) {
    wrapper = wrapper.attr('title', reason);
  }
  return [
    h.span
      .class('sr-only')
      .attr('role', 'status')
      .children(running ? t('common.gatewayRunning') : t('common.gatewayStopped')),
    wrapper.children(
      h.button
        .attr('type', 'button')
        .attr('data-slot', 'button')
        .attr('data-variant', variant)
        .attr('data-size', 'xl')
        .class(buttonClasses(variant, 'xl'))
        .disabled(configurationLocked || blocked)
        .on('click', () => (running ? onStop : onStart))
        .children(running ? t('common.stopGateway') : t('common.startGateway')),
    ),
  ];
};

export const renderConfigBlockerBar = <M>(
  h: Html.H<M>,
  options: {
    readonly configError: VisibleErrorValue | null | undefined;
    readonly stale: boolean;
    readonly disabled?: boolean;
    readonly locale: string;
    readonly onOpenRawConfig: M;
    readonly onReloadFromDisk: M;
  },
) => {
  const {
    configError,
    stale,
    disabled = false,
    locale,
    onOpenRawConfig,
    onReloadFromDisk,
  } = options;
  if (!configError && !stale) return null;
  const t = translator(locale as Locale);
  const isConfigError = Boolean(configError);
  const message =
    configError !== null && configError !== undefined
      ? configError.code === 'KeySetupFailed'
        ? configError.message
        : t('banners.configUnavailable', { message: configError.message })
      : t('banners.stale');

  return h.div
    .attr('role', 'alert')
    .class(
      'config-blocker-bar mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-mac-red/35 bg-mac-red/10 px-3.5 py-2.5 text-[13px] text-mac-label',
    )
    .children(
      h.div
        .class('flex min-w-0 flex-1 items-center gap-2.5')
        .children(
          iconAlertTriangle(h, 'size-4 shrink-0 text-mac-red-ink'),
          h.span.class('min-w-0 flex-1 wrap-anywhere').children(message),
        ),
      isConfigError
        ? h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('data-variant', 'default')
            .attr('data-size', 'lg')
            .class(buttonClasses('default', 'lg'))
            .disabled(disabled)
            .on('click', () => onOpenRawConfig)
            .children(t('raw.title'))
        : h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('data-variant', 'default')
            .attr('data-size', 'lg')
            .class(buttonClasses('default', 'lg'))
            .disabled(disabled)
            .on('click', () => onReloadFromDisk)
            .children(t('raw.reset')),
    );
};

export const renderShell = <M, R1 = never, R2 = never, R3 = never, R4 = never>(
  h: Html.H<M>,
  options: {
    readonly tab: Tab;
    readonly title: string;
    readonly snapshot: AppSnapshotRedacted | null;
    readonly locale: string;
    readonly sidebarUpdates: View.Input<M, R1>;
    readonly gatewayToggle: View.Input<M, R2>;
    readonly children: View.Input<M, R3>;
    readonly dialogs: View.Input<M, R4>;
    readonly onSelectTab: (tab: Tab) => M;
  },
) => {
  const {
    tab,
    title,
    snapshot,
    locale,
    sidebarUpdates,
    gatewayToggle,
    children,
    dialogs,
    onSelectTab,
  } = options;
  const t = translator(locale as Locale);
  const [networkTitle, networkDetail] = networkNotice(snapshot);
  const headingTitle =
    tab === 'overview'
      ? t('shell.title.overview')
      : tab === 'logs'
        ? t('shell.title.logs')
        : t('shell.title.settings');
  const headingSubtitle =
    tab === 'overview'
      ? t('shell.subtitle.overview')
      : tab === 'logs'
        ? t('shell.subtitle.logs')
        : t('shell.subtitle.settings');

  return h.div.class('app-shell').children(
    h.div.class('window-titlebar electrobun-webkit-app-region-drag').attr('aria-hidden', 'true'),
    h.aside.class('sidebar electrobun-webkit-app-region-drag').children(
      h.div
        .class('brand')
        .children(
          h.span.class('brand-mark').children(iconNetwork(h, 'size-[18px]')),
          h.span.children(title),
        ),
      h.nav
        .attr('aria-label', t('shell.mainNavigation'))
        .class('electrobun-webkit-app-region-no-drag')
        .children(
          h.button
            .attr('type', 'button')
            .attr('data-fallback-focus', 'true')
            .class(tab === 'overview' ? 'nav-item active' : 'nav-item')
            .on('click', () => onSelectTab('overview'))
            .children(t('shell.tab.overview')),
          h.button
            .attr('type', 'button')
            .class(tab === 'settings' ? 'nav-item active' : 'nav-item')
            .on('click', () => onSelectTab('settings'))
            .children(t('shell.tab.settings')),
          h.button
            .attr('type', 'button')
            .class(tab === 'logs' ? 'nav-item active' : 'nav-item')
            .on('click', () => onSelectTab('logs'))
            .children(t('shell.tab.logs')),
        ),
      h.div
        .class('sidebar-bottom')
        .children(
          sidebarUpdates,
          h.div
            .class('sidebar-footer')
            .children(
              h.span.class(`led ${snapshot?.gateway.running ? 'on' : ''}`),
              h.span.children(t(networkTitle), h.small.children(t(networkDetail))),
            ),
        ),
    ),
    h.main
      .attr('data-tab', tab)
      .children(
        h.header
          .class('page-heading')
          .children(
            h.div.children(
              h.h1.children(headingTitle),
              h.p.class('subtitle').children(headingSubtitle),
            ),
            h.div.class('page-actions').children(gatewayToggle),
          ),
        children,
      ),
    dialogs,
  );
};
