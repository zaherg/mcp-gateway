import { MessageLog } from '@effect/ui';
import { Story } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Redacted, Schema } from 'effect';

import {
  GenerateSettingsToken,
  SettingsEvent,
  SettingsMessage,
  SettingsModel,
  SettingsProps,
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
    token: Redacted.make('b'.repeat(64)),
    tokenRef: null,
    launchAtLogin: false,
    autoStart: false,
    keepAwake: false,
  },
  lastImport: null,
};

describe('SettingsView Story tests', () => {
  it('initializes drafts from savedConfig, emits only changed mutations, and resyncs on SyncedSavedConfig', () => {
    const story = Story.start(SettingsView, defaultProps);
    assert.strictEqual(story.model.hostInput, '127.0.0.1');
    assert.strictEqual(story.model.portInput, '8787');
    assert.strictEqual(story.model.peersText, '192.168.1.0/24');

    // Committing unchanged values emits nothing.
    story
      .send(SettingsMessage.CommittedHost())
      .expectNone()
      .send(SettingsMessage.CommittedPort())
      .expectNone()
      .send(SettingsMessage.CommittedPeers())
      .expectNone();

    // Editing and committing host and peers emits exact GatewayMutations.
    story
      .send(SettingsMessage.ChangedHost({ value: '192.168.1.25' }))
      .send(SettingsMessage.CommittedHost())
      .emitted(
        SettingsEvent.CommittedGatewayMutation({
          mutation: GatewayMutation.SetHost({ host: '192.168.1.25' }),
        }),
      );

    story
      .send(SettingsMessage.ChangedPeers({ value: ', ,' }))
      .send(SettingsMessage.CommittedPeers())
      .emitted(
        SettingsEvent.CommittedGatewayMutation({
          mutation: GatewayMutation.SetAllowedPeers({ allowedPeers: [] }),
        }),
      );

    story
      .send(SettingsMessage.ChangedPeers({ value: '   ' }))
      .send(SettingsMessage.CommittedPeers())
      .emitted(
        SettingsEvent.CommittedGatewayMutation({
          mutation: GatewayMutation.SetAllowedPeers({ allowedPeers: null }),
        }),
      );

    story.props({
      ...defaultProps,
      revision: 'rev-2',
      savedConfig: {
        host: '10.0.0.5',
        port: 9090,
        allowedPeers: ['10.0.0.0/24'],
        token: Redacted.make('c'.repeat(64)),
        tokenRef: null,
        launchAtLogin: false,
        autoStart: false,
        keepAwake: false,
      },
    });
    story.send(SettingsMessage.SyncedSavedConfig());
    assert.strictEqual(story.model.hostInput, '10.0.0.5');
    assert.strictEqual(story.model.portInput, '9090');
    assert.strictEqual(story.model.peersText, '10.0.0.0/24');
    assert.strictEqual(Redacted.value(story.model.tokenInput), 'c'.repeat(64));
  });

  it('ignores invalid appearance/language preferences and locked mutations', () => {
    const story = Story.start(SettingsView, defaultProps);
    story
      .send(SettingsMessage.ChangedAppearance({ value: 'sepia' }))
      .expectNone()
      .send(SettingsMessage.ChangedLanguage({ value: 'zz_ZZ' }))
      .expectNone()
      .send(SettingsMessage.ChangedAppearance({ value: 'dark' }))
      .emitted(SettingsEvent.ChangedAppearance({ preference: 'dark' }))
      .send(SettingsMessage.ChangedLanguage({ value: 'fr_FR' }))
      .emitted(SettingsEvent.ChangedLanguage({ preference: 'fr_FR' }));

    const lockedStory = Story.start(SettingsView, { ...defaultProps, configurationLocked: true });
    lockedStory
      .send(SettingsMessage.ToggledKeepAwake({ checked: true }))
      .expectNone()
      .send(SettingsMessage.ClickedGenerateToken())
      .expectNone()
      .send(SettingsMessage.ClickedImportExternalServers())
      .expectNone();
  });

  it('dispatches GenerateSettingsToken command and emits ReplaceTokenWithLiteral deterministically', () => {
    const story = Story.start(SettingsView, defaultProps);
    const deterministicToken = Redacted.make('f'.repeat(64));
    story
      .send(SettingsMessage.ClickedGenerateToken())
      .expectExact(GenerateSettingsToken.make())
      .resolve(GenerateSettingsToken, SettingsMessage.GeneratedToken({ token: deterministicToken }))
      .emitted(
        SettingsEvent.CommittedGatewayMutation({
          mutation: GatewayMutation.ReplaceTokenWithLiteral({ token: deterministicToken }),
        }),
      );
    assert.strictEqual(Redacted.value(story.model.tokenInput), 'f'.repeat(64));
  });

  it('redacts token values across Props, Model, Messages, Events, and GatewayMutation wire frames', () => {
    const secret = 'secret-token-value-must-never-leak-in-devtools';
    const redactedSecret = Redacted.make(secret);
    const encodeRedacted = (schema: Schema.Top, value: unknown) =>
      JSON.stringify(
        Schema.encodeUnknownSync(MessageLog.redactSchema(schema) as Schema.Codec<unknown>)(value),
      );

    const encodedProps = encodeRedacted(SettingsProps, {
      ...defaultProps,
      savedConfig: {
        host: '127.0.0.1',
        port: 8787,
        allowedPeers: ['192.168.1.0/24'],
        token: redactedSecret,
        tokenRef: null,
        launchAtLogin: false,
        autoStart: false,
        keepAwake: false,
      },
    });
    const encodedModel = encodeRedacted(SettingsModel, {
      hostInput: '127.0.0.1',
      portInput: '8787',
      peersText: '',
      tokenInput: redactedSecret,
      initialImportSeq: null,
    });
    const encodedMessage = encodeRedacted(
      SettingsMessage,
      SettingsMessage.ChangedToken({ value: redactedSecret }),
    );
    const encodedGeneratedMessage = encodeRedacted(
      SettingsMessage,
      SettingsMessage.GeneratedToken({ token: redactedSecret }),
    );
    const encodedEvent = encodeRedacted(
      SettingsEvent,
      SettingsEvent.CommittedGatewayMutation({
        mutation: GatewayMutation.SetToken({ token: redactedSecret }),
      }),
    );
    const encodedMutations = [
      GatewayMutation.SetToken({ token: redactedSecret }),
      GatewayMutation.ReplaceTokenWithLiteral({ token: redactedSecret }),
    ].map((mut) => encodeRedacted(GatewayMutation, mut));

    for (const payload of [
      encodedProps,
      encodedModel,
      encodedMessage,
      encodedGeneratedMessage,
      encodedEvent,
      ...encodedMutations,
    ]) {
      assert.notInclude(payload, secret);
      assert.include(payload, '"~redacted":true');
    }
  });

  it('boundedly explores settings edits, commits, preferences, and resync while preserving token redaction', () => {
    const savedSecret = 'b'.repeat(64);
    const typedSecret = 'settings-typed-secret-never-leak-12345';
    const generatedSecret = 'settings-generated-secret-never-leak-67890';
    const encodeModel = Schema.encodeUnknownSync(
      MessageLog.redactSchema(SettingsModel) as Schema.Codec<unknown>,
    );
    const encodeEvent = Schema.encodeUnknownSync(
      MessageLog.redactSchema(SettingsEvent) as Schema.Codec<unknown>,
    );

    const explored = Story.explore(SettingsView, defaultProps, {
      messages: [
        SettingsMessage.ChangedHost({ value: '192.168.1.25' }),
        SettingsMessage.CommittedHost(),
        SettingsMessage.ChangedPort({ value: '9090' }),
        SettingsMessage.CommittedPort(),
        SettingsMessage.ChangedPeers({ value: '10.0.0.0/24' }),
        SettingsMessage.CommittedPeers(),
        SettingsMessage.ChangedToken({ value: Redacted.make(typedSecret) }),
        SettingsMessage.CommittedToken(),
        SettingsMessage.ClickedGenerateToken(),
        SettingsMessage.ChangedAppearance({ value: 'dark' }),
        SettingsMessage.ChangedLanguage({ value: 'fr_FR' }),
        SettingsMessage.SyncedSavedConfig(),
      ],
      commands: [
        [
          GenerateSettingsToken,
          {
            success: () => [
              SettingsMessage.GeneratedToken({ token: Redacted.make(generatedSecret) }),
            ],
          },
        ],
      ],
      depth: 2,
      invariant: ({ model, emitted }) => {
        const serialized = JSON.stringify(encodeModel(model));
        assert.notInclude(serialized, savedSecret);
        assert.notInclude(serialized, typedSecret);
        assert.notInclude(serialized, generatedSecret);
        for (const event of emitted) {
          const serializedEvent = JSON.stringify(encodeEvent(event));
          assert.notInclude(serializedEvent, savedSecret);
          assert.notInclude(serializedEvent, typedSecret);
          assert.notInclude(serializedEvent, generatedSecret);
        }
      },
      transition: ({ message, after }) => {
        if (message._tag === 'SyncedSavedConfig') {
          assert.strictEqual(after.hostInput, defaultProps.savedConfig?.host);
          assert.strictEqual(after.portInput, String(defaultProps.savedConfig?.port));
          assert.strictEqual(Redacted.value(after.tokenInput), savedSecret);
        }
      },
    });
    assert.isAbove(explored.states, 10);
  });
});
