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
import { emptyEditor } from '@mcp-gateway/mainview/effect-dialogs/server-editor-logic';
import { GatewayMutation } from '@mcp-gateway/mainview/effect-settings/services';

const makeSnapshot = (
  overrides: {
    revision?: string;
    running?: boolean;
    configText?: string;
    configError?: AppSnapshotRedacted['gateway']['configError'];
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
      configError: overrides.configError ?? null,
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

    // Opening updates modal activates the updates dialog
    story.send(AppMessage.OpenedUpdatesModal());
    assert.deepStrictEqual(story.model.activeModal, { kind: 'updates' });

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

  it('surfaces commit payload errors without throwing across CommittedGatewayMutation, DeleteServerConfirmed, and SubmittedServerEditor', () => {
    const story = Story.start(AppView, {});
    const invalidDiskSnap = makeSnapshot({
      configText: '{ invalid json',
      configError: { occurrenceId: 'cfg-1', code: 'InvalidConfig', message: 'Syntax error' },
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
        snapshot: invalidDiskSnap,
        errorKind: null,
        errorMessage: null,
      }),
    );

    const validDraft = JSON.stringify({
      gateway: { host: '127.0.0.1', port: 8787, token: 'a'.repeat(32) },
      mcpServers: {
        bear: { command: '/usr/bin/bear', args: ['mcp'] },
      },
    });
    story.send(
      AppMessage.ChangedDoc({
        doc: { text: Redacted.make(validDraft), revision: 'rev-1', dirty: true },
      }),
    );
    story.resolve(SyncUnsavedChecker, Component.noop);

    // 1. CommittedGatewayMutation surfaces model.error instead of throwing
    story.send(
      AppMessage.CommittedGatewayMutation({
        mutation: GatewayMutation.SetAutoStart({ value: true }),
      }),
    );
    assert.isFalse(story.model.busy);
    assert.isNotNull(story.model.error);

    // Clear error then check DeleteServerConfirmed
    story.send(AppMessage.DismissedError());
    assert.isNull(story.model.error);
    story.send(AppMessage.DeleteServerConfirmed({ name: 'bear', ok: true, confirmed: true }));
    assert.isFalse(story.model.busy);
    assert.isNotNull(story.model.error);

    // 3. SubmittedServerEditor surfaces model.editorError and keeps modal open
    story.send(AppMessage.OpenedServerEditor({ name: 'bear', bearPreset: false }));
    assert.strictEqual(story.model.activeModal?.kind, 'serverEditor');
    story.send(AppMessage.SubmittedServerEditor());
    assert.isFalse(story.model.busy);
    assert.strictEqual(story.model.activeModal?.kind, 'serverEditor');
    assert.isNotNull(story.model.editorError);
  });

  it('ignores concurrent gateway mutations while busy (single-flight guard)', () => {
    const story = Story.start(AppView, {});
    const snap = makeSnapshot({ revision: 'rev-1' });
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

    story.send(AppMessage.OpenedServerEditor({ name: 'bear', bearPreset: false }));
    story.send(AppMessage.RequestedStartGateway());
    assert.isTrue(story.model.busy);
    const busyGeneration = story.model.generation;
    story.keepPending(RunGatewayOperation);
    const pendingBefore = story.pending.length;

    story.send(AppMessage.RequestedStopGateway());
    story.send(AppMessage.RequestedSaveRawConfig());
    story.send(
      AppMessage.CommittedGatewayMutation({
        mutation: GatewayMutation.SetAutoStart({ value: true }),
      }),
    );
    story.send(AppMessage.SubmittedServerEditor());
    story.send(AppMessage.ToggledServer({ name: 'bear', disabled: true }));
    story.send(AppMessage.RequestedDeleteServer({ name: 'bear' }));
    story.send(AppMessage.RequestedDiscardRawConfig());

    assert.strictEqual(story.model.generation, busyGeneration);
    assert.strictEqual(story.pending.length, pendingBefore);
  });

  it('increments serverEditorOpenSeq, clears editorError, and resets activeModal.editor on server:add', () => {
    const story = Story.start(AppView, {});
    const snap = makeSnapshot({ revision: 'rev-1' });
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

    assert.strictEqual(story.model.serverEditorOpenSeq, 0);
    story.send(AppMessage.OpenedServerEditor({ name: 'bear', bearPreset: false }));
    assert.strictEqual(story.model.serverEditorOpenSeq, 1);
    assert.strictEqual(story.model.activeModal?.kind, 'serverEditor');
    if (story.model.activeModal?.kind === 'serverEditor') {
      assert.strictEqual(story.model.activeModal.editor.name, 'bear');
    }

    // Trigger a validation error while editing
    story.send(
      AppMessage.ChangedServerEditor({
        editor: { ...emptyEditor(), original: 'bear', name: '__proto__' },
      }),
    );
    story.send(AppMessage.SubmittedServerEditor());
    assert.isNotNull(story.model.editorError);

    // Menu command server:add increments serverEditorOpenSeq, clears editorError, and resets editor
    story.send(AppMessage.MenuCommandReceived({ command: 'server:add' }));
    assert.strictEqual(story.model.serverEditorOpenSeq, 2);
    assert.isNull(story.model.editorError);
    assert.strictEqual(story.model.activeModal?.kind, 'serverEditor');
    if (story.model.activeModal?.kind === 'serverEditor') {
      assert.deepStrictEqual(story.model.activeModal.editor, emptyEditor());
    }
  });

  it('prompts ConfirmDiscard on RequestedUpdateRestart when doc is dirty and handles cancel, confirm, and failure', () => {
    const story = Story.start(AppView, {});
    const snap = makeSnapshot({ revision: 'rev-1', updatePhase: 'ready' });
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

    // Open updates modal and make doc dirty
    story.send(AppMessage.OpenedUpdatesModal());
    assert.deepStrictEqual(story.model.activeModal, { kind: 'updates' });

    story.send(
      AppMessage.ChangedDoc({
        doc: { text: Redacted.make('{"dirty":true}'), revision: 'rev-1', dirty: true },
      }),
    );
    story.resolve(SyncUnsavedChecker, Component.noop);

    // 1. Cancel discard keeps modal open and does not start restart
    story.send(AppMessage.RequestedUpdateRestart());
    story.resolve(
      ConfirmDiscard,
      AppMessage.DiscardConfirmed({
        purpose: 'updateRestart',
        ok: true,
        confirmed: false,
        errorKind: null,
        errorMessage: null,
      }),
    );
    assert.isFalse(story.model.busy);
    assert.deepStrictEqual(story.model.activeModal, { kind: 'updates' });
    assert.isNull(story.model.error);

    // 2. Failure sets model.error
    story.send(AppMessage.RequestedUpdateRestart());
    story.resolve(
      ConfirmDiscard,
      AppMessage.DiscardConfirmed({
        purpose: 'updateRestart',
        ok: false,
        confirmed: false,
        errorKind: 'rpc',
        errorMessage: 'Confirm dialog unavailable',
      }),
    );
    assert.isFalse(story.model.busy);
    assert.strictEqual(story.model.error, 'Confirm dialog unavailable');

    // 3. Confirm closes updates modal and launches UpdatesRestart
    story.send(AppMessage.RequestedUpdateRestart());
    story.resolve(
      ConfirmDiscard,
      AppMessage.DiscardConfirmed({
        purpose: 'updateRestart',
        ok: true,
        confirmed: true,
        errorKind: null,
        errorMessage: null,
      }),
    );
    assert.isTrue(story.model.busy);
    assert.isNull(story.model.activeModal);
    story.resolve(
      RunGatewayOperation,
      AppMessage.GatewayOpFinished({
        ok: true,
        saved: false,
        draft: false,
        startedEditSeq: 1,
        submittedText: null,
        snapshot: null,
        importedCount: null,
        closeEditorOnSuccess: false,
        keyMigrationOp: false,
        errorKind: null,
        errorMessage: null,
      }),
    );
    assert.isFalse(story.model.busy);
  });
});
