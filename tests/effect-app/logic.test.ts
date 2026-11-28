import { assert, describe, it } from '@effect/vitest';
import { Redacted, Schema } from 'effect';

import {
  applyIncomingSnapshot,
  applyOperationSuccess,
  computeDerivedState,
  initialAppModel,
  planServerApply,
  resolveUpdatesRequest,
} from '@mcp-gateway/mainview/effect-app/logic';
import {
  AppModel,
  type AppSnapshotRedacted,
  toRedactedSnapshot,
} from '@mcp-gateway/mainview/effect-app/schemas';
import {
  createKeyValueRow,
  emptyEditor,
  ServerEditorStateSchema,
} from '@mcp-gateway/mainview/effect-dialogs/server-editor-logic';
import { translator } from '@mcp-gateway/shared/i18n';
import type { AppSnapshot } from '@mcp-gateway/shared/rpc';
import type { ConfigFile } from '@mcp-gateway/shared/types';

const t = translator('en_US');

const SECRET_SENTINEL = 'SUPER_SECRET_TOKEN_XYZ_9876543210';

const makeSnapshot = (
  overrides: {
    configText?: string;
    revision?: string;
    configError?: AppSnapshotRedacted['gateway']['configError'];
    operationalError?: AppSnapshotRedacted['gateway']['operationalError'];
    whatsNew?: string | null;
    updatePhase?: AppSnapshotRedacted['update']['phase'];
    updateSupported?: boolean;
  } = {},
): AppSnapshotRedacted =>
  toRedactedSnapshot({
    gateway: {
      configPath: '/Users/test/.mcp-gateway/mcp.json',
      configFormat: 'json',
      configText:
        overrides.configText ??
        JSON.stringify({
          gateway: { host: '127.0.0.1', port: 8787, token: SECRET_SENTINEL },
          mcpServers: {
            bear: { command: '/usr/bin/bear', args: ['mcp'] },
          },
        }),
      revision: overrides.revision ?? 'rev-1',
      running: false,
      interfaces: [{ name: 'lo0', address: '127.0.0.1', netmask: '255.0.0.0', kind: 'loopback' }],
      network: 'loopback',
      keyMigration: { gateway: true, servers: [] },
      servers: [],
      configError: overrides.configError ?? null,
      operationalError: overrides.operationalError ?? null,
    },
    login: { supported: true, enabled: false, error: null },
    update: {
      supported: overrides.updateSupported ?? true,
      automaticUpdates: true,
      installedVersion: '1.0.0',
      availableVersion: null,
      phase: overrides.updatePhase ?? 'idle',
      error: null,
      checkedAt: null,
    },
    whatsNew: overrides.whatsNew ?? null,
    keyReminder: false,
    language: {
      preference: 'system',

      locale: 'en_US',
      system: 'en_US',
      available: ['en_US', 'de_DE'],
    },
    appearance: 'system',
  } satisfies AppSnapshot);

describe('effect-app logic', () => {
  it('redacts configText, doc.text, and ServerEditor secrets during Schema.encodeSync', () => {
    const snap = makeSnapshot();
    const loaded = applyIncomingSnapshot(initialAppModel(), snap);
    const editorWithSecrets = {
      ...emptyEditor(),
      name: 'custom',
      token: Redacted.make('CUSTOM_SERVER_SECRET_1111'),
      env: [createKeyValueRow('API_KEY', 'ENV_SECRET_2222', true)],
      headers: [createKeyValueRow('Authorization', 'Bearer HEADER_SECRET_3333', true)],
    };
    const modelWithSecrets = {
      ...loaded,
      activeModal: { kind: 'serverEditor' as const, editor: editorWithSecrets },
    };

    const encodedApp = JSON.stringify(Schema.encodeSync(AppModel)(modelWithSecrets));
    assert.isFalse(encodedApp.includes(SECRET_SENTINEL));
    assert.isFalse(encodedApp.includes('CUSTOM_SERVER_SECRET_1111'));
    assert.isFalse(encodedApp.includes('ENV_SECRET_2222'));
    assert.isFalse(encodedApp.includes('HEADER_SECRET_3333'));

    const encodedEditor = JSON.stringify(
      Schema.encodeSync(ServerEditorStateSchema)(editorWithSecrets),
    );
    assert.isFalse(encodedEditor.includes('CUSTOM_SERVER_SECRET_1111'));
    assert.isFalse(encodedEditor.includes('ENV_SECRET_2222'));
    assert.isFalse(encodedEditor.includes('HEADER_SECRET_3333'));
  });

  it('does not clobber doc on incoming snapshot when dirty, editing a server, or editSequence advanced', () => {
    const snap1 = makeSnapshot({ revision: 'rev-1' });
    const snap2 = makeSnapshot({ revision: 'rev-2', configText: '{"gateway":{},"mcpServers":{}}' });

    const base = applyIncomingSnapshot(initialAppModel(), snap1);
    assert.strictEqual(base.doc?.revision, 'rev-1');

    // Dirty doc preserved
    const dirtyModel = {
      ...base,
      doc: { text: Redacted.make('dirty-draft'), revision: 'rev-1', dirty: true },
    };
    const afterDirtySnap = applyIncomingSnapshot(dirtyModel, snap2);
    assert.strictEqual(afterDirtySnap.snapshot?.gateway.revision, 'rev-2');
    assert.isNotNull(afterDirtySnap.doc);
    if (afterDirtySnap.doc) {
      assert.strictEqual(Redacted.value(afterDirtySnap.doc.text), 'dirty-draft');
    }
    assert.isTrue(computeDerivedState(afterDirtySnap, '').stale);

    // Server editor open preserves doc
    const editingModel = {
      ...base,
      activeModal: { kind: 'serverEditor' as const, editor: emptyEditor() },
    };
    const afterEditingSnap = applyIncomingSnapshot(editingModel, snap2);
    assert.strictEqual(afterEditingSnap.doc?.revision, 'rev-1');

    // Stale startedEditSeq preserves doc
    const editedModel = { ...base, editSequence: 3 };
    const afterStaleSnap = applyIncomingSnapshot(editedModel, snap2, 2);
    assert.strictEqual(afterStaleSnap.doc?.revision, 'rev-1');
  });

  it('preserves concurrent user edits during applyOperationSuccess', () => {
    const snap1 = makeSnapshot({ revision: 'rev-1' });
    const snap2 = makeSnapshot({
      revision: 'rev-2',
      configText: JSON.stringify({
        gateway: { host: '127.0.0.1', port: 9000, token: SECRET_SENTINEL },
        mcpServers: {},
      }),
    });
    const base = applyIncomingSnapshot(initialAppModel(), snap1);
    assert.isNotNull(base.doc);
    if (!base.doc) return;
    const submittedText = base.doc.text;

    // Matching editSequence + text clears dirty and replaces doc
    const clean = applyOperationSuccess(base, snap2, {
      saved: true,
      startedEditSeq: 0,
      submittedText,
    });
    assert.strictEqual(clean.doc?.dirty, false);
    assert.strictEqual(clean.doc?.revision, 'rev-2');

    // Concurrent edit while save was in flight keeps user's draft text and updates revision
    const concurrent = {
      ...base,
      editSequence: 1,
      doc: { text: Redacted.make('user-typed-more'), revision: 'rev-1', dirty: true },
    };
    const preserved = applyOperationSuccess(concurrent, snap2, {
      saved: true,
      startedEditSeq: 0,
      submittedText,
    });
    assert.isNotNull(preserved.doc);
    if (preserved.doc) {
      assert.strictEqual(Redacted.value(preserved.doc.text), 'user-typed-more');
      assert.strictEqual(preserved.doc.revision, 'rev-2');
      assert.isTrue(preserved.doc.dirty);
    }
  });

  it('keeps form config open on KeyUnavailable, hides dismissed operationalError, and resolves updates deferral', () => {
    const keyUnavailSnap = makeSnapshot({
      configError: { occurrenceId: 'err-1', code: 'KeyUnavailable', message: 'Keychain locked' },
      operationalError: { occurrenceId: 'op-1', code: 'BackendFailure', message: 'Boom' },
      whatsNew: '1.0.0',
    });
    const model = applyIncomingSnapshot(initialAppModel(), keyUnavailSnap);
    const changelog = '## [1.0.0] - 2026-01-01\n\n- Initial release\n';
    const derived = computeDerivedState(model, changelog);
    assert.isNotNull(derived.config);
    assert.strictEqual(derived.operationalError?.occurrenceId, 'op-1');
    assert.isTrue(derived.whatsNewPending);
    assert.isTrue(derived.competingDialog);
    assert.isTrue(derived.updatesTriggerDisabled);

    // Requesting updates while whatsNew is open defers opening
    const deferred = resolveUpdatesRequest({ ...model, updatesRequested: true }, changelog);
    assert.isNull(deferred.model.activeModal);
    assert.isTrue(deferred.model.updatesRequested);
    assert.isFalse(deferred.focusUpdatesTrigger);

    // Closing whatsNew opens the deferred updates modal and requests trigger focus
    const opened = resolveUpdatesRequest({ ...deferred.model, whatsNewClosed: true }, changelog);
    assert.deepStrictEqual(opened.model.activeModal, { kind: 'updates' });
    assert.isFalse(opened.model.updatesRequested);
    assert.isTrue(opened.focusUpdatesTrigger);

    // InvalidConfig hides form config when doc is clean
    const invalidSnap = makeSnapshot({
      configError: { occurrenceId: 'err-2', code: 'InvalidConfig', message: 'Bad JSON' },
    });
    const invalidDerived = computeDerivedState(
      applyIncomingSnapshot(initialAppModel(), invalidSnap),
      changelog,
    );
    assert.isNull(invalidDerived.config);
  });

  it('validates and plans server edits cleanly', () => {
    const config: ConfigFile = {
      gateway: { host: '127.0.0.1', port: 8787, token: SECRET_SENTINEL },
      mcpServers: {
        bear: { command: '/usr/bin/bear' },
      },
    };

    const badName = planServerApply({ ...emptyEditor(), name: '__proto__' }, config, t);
    assert.isFalse(badName.ok);

    const dupName = planServerApply({ ...emptyEditor(), name: 'bear', command: 'x' }, config, t);
    assert.isFalse(dupName.ok);
    if (!dupName.ok) assert.strictEqual(dupName.error, t('app.serverExists'));

    const emptyCustomKey = planServerApply(
      { ...emptyEditor(), name: 'notes', command: 'x', token: Redacted.make('') },
      config,
      t,
    );
    assert.isFalse(emptyCustomKey.ok);
    if (!emptyCustomKey.ok) assert.strictEqual(emptyCustomKey.error, t('app.serverKeyEmpty'));

    const validRename = planServerApply(
      {
        ...emptyEditor(),
        original: 'bear',
        name: 'bear-v2',
        command: '/usr/bin/bear',
        args: ['--mcp'],
        env: [createKeyValueRow('API_KEY', 'secret-val', true)],
        legacyProtocol: false,
      },
      config,
      t,
    );
    assert.isTrue(validRename.ok);
    if (validRename.ok) {
      assert.deepStrictEqual(validRename.rename, { from: 'bear', to: 'bear-v2' });
      assert.isUndefined(validRename.nextConfig.mcpServers.bear);
      assert.isDefined(validRename.nextConfig.mcpServers['bear-v2']);
    }
  });
});
