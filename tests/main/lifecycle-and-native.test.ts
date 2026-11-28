import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { GatewayError } from '@mcp-gateway/core/errors';
import { openKeychain } from '@mcp-gateway/main/keychain';
import {
  InteractiveQuitGate,
  QuitCoordinator,
  WINDOW_REVEAL_DELAY_MS,
  WINDOW_REVEAL_FALLBACK_MS,
  WindowRevealCoordinator,
  type WindowRevealTimers,
} from '@mcp-gateway/main/lifecycle';
import {
  configurationDirectory,
  installedIdentifier,
  postNativeNotification,
} from '@mcp-gateway/main/native';
import { PRODUCTION_IDENTIFIER, TEST_IDENTIFIER } from '@mcp-gateway/shared/identity';
import {
  deferred,
  expectAsyncGatewayError,
  flushMicrotasks,
  registerTempDirLifecycle,
} from '../helpers/core';

const { makeTempDir } = registerTempDirLifecycle('mcp-gateway-lifecycle-');

describe('QuitCoordinator', () => {
  test('starts idle, returns defensive status copies, and reports updateRestartActive false', () => {
    const coordinator = new QuitCoordinator(
      async () => {},
      () => {},
      () => {},
    );

    const status = coordinator.status();
    expect(status).toEqual({ attempt: 0, phase: 'idle', error: null });
    expect(coordinator.updateRestartActive()).toBe(false);

    status.phase = 'ready';
    expect(coordinator.status().phase).toBe('idle');
  });

  test('vetoes first quit, dedupes concurrent cleanup calls, calls quitAgain, and allows ready quit', async () => {
    const gate = deferred();
    let cleanupCalls = 0;
    let quitAgainCalls = 0;
    const failures: Array<{ error: unknown; kind: 'quit' | 'update' }> = [];

    const coordinator = new QuitCoordinator(
      async () => {
        cleanupCalls++;
        await gate.promise;
      },
      () => {
        quitAgainCalls++;
      },
      (error, kind) => failures.push({ error, kind }),
    );

    let veto1 = 0;
    let veto2 = 0;
    coordinator.handle(() => veto1++);
    coordinator.handle(() => veto2++);

    expect(veto1).toBe(1);
    expect(veto2).toBe(1);
    expect(coordinator.status()).toEqual({ attempt: 1, phase: 'pending', error: null });

    await flushMicrotasks();
    expect(cleanupCalls).toBe(1);
    expect(quitAgainCalls).toBe(0);

    gate.resolve();
    await flushMicrotasks();

    expect(cleanupCalls).toBe(1);
    expect(quitAgainCalls).toBe(1);
    expect(coordinator.status()).toEqual({ attempt: 1, phase: 'ready', error: null });
    expect(failures).toEqual([]);

    // Once ready, native quit is no longer vetoed.
    let veto3 = 0;
    coordinator.handle(() => veto3++);
    expect(veto3).toBe(0);
    expect(coordinator.armQuit()).toBe(false);
  });

  test('armQuit() is idempotent while pending and overrides an unapproved update restart', async () => {
    const gate = deferred();
    const coordinator = new QuitCoordinator(
      () => gate.promise,
      () => {},
      () => {},
    );

    const updatePromise = coordinator.beginUpdateRestart();
    expect(coordinator.updateRestartActive()).toBe(true);
    expect(coordinator.status()).toEqual({ attempt: 1, phase: 'pending', error: null });

    expect(coordinator.armQuit()).toBe(true);
    expect(coordinator.updateRestartActive()).toBe(false);
    expect(coordinator.status()).toEqual({ attempt: 2, phase: 'pending', error: null });

    // Calling armQuit again while already pending quit does not bump attempt.
    expect(coordinator.armQuit()).toBe(true);
    expect(coordinator.status().attempt).toBe(2);

    gate.resolve();
    expect(await updatePromise).toBe(false);
  });

  test('beginUpdateRestart() returns false when quit intent is already armed and deduplicates concurrent update restart calls without incrementing attempt', async () => {
    const quitCoordinator = new QuitCoordinator(
      async () => {},
      () => {},
      () => {},
    );
    expect(quitCoordinator.armQuit()).toBe(true);
    expect(quitCoordinator.status()).toEqual({ attempt: 1, phase: 'pending', error: null });
    expect(await quitCoordinator.beginUpdateRestart()).toBe(false);
    expect(quitCoordinator.updateRestartActive()).toBe(false);
    expect(quitCoordinator.status()).toEqual({ attempt: 1, phase: 'pending', error: null });

    const gate = deferred();
    let cleanupCalls = 0;
    const updateCoordinator = new QuitCoordinator(
      async () => {
        cleanupCalls++;
        await gate.promise;
      },
      () => {},
      () => {},
    );

    const first = updateCoordinator.beginUpdateRestart();
    expect(updateCoordinator.updateRestartActive()).toBe(true);
    expect(updateCoordinator.status()).toEqual({ attempt: 1, phase: 'pending', error: null });

    const second = updateCoordinator.beginUpdateRestart();
    expect(updateCoordinator.status()).toEqual({ attempt: 1, phase: 'pending', error: null });

    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(cleanupCalls).toBe(1);
    expect(updateCoordinator.status().attempt).toBe(1);

    // Calling beginUpdateRestart again while intent is still 'update' (before approve/clear) also keeps attempt unchanged.
    expect(await updateCoordinator.beginUpdateRestart()).toBe(true);
    expect(cleanupCalls).toBe(1);
    expect(updateCoordinator.status().attempt).toBe(1);
  });

  test('recovers from cleanup failure on ordinary quit and allows retry', async () => {
    let attempts = 0;
    let quitAgainCalls = 0;
    const failures: Array<{ error: unknown; kind: 'quit' | 'update' }> = [];

    const coordinator = new QuitCoordinator(
      async () => {
        attempts++;
        if (attempts === 1) throw new Error('stop failed');
      },
      () => {
        quitAgainCalls++;
      },
      (error, kind) => failures.push({ error, kind }),
    );

    let veto1 = 0;
    coordinator.handle(() => veto1++);
    await flushMicrotasks();

    expect(veto1).toBe(1);
    expect(quitAgainCalls).toBe(0);
    expect(coordinator.status()).toEqual({
      attempt: 1,
      phase: 'failed',
      error: 'Quit cleanup failed. The app has not exited. Retry Quit.',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('quit');

    let veto2 = 0;
    coordinator.handle(() => veto2++);
    await flushMicrotasks();

    expect(veto2).toBe(1);
    expect(attempts).toBe(2);
    expect(quitAgainCalls).toBe(1);
    expect(coordinator.status()).toEqual({ attempt: 2, phase: 'ready', error: null });
  });

  test('recovers when quitAgain throws by resetting cleanup state and reporting quit failure', async () => {
    let cleanupCalls = 0;
    let quitAgainCalls = 0;
    const failures: Array<{ error: unknown; kind: 'quit' | 'update' }> = [];

    const coordinator = new QuitCoordinator(
      async () => {
        cleanupCalls++;
      },
      () => {
        quitAgainCalls++;
        if (quitAgainCalls === 1) throw new Error('native quit failed');
      },
      (error, kind) => failures.push({ error, kind }),
    );

    coordinator.handle(() => {});
    await flushMicrotasks();

    expect(cleanupCalls).toBe(1);
    expect(quitAgainCalls).toBe(1);
    expect(coordinator.status()).toEqual({
      attempt: 1,
      phase: 'failed',
      error: 'Quit cleanup failed. The app has not exited. Retry Quit.',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('quit');

    // Retry re-runs cleanup because cleanupDone was reset on quitAgain error.
    coordinator.handle(() => {});
    await flushMicrotasks();

    expect(cleanupCalls).toBe(2);
    expect(quitAgainCalls).toBe(2);
    expect(coordinator.status()).toEqual({ attempt: 2, phase: 'ready', error: null });
  });

  test('coordinates update restart approval, clearUpdateRestart, and signal override', async () => {
    let cleanupCalls = 0;
    let quitAgainCalls = 0;

    const coordinator = new QuitCoordinator(
      async () => {
        cleanupCalls++;
      },
      () => {
        quitAgainCalls++;
      },
      () => {},
    );

    expect(await coordinator.beginUpdateRestart()).toBe(true);
    expect(cleanupCalls).toBe(1);
    expect(quitAgainCalls).toBe(0);
    expect(coordinator.updateRestartActive()).toBe(true);

    coordinator.approveUpdateRestart();
    await expect(coordinator.beginUpdateRestart()).resolves.toBe(false);
    expect(coordinator.armQuit()).toBe(false);

    // Non-signal quit during approved update restart is allowed without veto.
    let nonSignalVeto = 0;
    coordinator.handle(() => nonSignalVeto++, false);
    expect(nonSignalVeto).toBe(0);

    // A native signal overrides approved update restart and finishes ordinary quit without re-running cleanup.
    let signalVeto = 0;
    coordinator.handle(() => signalVeto++, true);
    await flushMicrotasks();

    expect(signalVeto).toBe(1);
    expect(cleanupCalls).toBe(1);
    expect(quitAgainCalls).toBe(1);
    expect(coordinator.updateRestartActive()).toBe(false);
    expect(coordinator.status().phase).toBe('ready');
  });

  test('clearUpdateRestart clears active update intent and updateRestartFailed records failure', async () => {
    const failures: Array<{ error: unknown; kind: 'quit' | 'update' }> = [];
    const coordinator = new QuitCoordinator(
      async () => {},
      () => {},
      (error, kind) => failures.push({ error, kind }),
    );

    expect(await coordinator.beginUpdateRestart()).toBe(true);
    expect(coordinator.updateRestartActive()).toBe(true);

    coordinator.clearUpdateRestart();
    expect(coordinator.updateRestartActive()).toBe(false);

    expect(await coordinator.beginUpdateRestart()).toBe(true);
    coordinator.approveUpdateRestart();
    coordinator.updateRestartFailed('Installer launch refused.');

    expect(coordinator.updateRestartActive()).toBe(false);
    expect(coordinator.status()).toEqual({
      attempt: 2,
      phase: 'failed',
      error: 'Installer launch refused.',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('update');
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect((failures[0]?.error as Error | undefined)?.message).toBe('Installer launch refused.');
  });

  test('beginUpdateRestart reports update failure and rethrows when cleanup fails', async () => {
    const failures: Array<{ error: unknown; kind: 'quit' | 'update' }> = [];
    const boom = new Error('shutdown boom');
    const coordinator = new QuitCoordinator(
      async () => {
        throw boom;
      },
      () => {},
      (error, kind) => failures.push({ error, kind }),
    );

    await expect(coordinator.beginUpdateRestart()).rejects.toThrow('shutdown boom');
    expect(coordinator.updateRestartActive()).toBe(false);
    expect(coordinator.status()).toEqual({
      attempt: 1,
      phase: 'failed',
      error:
        'Update cleanup failed. The app has not exited. Use Quit, then reopen the app to retry the update.',
    });
    expect(failures).toEqual([{ error: boom, kind: 'update' }]);
  });
});

describe('InteractiveQuitGate', () => {
  const makeQuitGate = (
    overrides: {
      lifecycle?: QuitCoordinator;
      quitAgain?: () => void;
      hasUnsavedRawConfig?: () => Promise<boolean> | undefined;
      confirmDiscardQuit?: () => Promise<boolean>;
      quit?: () => void;
      signalRequested?: () => boolean;
    } = {},
  ) => {
    const lifecycle =
      overrides.lifecycle ??
      new QuitCoordinator(
        async () => {},
        overrides.quitAgain ?? (() => {}),
        () => {},
      );
    const gate = new InteractiveQuitGate(
      lifecycle,
      overrides.hasUnsavedRawConfig ?? (() => Promise.resolve(false)),
      overrides.confirmDiscardQuit ?? (async () => false),
      overrides.quit ?? (() => {}),
      overrides.signalRequested,
    );
    return { lifecycle, gate };
  };

  test('signalRequested() true delegates immediately with signal override, bypassing draft prompt', async () => {
    let quitAgainCalls = 0;
    let checkedDraft = 0;
    let prompted = 0;
    const { lifecycle, gate } = makeQuitGate({
      quitAgain: () => {
        quitAgainCalls++;
      },
      hasUnsavedRawConfig: () => {
        checkedDraft++;
        return Promise.resolve(true);
      },
      confirmDiscardQuit: async () => {
        prompted++;
        return false;
      },
      signalRequested: () => true,
    });
    await lifecycle.beginUpdateRestart();
    lifecycle.approveUpdateRestart();

    let vetoCalls = 0;
    gate.handle(() => vetoCalls++);
    await flushMicrotasks();

    expect(vetoCalls).toBe(1);
    expect(checkedDraft).toBe(0);
    expect(prompted).toBe(0);
    expect(lifecycle.updateRestartActive()).toBe(false);
    expect(lifecycle.status().phase).toBe('ready');
    expect(quitAgainCalls).toBe(1);
  });

  test('bypasses draft check when lifecycle is non-idle, update restart is active, or check returns undefined', async () => {
    let quitAgainCalls = 0;
    let prompted = 0;
    const { lifecycle, gate } = makeQuitGate({
      quitAgain: () => {
        quitAgainCalls++;
      },
      hasUnsavedRawConfig: () => undefined,
      confirmDiscardQuit: async () => {
        prompted++;
        return false;
      },
    });

    let vetoCalls = 0;
    gate.handle(() => vetoCalls++);
    await flushMicrotasks();

    expect(vetoCalls).toBe(1);
    expect(prompted).toBe(0);
    expect(quitAgainCalls).toBe(1);
    expect(lifecycle.status().phase).toBe('ready');

    // Subsequent handle while phase !== 'idle' delegates straight to lifecycle (no veto when ready).
    let checked = 0;
    const { gate: gateAfterReady } = makeQuitGate({
      lifecycle,
      hasUnsavedRawConfig: () => {
        checked++;
        return Promise.resolve(true);
      },
    });
    let vetoAfterReady = 0;
    gateAfterReady.handle(() => vetoAfterReady++);
    expect(vetoAfterReady).toBe(0);
    expect(checked).toBe(0);

    // Approved update restart also bypasses draft check and lets native quit proceed unvetoed.
    let updateChecked = 0;
    const { lifecycle: updateLifecycle, gate: updateGate } = makeQuitGate({
      hasUnsavedRawConfig: () => {
        updateChecked++;
        return Promise.resolve(true);
      },
    });
    await updateLifecycle.beginUpdateRestart();
    updateLifecycle.approveUpdateRestart();
    let updateVeto = 0;
    updateGate.handle(() => updateVeto++);
    expect(updateChecked).toBe(0);
    expect(updateVeto).toBe(0);
  });

  test('clean raw config or rejected check quits immediately without confirmation prompt', async () => {
    for (const hasUnsavedRawConfig of [
      () => Promise.resolve(false),
      () => Promise.reject(new Error('rpc closed')),
    ]) {
      let prompted = 0;
      let quitCalls = 0;
      const { lifecycle, gate } = makeQuitGate({
        hasUnsavedRawConfig,
        confirmDiscardQuit: async () => {
          prompted++;
          return false;
        },
        quit: () => {
          quitCalls++;
        },
      });

      let vetoCalls = 0;
      gate.handle(() => vetoCalls++);
      await flushMicrotasks();

      expect(vetoCalls).toBe(1);
      expect(prompted).toBe(0);
      expect(quitCalls).toBe(1);
      expect(lifecycle.status().phase).toBe('pending');
    }
  });

  test('dirty raw config prompts for confirmation, cancels cleanly on reject, and dedupes concurrent calls', async () => {
    let confirmDeferred = deferred<boolean>();
    let promptCalls = 0;
    let quitCalls = 0;
    const { lifecycle, gate } = makeQuitGate({
      hasUnsavedRawConfig: () => Promise.resolve(true),
      confirmDiscardQuit: () => {
        promptCalls++;
        return confirmDeferred.promise;
      },
      quit: () => {
        quitCalls++;
      },
    });

    // Concurrent calls while prompt is pending are deduplicated.
    let veto1 = 0;
    let veto2 = 0;
    gate.handle(() => veto1++);
    gate.handle(() => veto2++);
    await flushMicrotasks();

    expect(veto1).toBe(1);
    expect(veto2).toBe(1);
    expect(promptCalls).toBe(1);
    expect(quitCalls).toBe(0);

    // User cancels discard: stays idle and clears pending so a later quit can prompt again.
    confirmDeferred.resolve(false);
    await flushMicrotasks();
    expect(quitCalls).toBe(0);
    expect(lifecycle.status().phase).toBe('idle');

    // Second attempt: user confirms discard.
    confirmDeferred = deferred<boolean>();
    gate.handle(() => {});
    await flushMicrotasks();
    expect(promptCalls).toBe(2);

    confirmDeferred.resolve(true);
    await flushMicrotasks();
    expect(quitCalls).toBe(1);
    expect(lifecycle.status().phase).toBe('pending');
  });
});

describe('native helpers', () => {
  test('installedIdentifier reads production and test identifiers from version.json', async () => {
    const prodDir = await makeTempDir();
    await writeFile(
      join(prodDir, 'version.json'),
      JSON.stringify({ identifier: PRODUCTION_IDENTIFIER }),
    );
    expect(installedIdentifier(prodDir)).toBe(PRODUCTION_IDENTIFIER);

    const testDir = await makeTempDir();
    await writeFile(join(testDir, 'version.json'), JSON.stringify({ identifier: TEST_IDENTIFIER }));
    expect(installedIdentifier(testDir)).toBe(TEST_IDENTIFIER);
  });

  test('installedIdentifier throws on missing, malformed, or unsupported version.json', async () => {
    const missingDir = await makeTempDir();
    expect(() => installedIdentifier(missingDir)).toThrow(
      "The app's version.json is missing or invalid.",
    );

    const invalidJsonDir = await makeTempDir();
    await writeFile(join(invalidJsonDir, 'version.json'), '{bad json');
    expect(() => installedIdentifier(invalidJsonDir)).toThrow(
      "The app's version.json is missing or invalid.",
    );

    const unknownIdDir = await makeTempDir();
    await writeFile(
      join(unknownIdDir, 'version.json'),
      JSON.stringify({ identifier: 'com.example.other' }),
    );
    expect(() => installedIdentifier(unknownIdDir)).toThrow(
      'Unsupported app identifier in version.json.',
    );
  });

  test('configurationDirectory resolves app support paths and validates configBase', () => {
    const base = '/Users/example/Library/Application Support';
    expect(configurationDirectory(base, PRODUCTION_IDENTIFIER)).toBe(join(base, 'MCP Gateway'));
    expect(configurationDirectory(base, TEST_IDENTIFIER)).toBe(join(base, 'MCP Gateway Test'));

    expect(() => configurationDirectory('relative/path', PRODUCTION_IDENTIFIER)).toThrow(
      'Configuration base must be an absolute path.',
    );
    expect(() => configurationDirectory('', TEST_IDENTIFIER)).toThrow(
      'Configuration base must be an absolute path.',
    );
    expect(() => configurationDirectory('/tmp/bad\0dir', PRODUCTION_IDENTIFIER)).toThrow(
      'Configuration base must be an absolute path.',
    );
  });

  test('postNativeNotification is a safe no-op when no native library is loaded and reports missing library errors', async () => {
    const errors: unknown[] = [];
    expect(() =>
      postNativeNotification('Title', 'Body', undefined, (error) => errors.push(error)),
    ).not.toThrow();
    expect(errors).toEqual([]);

    const dir = await makeTempDir();
    const missingLib = join(dir, 'nonexistent.dylib');
    expect(() =>
      postNativeNotification('Title', 'Body', missingLib, (error) => errors.push(error)),
    ).not.toThrow();
    expect(errors).toHaveLength(1);

    // Without onError callback, missing library still does not throw.
    expect(() => postNativeNotification('Title', 'Body', missingLib)).not.toThrow();
  });
});

describe('openKeychain', () => {
  let getSpy: ReturnType<typeof spyOn<typeof Bun.secrets, 'get'>> | undefined;
  let setSpy: ReturnType<typeof spyOn<typeof Bun.secrets, 'set'>> | undefined;

  afterEach(() => {
    getSpy?.mockRestore();
    getSpy = undefined;
    setSpy?.mockRestore();
    setSpy = undefined;
  });

  test('rejects empty secret value with GatewayError ConfigIO before touching Keychain', async () => {
    const dir = await makeTempDir();
    const missingDylib = join(dir, 'no-native.dylib');

    for (const identifier of [PRODUCTION_IDENTIFIER, TEST_IDENTIFIER]) {
      const keychain = openKeychain(identifier, missingDylib);

      for (const ref of ['', 'gateway.token']) {
        let thrown: unknown;
        try {
          await keychain.set(ref, '');
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(GatewayError);
        const gatewayError = thrown as GatewayError;
        expect(gatewayError.code).toBe('ConfigIO');
        expect(gatewayError.message).toBe('A key could not be stored in Keychain.');
      }
    }
  });

  test('get([]) resolves to an empty Map without accessing native FFI or Bun.secrets', async () => {
    const dir = await makeTempDir();
    const keychain = openKeychain(TEST_IDENTIFIER, join(dir, 'no-native.dylib'));

    const keys = await keychain.get([]);
    expect(keys).toBeInstanceOf(Map);
    expect(keys.size).toBe(0);
  });

  test('routes service name by identifier and reads/writes non-empty secrets via Bun.secrets fallback', async () => {
    const dir = await makeTempDir();
    const missingDylib = join(dir, 'no-native.dylib');
    const getCalls: Array<{ service: string; name: string }> = [];
    const setCalls: Array<{ service: string; name: string; value: string }> = [];

    getSpy = spyOn(Bun.secrets, 'get').mockImplementation(async ({ service, name }) => {
      getCalls.push({ service, name });
      return `secret-for-${name}`;
    });
    setSpy = spyOn(Bun.secrets, 'set').mockImplementation(async ({ service, name, value }) => {
      setCalls.push({ service, name, value });
    });

    const prodKeychain = openKeychain(PRODUCTION_IDENTIFIER, missingDylib);
    const prodSecrets = await prodKeychain.get(['gw-ref', 'srv-ref']);
    expect(prodSecrets).toEqual(
      new Map([
        ['gw-ref', 'secret-for-gw-ref'],
        ['srv-ref', 'secret-for-srv-ref'],
      ]),
    );
    await prodKeychain.set('gw-ref', 'super-secret-value');

    const testKeychain = openKeychain(TEST_IDENTIFIER, missingDylib);
    expect(await testKeychain.get(['gw-ref'])).toEqual(new Map([['gw-ref', 'secret-for-gw-ref']]));
    await testKeychain.set('gw-ref', 'test-secret-value');

    expect(getCalls).toEqual([
      { service: 'MCP Gateway APP', name: 'gw-ref' },
      { service: 'MCP Gateway APP', name: 'srv-ref' },
      { service: 'MCP Gateway APP Test', name: 'gw-ref' },
    ]);
    expect(setCalls).toEqual([
      { service: 'MCP Gateway APP', name: 'gw-ref', value: 'super-secret-value' },
      { service: 'MCP Gateway APP Test', name: 'gw-ref', value: 'test-secret-value' },
    ]);
  });

  test('rejects with fixed KeyUnavailable on missing/failed read and ConfigIO on failed write', async () => {
    const dir = await makeTempDir();
    const missingDylib = join(dir, 'no-native.dylib');
    const keychain = openKeychain(TEST_IDENTIFIER, missingDylib);

    getSpy = spyOn(Bun.secrets, 'get').mockResolvedValueOnce(null);
    await expectAsyncGatewayError(
      () => keychain.get(['missing-ref']),
      'KeyUnavailable',
      'A Keychain key could not be read.',
    );

    getSpy.mockRejectedValueOnce(new Error('keychain locked'));
    await expectAsyncGatewayError(
      () => keychain.get(['missing-ref']),
      'KeyUnavailable',
      'A Keychain key could not be read.',
    );

    setSpy = spyOn(Bun.secrets, 'set').mockRejectedValueOnce(new Error('write denied'));
    await expectAsyncGatewayError(
      () => keychain.set('gw-ref', 'super-secret-value'),
      'ConfigIO',
      'A key could not be stored in Keychain.',
    );
  });
});

describe('WindowRevealCoordinator', () => {
  const createFakeTimers = () => {
    let nextId = 1;
    let now = 0;
    const active = new Map<number, { dueAt: number; ms: number; callback: () => void }>();
    const scheduledDelays: number[] = [];
    const clearedIds: number[] = [];

    const timers: WindowRevealTimers<number> = {
      setTimeout: (callback, ms) => {
        const id = nextId++;
        scheduledDelays.push(ms);
        active.set(id, { dueAt: now + ms, ms, callback });
        return id;
      },
      clearTimeout: (handle) => {
        if (active.delete(handle)) clearedIds.push(handle);
      },
    };

    const advanceBy = (ms: number) => {
      now += ms;
      while (true) {
        let nextDue: [number, { dueAt: number; callback: () => void }] | undefined;
        for (const entry of active.entries()) {
          if (entry[1].dueAt <= now && (!nextDue || entry[1].dueAt < nextDue[1].dueAt)) {
            nextDue = entry;
          }
        }
        if (!nextDue) break;
        active.delete(nextDue[0]);
        nextDue[1].callback();
      }
    };

    return { timers, active, scheduledDelays, clearedIds, advanceBy };
  };

  test('starts hidden, suppresses reopen guard until revealed, and forwards once visible', () => {
    const fake = createFakeTimers();
    let revealCalls = 0;
    let restoreCalls = 0;
    const coordinator = new WindowRevealCoordinator(() => {
      revealCalls++;
    }, fake.timers);

    const openWindowGuard = () => {
      if (coordinator.isVisible()) restoreCalls++;
    };

    expect(coordinator.isReady()).toBe(false);
    expect(coordinator.isVisible()).toBe(false);
    expect(fake.scheduledDelays).toEqual([WINDOW_REVEAL_FALLBACK_MS]);

    openWindowGuard();
    expect(restoreCalls).toBe(0);

    coordinator.onSnapshotSettled();
    fake.advanceBy(WINDOW_REVEAL_DELAY_MS - 1);
    openWindowGuard();
    expect(revealCalls).toBe(0);
    expect(restoreCalls).toBe(0);

    fake.advanceBy(1);
    expect(revealCalls).toBe(1);
    expect(coordinator.isVisible()).toBe(true);

    openWindowGuard();
    expect(restoreCalls).toBe(1);
  });

  test('first onSnapshotSettled cancels fallback, reveals once after 50ms, and is idempotent', () => {
    const fake = createFakeTimers();
    let revealCalls = 0;
    const coordinator = new WindowRevealCoordinator(() => {
      revealCalls++;
    }, fake.timers);

    expect(fake.scheduledDelays).toEqual([WINDOW_REVEAL_FALLBACK_MS]);

    coordinator.onSnapshotSettled();
    expect(coordinator.isReady()).toBe(true);
    expect(coordinator.isVisible()).toBe(false);
    expect(fake.clearedIds).toEqual([1]);
    expect(fake.scheduledDelays).toEqual([WINDOW_REVEAL_FALLBACK_MS, WINDOW_REVEAL_DELAY_MS]);

    // Repeat calls must neither reschedule the timer nor double-reveal.
    coordinator.onSnapshotSettled();
    expect(fake.scheduledDelays).toEqual([WINDOW_REVEAL_FALLBACK_MS, WINDOW_REVEAL_DELAY_MS]);

    fake.advanceBy(WINDOW_REVEAL_DELAY_MS);
    expect(revealCalls).toBe(1);
    expect(coordinator.isVisible()).toBe(true);

    coordinator.onSnapshotSettled();
    fake.advanceBy(WINDOW_REVEAL_FALLBACK_MS * 2);
    expect(revealCalls).toBe(1);
  });

  test('fallback timer reveals once after 1500ms if snapshot never settles', () => {
    const fake = createFakeTimers();
    let revealCalls = 0;
    const coordinator = new WindowRevealCoordinator(() => {
      revealCalls++;
    }, fake.timers);

    fake.advanceBy(WINDOW_REVEAL_FALLBACK_MS - 1);
    expect(revealCalls).toBe(0);
    expect(coordinator.isVisible()).toBe(false);

    fake.advanceBy(1);
    expect(revealCalls).toBe(1);
    expect(coordinator.isVisible()).toBe(true);
    expect(coordinator.isReady()).toBe(false);

    // Late snapshot settlement marks ready without revealing a second time.
    coordinator.onSnapshotSettled();
    expect(coordinator.isReady()).toBe(true);
    fake.advanceBy(WINDOW_REVEAL_DELAY_MS * 2);
    expect(revealCalls).toBe(1);
  });

  test('dispose cancels pending fallback or post-snapshot delay timers so reveal never fires after close', () => {
    const fallbackFake = createFakeTimers();
    let fallbackReveals = 0;
    const beforeSnapshot = new WindowRevealCoordinator(() => {
      fallbackReveals++;
    }, fallbackFake.timers);

    beforeSnapshot.dispose();
    expect(fallbackFake.active.size).toBe(0);
    beforeSnapshot.onSnapshotSettled();
    fallbackFake.advanceBy(WINDOW_REVEAL_FALLBACK_MS * 2);
    expect(fallbackReveals).toBe(0);
    expect(beforeSnapshot.isVisible()).toBe(false);

    const delayFake = createFakeTimers();
    let delayReveals = 0;
    const afterSnapshot = new WindowRevealCoordinator(() => {
      delayReveals++;
    }, delayFake.timers);

    afterSnapshot.onSnapshotSettled();
    expect(delayFake.active.size).toBe(1);
    afterSnapshot.dispose();
    expect(delayFake.active.size).toBe(0);
    delayFake.advanceBy(WINDOW_REVEAL_FALLBACK_MS * 2);
    expect(delayReveals).toBe(0);
    expect(afterSnapshot.isVisible()).toBe(false);
  });
});
