import { assert, describe, it } from '@effect/vitest';

import {
  isTestOutdated,
  type OverviewServerItem,
  resolveTestBlockedKey,
  type ServerTestRecord,
  visibleTestForServer,
} from '@mcp-gateway/mainview/effect-overview/logic';

const mountedBear: OverviewServerItem = {
  name: 'bear',
  transport: 'http',
  target: 'http://127.0.0.1:4001/mcp',
  disabled: false,
  status: 'mounted',
  hasLive: true,
  liveError: null,
};

const disabledBear: OverviewServerItem = {
  ...mountedBear,
  disabled: true,
  status: 'disabled',
  hasLive: false,
};

describe('effect-overview logic', () => {
  it('marks passed and failed tests outdated when gateway stops or server unmounts, while preserving cancelled and testing', () => {
    const passed: ServerTestRecord = {
      name: 'bear',
      revision: 'rev-1',
      state: 'passed',
      message: 'Connected (2025-11-25)',
    };
    const failed: ServerTestRecord = {
      ...passed,
      state: 'failed',
      message: 'Connection refused',
    };
    const cancelled: ServerTestRecord = {
      ...passed,
      state: 'cancelled',
      message: 'Gateway stopped during test',
    };
    const testing: ServerTestRecord = {
      ...passed,
      state: 'testing',
      message: 'Testing...',
    };

    assert.isFalse(isTestOutdated(null, false, []));
    assert.isFalse(isTestOutdated(passed, true, [mountedBear]));
    assert.isFalse(isTestOutdated(failed, true, [mountedBear]));
    assert.isTrue(isTestOutdated(passed, false, [mountedBear]));
    assert.isTrue(isTestOutdated(failed, true, [disabledBear]));
    assert.isTrue(isTestOutdated(passed, true, []));
    assert.isFalse(isTestOutdated(cancelled, false, []));
    assert.isFalse(isTestOutdated(testing, false, []));
  });

  it('filters visible test results by outdated flag, server name, and config revision', () => {
    const record: ServerTestRecord = {
      name: 'bear',
      revision: 'rev-1',
      state: 'passed',
      message: 'Connected',
    };

    assert.deepStrictEqual(visibleTestForServer(record, false, 'bear', 'rev-1'), record);
    assert.isNull(visibleTestForServer(record, true, 'bear', 'rev-1'));
    assert.isNull(visibleTestForServer(record, false, 'notes', 'rev-1'));
    assert.isNull(visibleTestForServer(record, false, 'bear', 'rev-2'));
    assert.isNull(visibleTestForServer(record, false, 'bear', null));
    assert.isNull(visibleTestForServer(null, false, 'bear', 'rev-1'));
  });

  it('resolves test blocked reason key in priority order', () => {
    assert.strictEqual(
      resolveTestBlockedKey({
        dirty: true,
        hasConfigError: true,
        running: false,
        status: 'stopped',
        testingServerName: 'other',
        serverName: 'bear',
      }),
      'toggle.saveFirst',
    );
    assert.strictEqual(
      resolveTestBlockedKey({
        dirty: false,
        hasConfigError: true,
        running: false,
        status: 'stopped',
        testingServerName: 'other',
        serverName: 'bear',
      }),
      'toggle.repairFirst',
    );
    assert.strictEqual(
      resolveTestBlockedKey({
        dirty: false,
        hasConfigError: false,
        running: false,
        status: 'stopped',
        testingServerName: 'other',
        serverName: 'bear',
      }),
      'overview.testStartGateway',
    );
    assert.strictEqual(
      resolveTestBlockedKey({
        dirty: false,
        hasConfigError: false,
        running: true,
        status: 'disabled',
        testingServerName: 'other',
        serverName: 'bear',
      }),
      'overview.testNotMounted',
    );
    assert.strictEqual(
      resolveTestBlockedKey({
        dirty: false,
        hasConfigError: false,
        running: true,
        status: 'mounted',
        testingServerName: 'other',
        serverName: 'bear',
      }),
      'overview.testBusy',
    );
    assert.isNull(
      resolveTestBlockedKey({
        dirty: false,
        hasConfigError: false,
        running: true,
        status: 'mounted',
        testingServerName: 'bear',
        serverName: 'bear',
      }),
    );
    assert.isNull(
      resolveTestBlockedKey({
        dirty: false,
        hasConfigError: false,
        running: true,
        status: 'mounted',
        testingServerName: null,
        serverName: 'bear',
      }),
    );
  });
});
