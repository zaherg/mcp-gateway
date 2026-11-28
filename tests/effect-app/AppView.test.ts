import { Component } from '@effect/ui';
import { Story } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Redacted } from 'effect';

import {
  AppMessage,
  AppView,
  BootstrapWindow,
  ConfirmDeleteServer,
  ConfirmDiscard,
  DismissWhatsNew,
  LoadInitialSnapshot,
  ReloadSnapshotFromMenu,
  RunGatewayOperation,
  RunUpdateOperation,
  SyncUnsavedChecker,
  SyncWindowDom,
} from '@mcp-gateway/mainview/effect-app/AppView';
import {
  type AppSnapshotRedacted,
  toRedactedSnapshot,
} from '@mcp-gateway/mainview/effect-app/schemas';

const makeSnapshot = (
  overrides: {
    revision?: string;
    running?: boolean;
    configText?: string;
    updatePhase?: AppSnapshotRedacted['update']['phase'];
    operationalError?: AppSnapshotRedacted['gateway']['operationalError'];
    whatsNew?: string | null;
  } = {},
): AppSnapshotRedacted =>
  toRedactedSnapshot({
    gateway: {
      configPath: '/Users/test/.mcp-gateway/mcp.json',
      configFormat: 'json',
      configText:
        overrides.configText ??
        JSON.stringify({
          gateway: { host: '127.0.0.1', port: 8787, token: 'a'.repeat(32) },
          mcpServers: {
            bear: { command: '/usr/bin/bear', args: ['mcp'] },
          },
        }),
      revision: overrides.revision ?? 'rev-1',
      running: overrides.running ?? false,
      interfaces: [{ name: 'lo0', address: '127.0.0.1', netmask: '255.0.0.0', kind: 'loopback' }],
      network: 'loopback',
      keyMigration: { gateway: true, servers: [] },
      servers: [],
      configError: null,
      operationalError: overrides.operationalError ?? null,
    },
    login: { supported: true, enabled: false, error: null },
    update: {
      supported: true,
      automaticUpdates: true,
      installedVersion: '1.0.0',
      availableVersion: null,
      phase: overrides.updatePhase ?? 'idle',
      error: null,
      checkedAt: null,
    },
    whatsNew: overrides.whatsNew ?? null,
    keyReminder: false,
    language: { preference: 'system', locale: 'en_US', system: 'en_US', available: ['en_US'] },
    appearance: 'system',
  });

describe('AppView Story tests', () => {
  it('loads initial snapshot, handles menu commands, and syncs unsaved checker on dirty edits', () => {
    const story = Story.start(AppView, {});
    const snap1 = makeSnapshot({ revision: 'rev-1' });

    story.resolve(
      BootstrapWindow,
      AppMessage.Bootstrapped({ locale: 'en_US', title: 'MCP Gateway' }),
    );
    story.resolve(SyncUnsavedChecker, Component.noop);
    story.resolve(
      LoadInitialSnapshot,
      AppMessage.InitialSnapshotLoaded({
        startedGeneration: 0,
        startedEditSeq: 0,
        ok: true,
        snapshot: snap1,
        errorKind: null,
        errorMessage: null,
      }),
    );

    assert.strictEqual(story.model.snapshot?.gateway.revision, 'rev-1');
    assert.strictEqual(story.model.doc?.revision, 'rev-1');
    assert.isFalse(story.model.doc?.dirty);

    // Menu command tab:raw-config switches to settings and opens raw panel
    story.send(AppMessage.MenuCommandReceived({ command: 'tab:raw-config' }));
    assert.strictEqual(story.model.tab, 'settings');
    assert.isTrue(story.model.rawOpen);
    story.resolve(SyncWindowDom, Component.noop);

    // Editing doc marks dirty and updates unsaved checker
    story.send(
      AppMessage.ChangedDoc({
        doc: { text: Redacted.make('{"edited":true}'), revision: 'rev-1', dirty: true },
      }),
    );
    assert.isTrue(story.model.doc?.dirty);
    story.resolve(SyncUnsavedChecker, Component.noop);

    // Menu gateway:reload prompts confirmDiscard when dirty
    story.send(AppMessage.MenuCommandReceived({ command: 'gateway:reload' }));
    story.resolve(
      ConfirmDiscard,
      AppMessage.DiscardConfirmed({
        purpose: 'reloadMenu',
        ok: true,
        confirmed: true,
        errorKind: null,
        errorMessage: null,
      }),
    );
    const snap2 = makeSnapshot({ revision: 'rev-2' });
    story.resolve(
      ReloadSnapshotFromMenu,
      AppMessage.ReloadFromMenuFinished({ ok: true, snapshot: snap2 }),
    );
    story.resolve(SyncUnsavedChecker, Component.noop);
    assert.strictEqual(story.model.doc?.revision, 'rev-2');
    assert.isFalse(story.model.doc?.dirty);
  });

  it('handles server delete confirmation, operational error dismissal, updates, and WhatsNew dismissal', () => {
    const story = Story.start(AppView, {});
    const snap = makeSnapshot({
      operationalError: { occurrenceId: 'op-42', code: 'BackendFailure', message: 'Failed' },
    });
    story.resolve(
      BootstrapWindow,
      AppMessage.Bootstrapped({ locale: 'en_US', title: 'MCP Gateway' }),
    );
    story.resolve(SyncUnsavedChecker, Component.noop);
    story.resolve(
      LoadInitialSnapshot,
      AppMessage.InitialSnapshotLoaded({
        startedGeneration: 0,
        startedEditSeq: 0,
        ok: true,
        snapshot: snap,
        errorKind: null,
        errorMessage: null,
      }),
    );

    // Dismiss operational error remembers occurrenceId
    story.send(AppMessage.DismissedOperationalError());
    assert.strictEqual(story.model.dismissedOpErrorId, 'op-42');

    // Request delete server -> confirm -> saveConfig
    story.send(AppMessage.RequestedDeleteServer({ name: 'bear' }));
    story.resolve(
      ConfirmDeleteServer,
      AppMessage.DeleteServerConfirmed({ name: 'bear', ok: true, confirmed: true }),
    );
    assert.isTrue(story.model.busy);
    story.resolve(
      RunGatewayOperation,
      AppMessage.GatewayOpFinished({
        ok: true,
        saved: true,
        draft: true,
        startedEditSeq: 0,
        submittedText: snap.gateway.configText,
        snapshot: makeSnapshot({ revision: 'rev-2' }),
        importedCount: null,
        closeEditorOnSuccess: false,
        keyMigrationOp: false,
        errorKind: null,
        errorMessage: null,
      }),
    );
    assert.isFalse(story.model.busy);
    assert.strictEqual(story.model.doc?.revision, 'rev-2');

    // Opening updates modal focuses updates trigger and runs check on demand
    story.send(AppMessage.OpenedUpdatesModal());
    assert.deepStrictEqual(story.model.activeModal, { kind: 'updates' });
    story.resolve(SyncWindowDom, Component.noop);

    story.send(AppMessage.RequestedUpdateCheck());
    assert.isTrue(story.model.updateBusy);
    story.resolve(
      RunUpdateOperation,
      AppMessage.UpdateOpFinished({
        ok: true,
        update: { ...snap.update, phase: 'restarting' },
        errorKind: null,
        errorMessage: null,
      }),
    );
    // Restarting phase automatically closes the updates modal and locks configuration
    assert.isFalse(story.model.updateBusy);
    assert.isNull(story.model.activeModal);

    // Closing WhatsNew dispatches DismissWhatsNew command
    story.send(AppMessage.ClosedWhatsNew());
    assert.isTrue(story.model.whatsNewClosed);
    story.resolve(DismissWhatsNew, Component.noop);
  });
});
