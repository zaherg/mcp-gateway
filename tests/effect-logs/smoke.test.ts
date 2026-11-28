import { Command, Subscription, UiSchema } from '@effect/ui';
import { BrowserHost, Html } from '@effect/ui/html';
import { HtmlLocator, HtmlPlay, HtmlScene } from '@effect/ui/html/testing';
import { Story, TestHost } from '@effect/ui/testing';
import { DevTools } from '@effect/ui-devtools';
import { Button } from '@effect/ui-kit';
import { assert, describe, it } from '@effect/vitest';
import { Effect, Schema, Stream } from 'effect';
import { TestClock } from 'effect/testing';

const SmokeMessage = UiSchema.TaggedEnum({
  ClickedPing: {},
  CompletedPing: {},
  Ticked: {},
});

const PingCommand = Command.make('PingCommand', {}, () =>
  Effect.sleep('100 millis').pipe(Effect.as(SmokeMessage.CompletedPing())),
);

const SmokeCounter = Html.component({
  name: 'SmokeCounter',
  model: Schema.Struct({ count: Schema.Number, ticking: Schema.Boolean }),
  message: SmokeMessage,
}).make({
  init: () => ({ count: 0, ticking: false }),
  update: {
    ClickedPing: ($) => $.run(PingCommand.make()),
    CompletedPing: ($) => $.evolve({ count: (count) => count + 1 }),
    Ticked: ($) => $.evolve({ count: (count) => count + 1 }),
  },
  subscriptions: ({ model }) => [
    model.ticking &&
      Subscription.make(
        'tick',
        Stream.tick('1 second').pipe(
          Stream.drop(1),
          Stream.map(() => SmokeMessage.Ticked()),
        ),
      ),
  ],
  view: (h, model) =>
    h.div.children(
      h.output.children(String(model.count)),
      Button(h, {
        props: { disabled: h.isRunning(PingCommand) },
        onPress: SmokeMessage.ClickedPing(),
      }).children(h.isRunning(PingCommand) ? 'Pinging' : 'Ping'),
    ),
});

describe('Effect UI snapshot smoke test (82a1750)', () => {
  it('exposes BrowserHost.mountEffect and DevTools.layer', () => {
    assert.strictEqual(typeof BrowserHost.mountEffect, 'function');
    assert.strictEqual(typeof DevTools.layer, 'function');
  });

  it.effect('runs Story.make and Story.explore', () =>
    Effect.gen(function* () {
      const story = yield* Story.make(SmokeCounter, {});
      story
        .send(SmokeMessage.ClickedPing())
        .expectExact(PingCommand)
        .resolve(PingCommand, SmokeMessage.CompletedPing());
      assert.strictEqual(story.model.count, 1);

      const explored = Story.explore(
        SmokeCounter,
        {},
        {
          messages: [SmokeMessage.ClickedPing()],
          commands: [[PingCommand, { success: () => [SmokeMessage.CompletedPing()] }]],
          depth: 3,
          invariant: ({ model }) => model.count >= 0,
        },
      );
      assert.isAbove(explored.states, 0);
    }),
  );

  it.effect('runs HtmlScene.make', () =>
    Effect.gen(function* () {
      const scene = yield* HtmlScene.make(SmokeCounter, {});
      scene
        .click(HtmlLocator.role('button', { name: 'Ping' }))
        .expectExact(PingCommand)
        .expect(HtmlLocator.role('button', { name: 'Pinging' }))
        .toExist()
        .resolve(PingCommand, SmokeMessage.CompletedPing())
        .expect(HtmlLocator.role('status'))
        .toHaveText('1');
    }),
  );

  it.layer(TestHost.layer())((it) => {
    it.effect('runs HtmlPlay.make with TestClock', () =>
      Effect.gen(function* () {
        const play = yield* HtmlPlay.make(SmokeCounter, {});
        yield* play.click(HtmlLocator.role('button', { name: 'Ping' }));
        yield* TestClock.adjust('99 millis');
        yield* play.expect(HtmlLocator.role('status')).toHaveText('0');
        yield* TestClock.adjust('1 millis');
        yield* play.expect(HtmlLocator.role('status')).toHaveText('1');
      }),
    );
  });
});
