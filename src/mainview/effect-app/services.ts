import { Context, Effect, Layer, Queue, Redacted, Stream } from 'effect';

import {
  type AppSnapshotRedacted,
  toRedactedSnapshot,
  toUpdateStatusValue,
  type UpdateStatusValue,
} from '@mcp-gateway/mainview/effect-app/schemas';
import type { ConfigIssue } from '@mcp-gateway/shared/config-document';
import type { LanguagePreference } from '@mcp-gateway/shared/i18n';
import type {
  AppClient,
  AppearancePreference,
  AppResult,
  AppSnapshot,
  MenuCommand,
  SocialLinkTarget,
} from '@mcp-gateway/shared/rpc';
import type { KeyMigration, LogPage, LogQuery, ServerCheckResult } from '@mcp-gateway/shared/types';

export type RpcError = {
  readonly kind: 'rpc' | 'bridge';
  readonly code: string;
  readonly message: string;
};

export type RpcOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcError };

export interface GatewayRpcBridge {
  readonly onSnapshotChanged?: (listener: (snapshot: AppSnapshot) => void) => () => void;
  readonly onMenuCommand?: (listener: (command: MenuCommand) => void) => () => void;
  readonly setUnsavedRawConfigChecker?: (checker: () => boolean) => void;
}

export interface GatewayRpcShape {
  readonly snapshot: () => Effect.Effect<RpcOutcome<AppSnapshotRedacted>>;
  readonly start: () => Effect.Effect<RpcOutcome<AppSnapshotRedacted>>;
  readonly stop: () => Effect.Effect<RpcOutcome<AppSnapshotRedacted>>;
  readonly saveConfig: (params: {
    readonly text: Redacted.Redacted<string>;
    readonly expectedRevision: string;
  }) => Effect.Effect<RpcOutcome<AppSnapshotRedacted>>;
  readonly migrateKeys: (params: {
    readonly gateway: boolean;
    readonly servers: readonly string[];
    readonly expectedRevision: string;
  }) => Effect.Effect<RpcOutcome<AppSnapshotRedacted>>;
  readonly dismissKeyReminder: () => Effect.Effect<RpcOutcome<AppSnapshotRedacted>>;
  readonly validateConfig: (params: {
    readonly text: Redacted.Redacted<string>;
  }) => Effect.Effect<RpcOutcome<{ readonly issue: ConfigIssue | null }>>;
  readonly confirmDiscard: () => Effect.Effect<RpcOutcome<boolean>>;
  readonly confirmDeleteServer: (params: {
    readonly name: string;
  }) => Effect.Effect<RpcOutcome<boolean>>;
  readonly testServer: (params: {
    readonly name: string;
    readonly expectedRevision: string;
  }) => Effect.Effect<RpcOutcome<ServerCheckResult>>;
  readonly copyEndpoint: (params: { readonly name: string }) => Effect.Effect<RpcOutcome<null>>;
  readonly copyClientConfig: (params: { readonly name: string }) => Effect.Effect<RpcOutcome<null>>;
  readonly openSocialLink: (params: {
    readonly target: SocialLinkTarget;
  }) => Effect.Effect<RpcOutcome<null>>;
  readonly revealConfig: () => Effect.Effect<RpcOutcome<null>>;
  readonly openConfigInEditor: () => Effect.Effect<RpcOutcome<null>>;
  readonly importExternalServers: (params: {
    readonly expectedRevision: string;
  }) => Effect.Effect<
    RpcOutcome<{ readonly snapshot: AppSnapshotRedacted; readonly importedCount: number }>
  >;
  readonly dismissWhatsNew: () => Effect.Effect<RpcOutcome<null>>;
  readonly updatesCheck: () => Effect.Effect<RpcOutcome<UpdateStatusValue>>;
  readonly updatesInstall: () => Effect.Effect<RpcOutcome<UpdateStatusValue>>;
  readonly updatesSetAutomatic: (params: {
    readonly automatic: boolean;
  }) => Effect.Effect<RpcOutcome<UpdateStatusValue>>;
  readonly updatesRestart: () => Effect.Effect<RpcOutcome<null>>;
  readonly setLanguage: (params: {
    readonly preference: LanguagePreference;
  }) => Effect.Effect<RpcOutcome<AppSnapshotRedacted>>;
  readonly setAppearance: (params: {
    readonly preference: AppearancePreference;
  }) => Effect.Effect<RpcOutcome<AppSnapshotRedacted>>;
  readonly readLogs: (query: LogQuery) => Effect.Effect<RpcOutcome<LogPage>>;
  readonly clearLogs: () => Effect.Effect<RpcOutcome<LogPage>>;
  readonly subscribeSnapshot: Stream.Stream<AppSnapshotRedacted>;
  readonly subscribeMenuCommand: Stream.Stream<MenuCommand>;
  readonly setUnsavedRawConfigChecker: (checker: () => boolean) => Effect.Effect<void>;
}

function wrapCall<T>(call: () => Promise<AppResult<T>>): Effect.Effect<RpcOutcome<T>>;
function wrapCall<T, U>(
  call: () => Promise<AppResult<T>>,
  mapValue: (value: T) => U,
): Effect.Effect<RpcOutcome<U>>;
function wrapCall<T, U>(
  call: () => Promise<AppResult<T>>,
  mapValue?: (value: T) => U,
): Effect.Effect<RpcOutcome<T | U>> {
  return Effect.tryPromise({
    try: call,
    catch: () => ({
      kind: 'bridge' as const,
      code: 'BridgeError',
      message: 'Native bridge call failed',
    }),
  }).pipe(
    Effect.match({
      onSuccess: (result): RpcOutcome<T | U> =>
        result.ok
          ? { ok: true, value: mapValue ? mapValue(result.value) : result.value }
          : {
              ok: false,
              error: {
                kind: 'rpc',
                code: result.error.code,
                message: result.error.message,
              },
            },
      onFailure: (error): RpcOutcome<T | U> => ({ ok: false, error }),
    }),
  );
}

function streamFromSubscribe<A>(
  subscribe: ((listener: (value: A) => void) => () => void) | undefined,
): Stream.Stream<A>;
function streamFromSubscribe<A, B>(
  subscribe: ((listener: (value: A) => void) => () => void) | undefined,
  mapValue: (value: A) => B,
): Stream.Stream<B>;
function streamFromSubscribe<A, B>(
  subscribe: ((listener: (value: A) => void) => () => void) | undefined,
  mapValue?: (value: A) => B,
): Stream.Stream<A | B> {
  if (!subscribe) return Stream.never;
  return Stream.callback<A | B>(
    Effect.fnUntraced(function* (queue) {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          subscribe((value) => {
            Queue.offerUnsafe(queue, mapValue ? mapValue(value) : value);
          }),
        ),
        (unsubscribe) => Effect.sync(() => unsubscribe()),
      );
    }),
  );
}

export class GatewayRpc extends Context.Service<GatewayRpc, GatewayRpcShape>()(
  'mcp-gateway/GatewayRpc',
) {
  static readonly live = (client: AppClient, bridge: GatewayRpcBridge = {}) => {
    const subscribeSnapshotFn = client.onSnapshotChanged ?? bridge.onSnapshotChanged;
    const subscribeMenuFn = client.onMenuCommand ?? bridge.onMenuCommand;
    return Layer.succeed(GatewayRpc, {
      snapshot: () => wrapCall(() => client.snapshot(), toRedactedSnapshot),
      start: () => wrapCall(() => client.start(), toRedactedSnapshot),
      stop: () => wrapCall(() => client.stop(), toRedactedSnapshot),
      saveConfig: ({ text, expectedRevision }) =>
        wrapCall(
          () => client.saveConfig({ text: Redacted.value(text), expectedRevision }),
          toRedactedSnapshot,
        ),
      migrateKeys: ({ gateway, servers, expectedRevision }) =>
        wrapCall(
          () =>
            client.migrateKeys({
              gateway,
              servers: [...servers],
              expectedRevision,
            } satisfies KeyMigration & { expectedRevision: string }),
          toRedactedSnapshot,
        ),
      dismissKeyReminder: () => wrapCall(() => client.dismissKeyReminder(), toRedactedSnapshot),
      validateConfig: ({ text }) =>
        wrapCall(() => client.validateConfig({ text: Redacted.value(text) })),
      confirmDiscard: () => wrapCall(() => client.confirmDiscard()),
      confirmDeleteServer: ({ name }) => wrapCall(() => client.confirmDeleteServer({ name })),
      testServer: ({ name, expectedRevision }) =>
        wrapCall(() => client.testServer({ name, expectedRevision })),
      copyEndpoint: ({ name }) => wrapCall(() => client.copyEndpoint({ name })),
      copyClientConfig: ({ name }) => wrapCall(() => client.copyClientConfig({ name })),
      openSocialLink: ({ target }) => wrapCall(() => client.openSocialLink({ target })),
      revealConfig: () => wrapCall(() => client.revealConfig()),
      openConfigInEditor: () => wrapCall(() => client.openConfigInEditor()),
      importExternalServers: ({ expectedRevision }) =>
        wrapCall(
          () => client.importExternalServers({ expectedRevision }),
          ({ snapshot, importedCount }) => ({
            snapshot: toRedactedSnapshot(snapshot),
            importedCount,
          }),
        ),
      dismissWhatsNew: () => wrapCall(() => client.dismissWhatsNew()),
      updatesCheck: () => wrapCall(() => client.updatesCheck(), toUpdateStatusValue),
      updatesInstall: () => wrapCall(() => client.updatesInstall(), toUpdateStatusValue),
      updatesSetAutomatic: ({ automatic }) =>
        wrapCall(() => client.updatesSetAutomatic({ automatic }), toUpdateStatusValue),
      updatesRestart: () =>
        wrapCall(
          () => client.updatesRestart(),
          () => null,
        ),
      setLanguage: ({ preference }) =>
        wrapCall(() => client.setLanguage({ preference }), toRedactedSnapshot),
      setAppearance: ({ preference }) =>
        wrapCall(() => client.setAppearance({ preference }), toRedactedSnapshot),
      readLogs: (query) => wrapCall(() => client.readLogs(query)),
      clearLogs: () => wrapCall(() => client.clearLogs()),
      subscribeSnapshot: streamFromSubscribe(subscribeSnapshotFn, toRedactedSnapshot),
      subscribeMenuCommand: streamFromSubscribe(subscribeMenuFn),
      setUnsavedRawConfigChecker: (checker) =>
        Effect.sync(() => {
          bridge.setUnsavedRawConfigChecker?.(checker);
        }),
    });
  };

  static readonly test = (overrides: Partial<GatewayRpcShape> = {}) => {
    const unavailable = <T>(): Effect.Effect<RpcOutcome<T>> =>
      Effect.succeed({
        ok: false,
        error: { kind: 'bridge', code: 'Unconfigured', message: 'Not configured in test' },
      });
    const base: GatewayRpcShape = {
      snapshot: () => unavailable(),
      start: () => unavailable(),
      stop: () => unavailable(),
      saveConfig: () => unavailable(),
      migrateKeys: () => unavailable(),
      dismissKeyReminder: () => unavailable(),
      validateConfig: () => Effect.succeed({ ok: true, value: { issue: null } }),
      confirmDiscard: () => Effect.succeed({ ok: true, value: true }),
      confirmDeleteServer: () => Effect.succeed({ ok: true, value: true }),
      testServer: () => Effect.succeed({ ok: true, value: { protocolVersion: '2025-11-25' } }),
      copyEndpoint: () => Effect.succeed({ ok: true, value: null }),
      copyClientConfig: () => Effect.succeed({ ok: true, value: null }),
      openSocialLink: () => Effect.succeed({ ok: true, value: null }),
      revealConfig: () => Effect.succeed({ ok: true, value: null }),
      openConfigInEditor: () => Effect.succeed({ ok: true, value: null }),
      importExternalServers: () => unavailable(),
      dismissWhatsNew: () => Effect.succeed({ ok: true, value: null }),
      updatesCheck: () => unavailable(),
      updatesInstall: () => unavailable(),
      updatesSetAutomatic: () => unavailable(),
      updatesRestart: () => Effect.succeed({ ok: true, value: null }),
      setLanguage: () => unavailable(),
      setAppearance: () => unavailable(),
      readLogs: () =>
        Effect.succeed({
          ok: true,
          value: { entries: [], cursor: 0, generation: 1, gap: false, hasMore: false },
        }),
      clearLogs: () =>
        Effect.succeed({
          ok: true,
          value: { entries: [], cursor: 0, generation: 1, gap: false, hasMore: false },
        }),
      subscribeSnapshot: Stream.never,
      subscribeMenuCommand: Stream.never,
      setUnsavedRawConfigChecker: () => Effect.void,
      ...overrides,
    };
    return Layer.succeed(GatewayRpc, base);
  };
}

export interface WindowEnvShape {
  readonly initialLanguages: () => Effect.Effect<readonly string[]>;
  readonly appTitle: () => Effect.Effect<string>;
  readonly syncLang: (tag: string) => Effect.Effect<void>;
  readonly syncAppearance: (preference: AppearancePreference) => Effect.Effect<void>;
  readonly subscribeColorScheme: Stream.Stream<'light' | 'dark'>;
  readonly scrollMainTop: () => Effect.Effect<void>;
}

const resolveSystemScheme = (): 'light' | 'dark' => {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
};

export class WindowEnv extends Context.Service<WindowEnv, WindowEnvShape>()(
  'mcp-gateway/WindowEnv',
) {
  static readonly live = Layer.succeed(WindowEnv, {
    initialLanguages: () =>
      Effect.sync(() =>
        typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]),
      ),
    appTitle: () =>
      Effect.sync(() =>
        typeof document !== 'undefined' && document.title ? document.title : 'MCP Gateway',
      ),
    syncLang: (tag) =>
      Effect.sync(() => {
        if (typeof document !== 'undefined') {
          document.documentElement.lang = tag;
        }
      }),
    syncAppearance: (preference) =>
      Effect.sync(() => {
        if (typeof document === 'undefined') return;
        const resolved = preference === 'system' ? resolveSystemScheme() : preference;
        document.documentElement.dataset.appearance = resolved;
      }),
    subscribeColorScheme: Stream.callback<'light' | 'dark'>(
      Effect.fnUntraced(function* (queue) {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const listener = () => {
          Queue.offerUnsafe(queue, media.matches ? 'dark' : 'light');
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            media.addEventListener?.('change', listener);
          }),
          () =>
            Effect.sync(() => {
              media.removeEventListener?.('change', listener);
            }),
        );
      }),
    ),
    scrollMainTop: () =>
      Effect.sync(() => {
        if (typeof document === 'undefined') return;
        const main = document.querySelector<HTMLElement>('main[data-tab]');
        if (main) main.scrollTop = 0;
      }),
  });

  static readonly test = (overrides: Partial<WindowEnvShape> = {}) =>
    Layer.succeed(WindowEnv, {
      initialLanguages: () => Effect.succeed(['en']),
      appTitle: () => Effect.succeed('MCP Gateway'),
      syncLang: () => Effect.void,
      syncAppearance: () => Effect.void,
      subscribeColorScheme: Stream.never,
      scrollMainTop: () => Effect.void,
      ...overrides,
    });
}
