import { MessageLog } from '@effect/ui';
import { HtmlLocator, HtmlPlay } from '@effect/ui/html/testing';
import { Locator, Story, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Redacted, Schema } from 'effect';

import {
  GenerateServerKey,
  ServerEditorEvent,
  ServerEditorMessage,
  ServerEditorModel,
  ServerEditorProps,
  ServerEditorView,
} from '@mcp-gateway/mainview/effect-dialogs/ServerEditorView';
import {
  createKeyValueRow,
  editorFromServer,
  emptyEditor,
  hasInvalidKeyValueRows,
  keyValueRowsToRecord,
  recordToKeyValueRows,
  type ServerEditorState,
} from '@mcp-gateway/mainview/effect-dialogs/server-editor-logic';
import { translator } from '@mcp-gateway/shared/i18n';

const t = translator('en_US');

const makeProps = (
  overrides: Partial<typeof ServerEditorProps.Type> = {},
): typeof ServerEditorProps.Type => ({
  locale: 'en_US',
  editor: emptyEditor(),
  existingNames: ['existing'],
  editorError: null,
  configurationLocked: false,
  ...overrides,
});

describe('ServerEditorView', () => {
  it('redacts secret token, env values, and header values under Schema.encodeSync', () => {
    const tokenSecret = 'super-secret-custom-token-value-123456';
    const envSecret = 'env-secret-value-999999';
    const headerSecret = 'Bearer header-secret-token-777777';

    const editor: ServerEditorState = {
      ...emptyEditor(),
      name: 'secure-server',
      type: 'http',
      url: 'https://example.com/mcp',
      token: Redacted.make(tokenSecret),
      env: [createKeyValueRow('API_KEY', envSecret)],
      headers: [createKeyValueRow('Authorization', headerSecret)],
    };

    const propsEncoded = JSON.stringify(
      Schema.encodeSync(ServerEditorProps)(makeProps({ editor })),
    );
    const msgEncoded = JSON.stringify(
      Schema.encodeSync(ServerEditorMessage)(ServerEditorMessage.ChangedEditor({ editor })),
    );
    const genKeyEncoded = JSON.stringify(
      Schema.encodeSync(ServerEditorMessage)(
        ServerEditorMessage.GeneratedKey({ token: Redacted.make(tokenSecret) }),
      ),
    );
    const genKeyWireRedacted = JSON.stringify(
      Schema.encodeUnknownSync(
        MessageLog.redactSchema(ServerEditorMessage) as Schema.Codec<unknown>,
      )(ServerEditorMessage.GeneratedKey({ token: Redacted.make(tokenSecret) })),
    );
    const eventEncoded = JSON.stringify(
      Schema.encodeSync(ServerEditorEvent)(ServerEditorEvent.ChangedEditor({ editor })),
    );

    for (const encoded of [propsEncoded, msgEncoded, eventEncoded]) {
      assert.notInclude(encoded, tokenSecret);
      assert.notInclude(encoded, envSecret);
      assert.notInclude(encoded, headerSecret);
      assert.include(encoded, '<redacted>');
    }
    assert.notInclude(genKeyEncoded, tokenSecret);
    assert.include(genKeyEncoded, '<redacted>');
    assert.notInclude(genKeyWireRedacted, tokenSecret);
    assert.include(genKeyWireRedacted, '"~redacted":true');
  });

  it('handles Bear preset, Generate Key, deterministic row IDs, reveal toggle, and submit/close events', () => {
    const story = Story.start(ServerEditorView, makeProps());
    assert.isFalse(story.model.showKey);

    story.send(ServerEditorMessage.ClickedBearPreset());
    const bearEvent = story.current.emitted[0];
    if (bearEvent?._tag === 'ChangedEditor') {
      assert.strictEqual(bearEvent.editor.name, 'bear');
      assert.strictEqual(bearEvent.editor.type, 'stdio');
      assert.include(bearEvent.editor.command, 'bearcli');
      story.emitted(bearEvent);
    } else {
      assert.fail('expected ChangedEditor event from Bear preset');
    }

    const generated = Redacted.make('e'.repeat(64));
    story
      .send(ServerEditorMessage.ClickedGenerateKey())
      .expectExact(GenerateServerKey.make())
      .resolve(GenerateServerKey, ServerEditorMessage.GeneratedKey({ token: generated }));
    const genEvent = story.current.emitted[0];
    if (genEvent?._tag === 'ChangedEditor') {
      assert.isNotNull(genEvent.editor.token);
      assert.isNull(genEvent.editor.tokenRef);
      if (genEvent.editor.token) {
        assert.strictEqual(Redacted.value(genEvent.editor.token), 'e'.repeat(64));
      }
      story.emitted(genEvent);
    } else {
      assert.fail('expected ChangedEditor event from Generate Key');
    }

    // Repeated runs produce identical deterministic row IDs
    const rowsA = recordToKeyValueRows({ A: '1', B: '2' });
    const rowsB = recordToKeyValueRows({ A: '1', B: '2' });
    assert.deepStrictEqual(
      rowsA.map((r) => r.id),
      ['kv-1', 'kv-2'],
    );
    assert.deepStrictEqual(
      rowsB.map((r) => r.id),
      ['kv-1', 'kv-2'],
    );
    story.send(ServerEditorMessage.AddedKeyValueRow({ field: 'env' }));
    story.emitted(ServerEditorEvent.ChangedEditor({ editor: story.model.editor }));
    story.send(ServerEditorMessage.AddedKeyValueRow({ field: 'env' }));
    story.emitted(ServerEditorEvent.ChangedEditor({ editor: story.model.editor }));
    assert.deepStrictEqual(
      story.model.editor.env.map((r) => r.id),
      ['kv-1', 'kv-2'],
    );

    story.send(ServerEditorMessage.ToggledShowKey());
    assert.isTrue(story.model.showKey);

    story.send(ServerEditorMessage.Submitted());
    story.emitted(ServerEditorEvent.Submitted());

    story.send(ServerEditorMessage.Closed());
    story.emitted(ServerEditorEvent.Closed());
  });

  it('round-trips stdio and http servers via editorFromServer and keyValueRowsToRecord', () => {
    const stdioEditor = editorFromServer('local', {
      command: '/usr/local/bin/mcp',
      args: ['--port', '3000'],
      env: { API_KEY: 'secret-val', PLAIN: 'ok' },
      cwd: '/tmp',
    });
    assert.strictEqual(stdioEditor.type, 'stdio');
    assert.deepStrictEqual(stdioEditor.args, ['--port', '3000']);
    assert.isFalse(hasInvalidKeyValueRows(stdioEditor.env));
    assert.deepStrictEqual(keyValueRowsToRecord(stdioEditor.env, 'invalid'), {
      API_KEY: 'secret-val',
      PLAIN: 'ok',
    });

    const httpEditor = editorFromServer('remote', {
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc' },
      token: 'a'.repeat(32),
    });
    assert.strictEqual(httpEditor.type, 'http');
    assert.strictEqual(httpEditor.url, 'https://example.com/mcp');
    assert.isNotNull(httpEditor.token);
    if (httpEditor.token) {
      assert.strictEqual(Redacted.value(httpEditor.token), 'a'.repeat(32));
    }
    assert.deepStrictEqual(keyValueRowsToRecord(httpEditor.headers, 'invalid'), {
      Authorization: 'Bearer abc',
    });
  });

  it.effect(
    'renders duplicate/invalid name errors, sensitive env alert, and Keychain tokenRef state',
    () =>
      Effect.gen(function* () {
        const play = yield* HtmlPlay.make(
          ServerEditorView,
          makeProps({
            editor: {
              ...emptyEditor(),
              name: 'existing',
              command: '/usr/bin/env',
              env: [createKeyValueRow('PATH', '/tmp/bin')],
              tokenRef: 'keychain:server:existing',
            },
          }),
        );

        yield* play.expect(Locator.text(t('app.serverExists'))).toExist();
        yield* play
          .expect(Locator.text('Overrides sensitive execution environment variable(s): PATH'))
          .toExist();
        yield* play.expect(Locator.text(t('keys.stored'))).toExist();
        yield* play.expect(HtmlLocator.role('button', { name: t('editor.apply') })).toBeDisabled();

        // Dismiss sensitive env warning locally
        yield* play.click(HtmlLocator.role('button', { name: t('common.dismissError') }));
        yield* play
          .expect(Locator.text('Overrides sensitive execution environment variable(s): PATH'))
          .toBeAbsent();
      }).pipe(Effect.provide(TestHost.layer())),
  );

  it.effect('renders HTTP transport fields and invalid headers error', () =>
    Effect.gen(function* () {
      const play = yield* HtmlPlay.make(
        ServerEditorView,
        makeProps({
          editor: {
            ...emptyEditor(),
            name: 'remote-http',
            type: 'http',
            url: 'https://example.com/mcp',
            headers: [createKeyValueRow('', 'orphan-value')],
          },
        }),
      );

      yield* play.expect(Locator.text(t('editor.url'))).toExist();
      yield* play.expect(Locator.text(t('app.headersInvalid'))).toExist();
      yield* play.expect(HtmlLocator.role('button', { name: t('editor.apply') })).toBeDisabled();
    }).pipe(Effect.provide(TestHost.layer())),
  );

  it('boundedly explores transport switches, row edits, preset click, and auth toggles with deterministic IDs and redaction', () => {
    const envSecret = 'editor-env-secret-must-not-leak-12345';
    const tokenSecret = 'editor-token-secret-must-not-leak-67890';
    const generatedSecret = 'editor-generated-secret-must-not-leak-abcde';
    const encodeModel = Schema.encodeUnknownSync(
      MessageLog.redactSchema(ServerEditorModel) as Schema.Codec<unknown>,
    );
    const encodeEvent = Schema.encodeUnknownSync(
      MessageLog.redactSchema(ServerEditorEvent) as Schema.Codec<unknown>,
    );

    const explored = Story.explore(
      ServerEditorView,
      makeProps({
        editor: {
          ...emptyEditor(),
          env: [createKeyValueRow('API_KEY', '', true, 'kv-1')],
        },
      }),
      {
        messages: [
          ServerEditorMessage.ChangedTransport({ transport: 'http' }),
          ServerEditorMessage.ChangedTransport({ transport: 'stdio' }),
          ServerEditorMessage.AddedArg(),
          ServerEditorMessage.AddedKeyValueRow({ field: 'env' }),
          ServerEditorMessage.AddedKeyValueRow({ field: 'headers' }),
          ServerEditorMessage.UpdatedKeyValueRowValue({
            field: 'env',
            id: 'kv-1',
            value: Redacted.make(envSecret),
          }),
          ServerEditorMessage.ClickedBearPreset(),
          ServerEditorMessage.ChangedAuthMode({ mode: 'custom' }),
          ServerEditorMessage.ChangedAuthMode({ mode: 'global' }),
          ServerEditorMessage.ChangedToken({ token: Redacted.make(tokenSecret) }),
          ServerEditorMessage.ClickedGenerateKey(),
        ],
        commands: [
          [
            GenerateServerKey,
            {
              success: () => [
                ServerEditorMessage.GeneratedKey({ token: Redacted.make(generatedSecret) }),
              ],
            },
          ],
        ],
        depth: 2,
        invariant: ({ model, emitted }) => {
          for (const rows of [model.editor.env, model.editor.headers]) {
            const ids = rows.map((row) => row.id);
            assert.strictEqual(new Set(ids).size, ids.length);
            for (const id of ids) {
              assert.match(id, /^kv-\d+$/);
            }
          }
          const serialized = JSON.stringify(encodeModel(model));
          assert.notInclude(serialized, envSecret);
          assert.notInclude(serialized, tokenSecret);
          assert.notInclude(serialized, generatedSecret);
          for (const event of emitted) {
            const serializedEvent = JSON.stringify(encodeEvent(event));
            assert.notInclude(serializedEvent, envSecret);
            assert.notInclude(serializedEvent, tokenSecret);
            assert.notInclude(serializedEvent, generatedSecret);
          }
        },
      },
    );
    assert.isAbove(explored.states, 10);
  });
});
