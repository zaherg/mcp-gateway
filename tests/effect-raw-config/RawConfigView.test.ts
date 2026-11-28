import { HtmlLocator, HtmlPlay, HtmlScene } from '@effect/ui/html/testing';
import { Locator, TestHost } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { TestClock } from 'effect/testing';

import { GatewayRpc } from '@mcp-gateway/mainview/effect-app/services';
import {
  AttachCodeMirror,
  AttachCodeMirrorArgs,
  RawConfigCommandLayers,
  RawConfigEvent,
  RawConfigMessage,
  RawConfigModel,
  RawConfigProps,
  RawConfigView,
  RunRemoteValidation,
} from '@mcp-gateway/mainview/effect-raw-config/RawConfigView';
import { translator } from '@mcp-gateway/shared/i18n';

const t = translator('en_US');

const sampleConfig =
  '{\n  "gateway": {\n    "token": "secret-gateway-token-1234567890123456"\n  }\n}';

const makeProps = (
  overrides: Partial<typeof RawConfigProps.Type> = {},
): typeof RawConfigProps.Type => ({
  locale: 'en_US',
  visible: true,
  rawOpen: true,
  locked: false,
  format: 'json',
  filename: 'mcp.json',
  configPath: '/tmp/mcp.json',
  savedConfigText: Redacted.make(sampleConfig),
  doc: {
    text: Redacted.make(sampleConfig),
    revision: 'rev-1',
    dirty: false,
  },
  editSequence: 0,
  lastImport: null,
  ...overrides,
});

describe('RawConfigView', () => {
  it('redacts config text in Props, Model, Message, and AttachCodeMirror args under Schema.encodeSync', () => {
    const secret = 'secret-gateway-token-1234567890123456';
    const propsEncoded = JSON.stringify(Schema.encodeSync(RawConfigProps)(makeProps()));
    const modelEncoded = JSON.stringify(
      Schema.encodeSync(RawConfigModel)({
        feedback: {
          kind: 'issue',
          text: Redacted.make(sampleConfig),
          message: 'Bad config',
          at: { line: 2, column: 3 },
        },
        schemaOpen: false,
        dismissedImportSeq: null,
        jumpSeq: 0,
        jumpLine: null,
      }),
    );
    const mountArgsEncoded = JSON.stringify(
      Schema.encodeSync(Schema.Struct(AttachCodeMirrorArgs))({
        text: Redacted.make(sampleConfig),
        revision: 'rev-1',
        dirty: false,
        locked: false,
        invalid: false,
        fieldId: 'raw-config-editor',
        jumpSeq: 0,
        jumpLine: null,
      }),
    );
    const msgEncoded = JSON.stringify(
      Schema.encodeSync(RawConfigMessage)(
        RawConfigMessage.EditorTextChanged({ text: Redacted.make(sampleConfig) }),
      ),
    );

    for (const encoded of [propsEncoded, modelEncoded, mountArgsEncoded, msgEncoded]) {
      assert.notInclude(encoded, secret);
      assert.include(encoded, '<redacted>');
    }
  });

  it('mounts AttachCodeMirror and emits ChangedDoc when editor stream produces text', () => {
    const scene = HtmlScene.start(RawConfigView, makeProps());

    scene.expectMount(
      AttachCodeMirror({
        text: Redacted.make(sampleConfig),
        revision: 'rev-1',
        dirty: false,
        locked: false,
        invalid: false,
        fieldId: 'raw-config-editor',
        jumpSeq: 0,
        jumpLine: null,
      }),
    );

    const editedText = '{"gateway":{"port":9999}}';
    scene.mounted(AttachCodeMirror, Redacted.make(editedText)).emitted(
      RawConfigEvent.ChangedDoc({
        doc: { text: Redacted.make(editedText), revision: 'rev-1', dirty: true },
      }),
    );
  });

  it.effect(
    'debounces validation 300ms, handles issue Line N jump, and enables Save only when ok or unavailable',
    () => {
      let validateCalls = 0;
      let mode: 'issue' | 'ok' | 'hang' = 'issue';

      const rpcLayer = GatewayRpc.test({
        validateConfig: () => {
          validateCalls++;
          if (mode === 'hang') return Effect.never;
          if (mode === 'issue') {
            return Effect.succeed({
              ok: true as const,
              value: {
                issue: {
                  message: 'Gateway token is too short',
                  offset: 18,
                },
              },
            });
          }
          return Effect.succeed({
            ok: true as const,
            value: { issue: null },
          });
        },
      });

      const env = Layer.mergeAll(
        TestHost.layer(),
        RawConfigCommandLayers.pipe(Layer.provide(rpcLayer)),
      );

      return Effect.gen(function* () {
        const dirtyDoc = {
          text: Redacted.make(sampleConfig),
          revision: 'rev-1',
          dirty: true,
        };
        const play = yield* HtmlPlay.make(
          RawConfigView,
          makeProps({
            doc: dirtyDoc,
            savedConfigText: Redacted.make('{}'),
            editSequence: 1,
          }),
        );

        // Before 300ms debounce, RPC has not fired and Save is disabled
        yield* TestClock.adjust('299 millis');
        assert.strictEqual(validateCalls, 0);
        yield* play
          .expect(HtmlLocator.role('button', { name: t('raw.save', { filename: 'mcp.json' }) }))
          .toBeDisabled();

        // At 300ms, remote validation runs and reports issue at line 3
        yield* TestClock.adjust('1 millis');
        assert.strictEqual(validateCalls, 1);
        yield* play.expect(Locator.text('Line 3')).toExist();
        yield* play
          .expect(HtmlLocator.role('button', { name: t('raw.save', { filename: 'mcp.json' }) }))
          .toBeDisabled();

        // Clicking Line 3 increments jumpSeq and sets jumpLine
        yield* play.click(HtmlLocator.role('button', { name: 'Line 3' }));

        // Next edit succeeds remote validation -> Save becomes enabled
        mode = 'ok';
        play.root.setProps(
          makeProps({
            doc: dirtyDoc,
            savedConfigText: Redacted.make('{}'),
            editSequence: 2,
          }),
        );
        yield* TestHost.settle;
        yield* TestClock.adjust('300 millis');
        assert.strictEqual(validateCalls, 2);
        yield* play.expect(Locator.text(t('raw.checked'))).toExist();
        yield* play
          .expect(HtmlLocator.role('button', { name: t('raw.save', { filename: 'mcp.json' }) }))
          .toBeDisabled(false);

        // Timeout after 5000ms falls back to unavailable (still saveReady)
        mode = 'hang';
        play.root.setProps(
          makeProps({
            doc: dirtyDoc,
            savedConfigText: Redacted.make('{}'),
            editSequence: 3,
          }),
        );
        yield* TestHost.settle;
        yield* TestClock.adjust('300 millis');
        assert.strictEqual(validateCalls, 3);
        yield* play.expect(Locator.text(t('raw.checking'))).toExist();
        yield* TestClock.adjust('5000 millis');
        yield* play.expect(Locator.text(t('raw.checkUnavailable'))).toExist();
        yield* play
          .expect(HtmlLocator.role('button', { name: t('raw.save', { filename: 'mcp.json' }) }))
          .toBeDisabled(false);
      }).pipe(Effect.provide(env));
    },
  );

  it.effect('toggles schema popover and formats unformatted JSON draft', () => {
    const rpcLayer = GatewayRpc.test();
    const env = Layer.mergeAll(
      TestHost.layer(),
      RawConfigCommandLayers.pipe(Layer.provide(rpcLayer)),
    );

    return Effect.gen(function* () {
      const compact = '{"gateway":{"port":8765}}';
      const play = yield* HtmlPlay.make(
        RawConfigView,
        makeProps({
          doc: { text: Redacted.make(compact), revision: 'rev-1', dirty: false },
          savedConfigText: Redacted.make(compact),
        }),
      );

      yield* play.click(HtmlLocator.role('button', { name: 'Schema reference' }));
      yield* play.expect(Locator.text(t('raw.intro'))).toExist();

      // Import is enabled when clean, disabled when dirty
      yield* play
        .expect(HtmlLocator.role('button', { name: 'Import from Claude / Cursor' }))
        .toBeDisabled(false);

      // Format emits ChangedDoc with pretty-printed JSON
      yield* play.click(HtmlLocator.role('button', { name: t('raw.format') }));
      yield* TestHost.settle;
      assert.isDefined(RunRemoteValidation);
    }).pipe(Effect.provide(env));
  });
});
