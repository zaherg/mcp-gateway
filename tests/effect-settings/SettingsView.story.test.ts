import { Component } from '@effect/ui';
import { Story } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';

import {
  ChangeAppearance,
  ChangeLanguage,
  CommitGatewayMutation,
  GenerateAndCommitToken,
  ImportExternalServers,
  SettingsMessage,
  type SettingsProps,
  SettingsView,
} from '@mcp-gateway/mainview/effect-settings/SettingsView';
import { GatewayMutation } from '@mcp-gateway/mainview/effect-settings/services';

const defaultProps: typeof SettingsProps.Type = {
  locale: 'en_US',
  filename: 'mcp.json',
  hasSnapshot: true,
  dirty: false,
  busy: false,
  configurationLocked: false,
  showToken: false,
  error: null,
  operationalError: null,
  revision: 'rev-1',
  appearance: 'system',
  languagePreference: 'system',
  availableLanguages: ['en_US', 'fr_FR'],
  login: { supported: true, enabled: false, error: null },
  retryLogin: false,
  interfaces: [
    { name: 'lo0', address: '127.0.0.1', kind: 'loopback' },
    { name: 'en0', address: '192.168.1.25', kind: 'lan' },
  ],
  hasMovableKeys: true,
  savedConfig: {
    host: '127.0.0.1',
    port: 8787,
    allowedPeers: ['192.168.1.0/24'],
    token: 'b'.repeat(64),
    tokenRef: null,
    launchAtLogin: false,
    autoStart: false,
    keepAwake: false,
  },
};

describe('SettingsView Story tests', () => {
  it('initializes drafts from savedConfig, commits only changed fields, and resyncs on revision updates', () => {
    const story = Story.start(SettingsView, defaultProps);
    assert.strictEqual(story.model.hostInput, '127.0.0.1');
    assert.strictEqual(story.model.portInput, '8787');
    assert.strictEqual(story.model.peersText, '192.168.1.0/24');

    // Committing unchanged values dispatches no commands.
    story
      .send(SettingsMessage.CommittedHost())
      .expectNone()
      .send(SettingsMessage.CommittedPort())
      .expectNone()
      .send(SettingsMessage.CommittedPeers())
      .expectNone();

    // Editing and committing host, port, and peers emits exact GatewayMutations.
    story
      .send(SettingsMessage.ChangedHost({ value: '192.168.1.25' }))
      .send(SettingsMessage.CommittedHost())
      .expectExact(
        CommitGatewayMutation.make({
          mutation: GatewayMutation.SetHost({ host: '192.168.1.25' }),
        }),
      )
      .resolve(CommitGatewayMutation, Component.noop);

    story
      .send(SettingsMessage.ChangedPeers({ value: ', ,' }))
      .send(SettingsMessage.CommittedPeers())
      .expectExact(
        CommitGatewayMutation.make({
          mutation: GatewayMutation.SetAllowedPeers({ allowedPeers: [] }),
        }),
      )
      .resolve(CommitGatewayMutation, Component.noop);

    story
      .send(SettingsMessage.ChangedPeers({ value: '   ' }))
      .send(SettingsMessage.CommittedPeers())
      .expectExact(
        CommitGatewayMutation.make({
          mutation: GatewayMutation.SetAllowedPeers({ allowedPeers: null }),
        }),
      )
      .resolve(CommitGatewayMutation, Component.noop);

    story.send(
      SettingsMessage.SyncedSavedConfig({
        hostInput: '10.0.0.5',
        portInput: '9090',
        peersText: '10.0.0.0/24',
        tokenInput: 'c'.repeat(64),
      }),
    );
    assert.strictEqual(story.model.hostInput, '10.0.0.5');
    assert.strictEqual(story.model.portInput, '9090');
    assert.strictEqual(story.model.peersText, '10.0.0.0/24');
    assert.strictEqual(story.model.tokenInput, 'c'.repeat(64));
  });

  it('ignores invalid appearance/language preferences and locked mutations', () => {
    const story = Story.start(SettingsView, defaultProps);
    story
      .send(SettingsMessage.ChangedAppearance({ value: 'sepia' }))
      .expectNone()
      .send(SettingsMessage.ChangedLanguage({ value: 'zz_ZZ' }))
      .expectNone()
      .send(SettingsMessage.ChangedAppearance({ value: 'dark' }))
      .expectExact(ChangeAppearance.make({ preference: 'dark' }))
      .resolve(ChangeAppearance, Component.noop)
      .send(SettingsMessage.ChangedLanguage({ value: 'fr_FR' }))
      .expectExact(ChangeLanguage.make({ preference: 'fr_FR' }))
      .resolve(ChangeLanguage, Component.noop);

    const lockedStory = Story.start(SettingsView, { ...defaultProps, configurationLocked: true });
    lockedStory
      .send(SettingsMessage.ToggledKeepAwake({ checked: true }))
      .expectNone()
      .send(SettingsMessage.ClickedGenerateToken())
      .expectNone()
      .send(SettingsMessage.ClickedImportExternalServers())
      .expectNone();
  });

  it('explores interleaved draft edits, token generation, revision resyncs, and imports', () => {
    const generated = 'e'.repeat(64);
    const explored = Story.explore(SettingsView, defaultProps, {
      messages: [
        SettingsMessage.ChangedHost({ value: '192.168.1.25' }),
        SettingsMessage.ClickedGenerateToken(),
        SettingsMessage.ClickedImportExternalServers(),
        SettingsMessage.SyncedSavedConfig({
          hostInput: '127.0.0.1',
          portInput: '8787',
          peersText: '192.168.1.0/24',
          tokenInput: 'b'.repeat(64),
        }),
      ],
      commands: [
        [
          GenerateAndCommitToken,
          { success: () => [SettingsMessage.GeneratedToken({ token: generated })] },
        ],
        [
          ImportExternalServers,
          {
            success: () => [
              SettingsMessage.ImportExternalServersCompleted({ count: 2 }),
              SettingsMessage.ImportExternalServersCompleted({ count: 0 }),
              SettingsMessage.ImportExternalServersCompleted({ count: null }),
            ],
          },
        ],
      ],
      depth: 4,
      transition: ({ before, message, after }) => {
        if (message._tag === 'GeneratedToken') {
          assert.strictEqual(after.tokenInput, generated);
        }
        if (message._tag === 'ImportExternalServersCompleted') {
          if (message.count === null) {
            assert.strictEqual(after.importStatus, before.importStatus);
          } else if (message.count === 0) {
            assert.strictEqual(
              after.importStatus,
              'No new servers found in Claude Desktop or Cursor.',
            );
          } else {
            assert.strictEqual(
              after.importStatus,
              `Imported ${message.count} servers from Claude Desktop / Cursor.`,
            );
          }
        }
      },
      invariant: ({ pending }) => {
        // ImportExternalServers runs in switch mode: never more than one in flight.
        const activeImports = pending.filter(
          (item) => item.command.name === ImportExternalServers.name,
        );
        assert.isAtMost(activeImports.length, 1);
      },
    });
    assert.isAbove(explored.states, 10);
  });
});
