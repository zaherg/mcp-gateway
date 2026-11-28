import { Story } from '@effect/ui/testing';
import { assert, describe, it } from '@effect/vitest';

import {
  CopyClientConfig,
  ExpireCopiedBadge,
  OverviewEvent,
  OverviewMessage,
  type OverviewProps,
  OverviewView,
  TestServer,
} from '@mcp-gateway/mainview/effect-overview/OverviewView';
import { TestServerOutcome } from '@mcp-gateway/mainview/effect-overview/services';
import { translator } from '@mcp-gateway/shared/i18n';

const t = translator('en_US');

const defaultProps: typeof OverviewProps.Type = {
  locale: 'en_US',
  hasConfig: true,
  dirty: false,
  running: true,
  revision: 'rev-1',
  listenerAddress: '127.0.0.1:8787',
  configurationLocked: false,
  hasConfigError: false,
  configErrorCode: null,
  error: null,
  operationalError: null,
  keyReminder: false,
  servers: [
    {
      name: 'bear',
      transport: 'http',
      target: 'http://127.0.0.1:4001/mcp',
      disabled: false,
      status: 'mounted',
      hasLive: true,
      liveError: null,
    },
    {
      name: 'notes',
      transport: 'stdio',
      target: 'npx notes-mcp',
      disabled: false,
      status: 'mounted',
      hasLive: true,
      liveError: null,
    },
  ],
};

describe('OverviewView Story tests', () => {
  it('runs TestServer through passed, failed, cancelled, and unavailable outcomes and clears outdated passes', () => {
    const story = Story.start(OverviewView, defaultProps);

    story
      .send(OverviewMessage.ClickedTestServer({ name: 'bear' }))
      .expectExact(TestServer.make({ name: 'bear', expectedRevision: 'rev-1' }));

    assert.strictEqual(story.model.test?.state, 'testing');
    assert.strictEqual(story.model.test?.name, 'bear');

    // Duplicate click while testing is ignored and leaves bear's pending command intact.
    story
      .send(OverviewMessage.ClickedTestServer({ name: 'notes' }))
      .expectExact(TestServer.make({ name: 'bear', expectedRevision: 'rev-1' }));

    story.resolve(
      TestServer,
      OverviewMessage.TestServerCompleted({
        name: 'bear',
        revision: 'rev-1',
        outcome: TestServerOutcome.Passed({ protocolVersion: '2025-11-25' }),
      }),
    );

    assert.deepStrictEqual(story.model.test, {
      name: 'bear',
      revision: 'rev-1',
      state: 'passed',
      message: t('overview.testPassed', { version: '2025-11-25' }),
    });

    // While server is still mounted and running, ClearedOutdatedTest is a no-op.
    story.send(OverviewMessage.ClearedOutdatedTest());
    assert.strictEqual(story.model.test?.state, 'passed');

    // Once gateway stops, ClearedOutdatedTest clears the passed result.
    story.props({ ...defaultProps, running: false });
    story.send(OverviewMessage.ClearedOutdatedTest());
    assert.strictEqual(story.model.test, null);

    // Cancelled outcomes are preserved even after gateway stops.
    story.props(defaultProps);
    story.send(OverviewMessage.ClickedTestServer({ name: 'bear' })).resolve(
      TestServer,
      OverviewMessage.TestServerCompleted({
        name: 'bear',
        revision: 'rev-1',
        outcome: TestServerOutcome.Cancelled({ message: 'Gateway stopped' }),
      }),
    );
    story.props({ ...defaultProps, running: false });
    story.send(OverviewMessage.ClearedOutdatedTest());
    assert.strictEqual(story.model.test?.state, 'cancelled');
    assert.strictEqual(story.model.test?.message, 'Gateway stopped');

    // Unavailable maps to failed with localized fallback text.
    story.props(defaultProps);
    story.send(OverviewMessage.ClickedTestServer({ name: 'notes' })).resolve(
      TestServer,
      OverviewMessage.TestServerCompleted({
        name: 'notes',
        revision: 'rev-1',
        outcome: TestServerOutcome.Unavailable(),
      }),
    );
    assert.strictEqual(story.model.test?.state, 'failed');
    assert.strictEqual(story.model.test?.message, t('overview.testUnavailable'));
  });

  it('tracks copied client config badge and expires only matching server name', () => {
    const story = Story.start(OverviewView, defaultProps);

    story
      .send(OverviewMessage.ClickedCopyClientConfig({ name: 'bear' }))
      .expectExact(CopyClientConfig.make({ name: 'bear' }))
      .resolve(
        CopyClientConfig,
        OverviewMessage.CopyClientConfigCompleted({
          name: 'bear',
          copied: true,
          errorKind: null,
          errorMessage: null,
        }),
      )
      .expectExact(ExpireCopiedBadge.make({ name: 'bear' }));

    assert.strictEqual(story.model.copiedServer, 'bear');

    // Expiry for a different server does not clear bear.
    story.send(OverviewMessage.CopiedBadgeExpired({ name: 'notes' }));
    assert.strictEqual(story.model.copiedServer, 'bear');

    story.resolve(ExpireCopiedBadge, OverviewMessage.CopiedBadgeExpired({ name: 'bear' }));
    assert.strictEqual(story.model.copiedServer, null);

    // Failed copy reports error and does not set copiedServer or start expiry timer.
    story
      .send(OverviewMessage.ClickedCopyClientConfig({ name: 'notes' }))
      .resolve(
        CopyClientConfig,
        OverviewMessage.CopyClientConfigCompleted({
          name: 'notes',
          copied: false,
          errorKind: 'rpc',
          errorMessage: 'ClipboardError: unavailable',
        }),
      )
      .emitted(OverviewEvent.ReportedError({ message: 'ClipboardError: unavailable' }))
      .expectNone();
    assert.strictEqual(story.model.copiedServer, null);
  });

  it('enforces configurationLocked, dirty, hasConfigError, and hasConfig guards and emits events', () => {
    const lockedStory = Story.start(OverviewView, {
      ...defaultProps,
      configurationLocked: true,
    });
    lockedStory
      .send(OverviewMessage.ClickedReviewKeys())
      .expectNone()
      .send(OverviewMessage.ClickedAddServer())
      .expectNone()
      .send(OverviewMessage.ClickedEditServer({ name: 'bear' }))
      .expectNone()
      .send(OverviewMessage.ClickedBearPreset())
      .expectNone()
      .send(OverviewMessage.ToggledServer({ name: 'bear', enabled: false }))
      .expectNone()
      .send(OverviewMessage.ClickedDeleteServer({ name: 'bear' }))
      .expectNone()
      .send(OverviewMessage.ClickedTestServer({ name: 'bear' }))
      .expectNone();

    const dirtyStory = Story.start(OverviewView, { ...defaultProps, dirty: true });
    dirtyStory
      .send(OverviewMessage.ToggledServer({ name: 'bear', enabled: false }))
      .expectNone()
      .send(OverviewMessage.ClickedCopyClientConfig({ name: 'bear' }))
      .expectNone();

    const noConfigStory = Story.start(OverviewView, { ...defaultProps, hasConfig: false });
    noConfigStory.send(OverviewMessage.ClickedAddServer()).expectNone();

    const unlockedStory = Story.start(OverviewView, defaultProps);
    unlockedStory
      .send(OverviewMessage.ClickedReviewKeys())
      .emitted(OverviewEvent.RequestedOpenKeyMigration())
      .send(OverviewMessage.ClickedAddServer())
      .emitted(OverviewEvent.RequestedOpenServerEditor({ name: null }))
      .send(OverviewMessage.ClickedEditServer({ name: 'bear' }))
      .emitted(OverviewEvent.RequestedOpenServerEditor({ name: 'bear' }))
      .send(OverviewMessage.ClickedBearPreset())
      .emitted(OverviewEvent.RequestedOpenBearPreset())
      .send(OverviewMessage.ToggledServer({ name: 'bear', enabled: false }))
      .emitted(OverviewEvent.RequestedToggleServer({ name: 'bear', disabled: true }))
      .send(OverviewMessage.ClickedDeleteServer({ name: 'bear' }))
      .emitted(OverviewEvent.RequestedDeleteServer({ name: 'bear' }));
  });

  it('explores interleaved test runs, client config copies, and expiry timers', () => {
    const explored = Story.explore(OverviewView, defaultProps, {
      messages: [
        OverviewMessage.ClickedTestServer({ name: 'bear' }),
        OverviewMessage.ClickedCopyClientConfig({ name: 'bear' }),
        OverviewMessage.ClickedCopyClientConfig({ name: 'notes' }),
        OverviewMessage.ClearedOutdatedTest(),
      ],
      commands: [
        [
          TestServer,
          {
            success: ({ name, expectedRevision }) => [
              OverviewMessage.TestServerCompleted({
                name,
                revision: expectedRevision,
                outcome: TestServerOutcome.Passed({ protocolVersion: '2025-11-25' }),
              }),
              OverviewMessage.TestServerCompleted({
                name,
                revision: expectedRevision,
                outcome: TestServerOutcome.Failed({ message: 'ECONNREFUSED' }),
              }),
            ],
          },
        ],
        [
          CopyClientConfig,
          {
            success: ({ name }) => [
              OverviewMessage.CopyClientConfigCompleted({
                name,
                copied: true,
                errorKind: null,
                errorMessage: null,
              }),
              OverviewMessage.CopyClientConfigCompleted({
                name,
                copied: false,
                errorKind: 'bridge',
                errorMessage: 'bridge rejected',
              }),
            ],
          },
        ],
        [
          ExpireCopiedBadge,
          {
            success: ({ name }) => [OverviewMessage.CopiedBadgeExpired({ name })],
          },
        ],
      ],
      depth: 4,
      invariant: ({ model, pending }) => {
        const activeTests = pending.filter(
          (item) => item.command.name === 'mcp-gateway/overview/TestServer',
        );
        const activeCopies = pending.filter(
          (item) => item.command.name === 'mcp-gateway/overview/CopyClientConfig',
        );
        const activeTimers = pending.filter(
          (item) => item.command.name === 'mcp-gateway/overview/ExpireCopiedBadge',
        );
        assert.isAtMost(activeTests.length, 1);
        assert.isAtMost(activeCopies.length, 1);
        assert.isAtMost(activeTimers.length, 1);
        if (model.test?.state === 'testing') {
          assert.strictEqual(activeTests.length, 1);
        }
      },
    });
    assert.isAbove(explored.states, 10);
  });
});
