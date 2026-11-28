import type { MessageKey } from '@mcp-gateway/shared/i18n';

export type ServerRowStatus = 'mounted' | 'error' | 'disabled' | 'stopped';

export type ServerTestState = 'testing' | 'passed' | 'failed' | 'cancelled';

export interface ServerTestRecord {
  readonly name: string;
  readonly revision: string;
  readonly state: ServerTestState;
  readonly message: string;
}

export interface OverviewServerItem {
  readonly name: string;
  readonly transport: 'http' | 'stdio';
  readonly target: string;
  readonly disabled: boolean;
  readonly status: ServerRowStatus;
  readonly hasLive: boolean;
  readonly liveError: string | null;
}

export const SERVER_STATUS: Record<
  ServerRowStatus,
  { readonly label: MessageKey; readonly led: string }
> = {
  mounted: { label: 'overview.status.mounted', led: 'on' },
  error: { label: 'overview.status.error', led: 'error' },
  disabled: { label: 'overview.status.disabled', led: '' },
  stopped: { label: 'overview.status.stopped', led: '' },
};

/**
 * A pass or failure describes the mount it ran against, so it ends when the gateway stops
 * or the server unmounts. A cancellation stays: it explains why the test stopped.
 */
export const isTestOutdated = (
  test: ServerTestRecord | null,
  running: boolean,
  servers: readonly OverviewServerItem[],
): boolean => {
  if (!test) return false;
  if (test.state !== 'passed' && test.state !== 'failed') return false;
  const testedStatus = servers.find((item) => item.name === test.name)?.status;
  return !(running && testedStatus === 'mounted');
};

export const visibleTestForServer = (
  test: ServerTestRecord | null,
  outdated: boolean,
  serverName: string,
  revision: string | null,
): ServerTestRecord | null =>
  !outdated && test !== null && test.name === serverName && test.revision === revision
    ? test
    : null;

export const resolveTestBlockedKey = (params: {
  readonly dirty: boolean;
  readonly hasConfigError: boolean;
  readonly running: boolean;
  readonly status: ServerRowStatus;
  readonly testingServerName: string | null;
  readonly serverName: string;
}): MessageKey | null => {
  if (params.dirty) return 'toggle.saveFirst';
  if (params.hasConfigError) return 'toggle.repairFirst';
  if (!params.running) return 'overview.testStartGateway';
  if (params.status !== 'mounted') return 'overview.testNotMounted';
  if (params.testingServerName !== null && params.testingServerName !== params.serverName) {
    return 'overview.testBusy';
  }
  return null;
};
