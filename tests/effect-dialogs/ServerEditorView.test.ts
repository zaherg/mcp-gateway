import { HtmlLocator, HtmlPlay } from '@effect/ui/html/testing';
import { Locator, Story, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Redacted, Schema } from 'effect';

import {
  ServerEditorEvent,
  ServerEditorMessage,
  ServerEditorProps,
  ServerEditorView,
} from '@mcp-gateway/mainview/effect-dialogs/ServerEditorView';
import {
  createKeyValueRow,
  editorFromServer,
  emptyEditor,
  hasInvalidKeyValueRows,
  keyValueRowsToRecord,
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
    const eventEncoded = JSON.stringify(
      Schema.encodeSync(ServerEditorEvent)(ServerEditorEvent.ChangedEditor({ editor })),
    );

    for (const encoded of [propsEncoded, msgEncoded, eventEncoded]) {
      assert.notInclude(encoded, tokenSecret);
      assert.notInclude(encoded, envSecret);
      assert.notInclude(encoded, headerSecret);
      assert.include(encoded, '<redacted>');
    }
  });

  it('handles Bear preset, Generate Key, reveal toggle, and submit/close events', () => {
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

    story.send(ServerEditorMessage.ClickedGenerateKey());
    const genEvent = story.current.emitted[0];
    if (genEvent?._tag === 'ChangedEditor') {
      assert.isNotNull(genEvent.editor.token);
      assert.isNull(genEvent.editor.tokenRef);
      if (genEvent.editor.token) {
        assert.isAtLeast(Redacted.value(genEvent.editor.token).length, 32);
      }
      story.emitted(genEvent);
    } else {
      assert.fail('expected ChangedEditor event from Generate Key');
    }

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
});
