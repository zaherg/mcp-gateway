import { Context, Data, Effect, Layer } from 'effect';

import type { AppClient } from '@mcp-gateway/shared/rpc';
import { LOG_LIMITS, type LogPage, type LogQuery } from '@mcp-gateway/shared/types';

export class LogRpcError extends Data.TaggedError('LogRpcError')<{
  readonly kind: 'rpc' | 'bridge';
  readonly message: string;
}> {}

export class LogsRpc extends Context.Service<
  LogsRpc,
  {
    readonly readLogs: (query: LogQuery) => Effect.Effect<LogPage, LogRpcError>;
    readonly clearLogs: () => Effect.Effect<LogPage, LogRpcError>;
  }
>()('mcp-gateway/LogsRpc') {
  static readonly fromAppClient = (client: AppClient) =>
    Layer.succeed(LogsRpc, {
      readLogs: (query) =>
        Effect.tryPromise({
          try: () => client.readLogs(query),
          catch: () => new LogRpcError({ kind: 'bridge', message: 'readLogs bridge rejected' }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: `${LOG_LIMITS.requestTimeoutMs} millis`,
            orElse: () =>
              Effect.fail(
                new LogRpcError({ kind: 'bridge', message: 'Local log request timed out.' }),
              ),
          }),
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed(result.value)
              : Effect.fail(
                  new LogRpcError({
                    kind: 'rpc',
                    message: `${result.error.code}: ${result.error.message}`,
                  }),
                ),
          ),
        ),
      clearLogs: () =>
        Effect.tryPromise({
          try: () => client.clearLogs(),
          catch: () => new LogRpcError({ kind: 'bridge', message: 'clearLogs bridge rejected' }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: `${LOG_LIMITS.requestTimeoutMs} millis`,
            orElse: () =>
              Effect.fail(
                new LogRpcError({ kind: 'bridge', message: 'Local log request timed out.' }),
              ),
          }),
          Effect.flatMap((result) =>
            result.ok
              ? Effect.succeed(result.value)
              : Effect.fail(
                  new LogRpcError({
                    kind: 'rpc',
                    message: `${result.error.code}: ${result.error.message}`,
                  }),
                ),
          ),
        ),
    });
}

export class LogsDom extends Context.Service<
  LogsDom,
  {
    readonly focusSearchInput: () => Effect.Effect<void>;
    readonly scrollToBottom: () => Effect.Effect<void>;
    readonly isScrolledToBottom: () => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<boolean>;
  }
>()('mcp-gateway/LogsDom') {
  static readonly noop = Layer.succeed(LogsDom, {
    focusSearchInput: () => Effect.void,
    scrollToBottom: () => Effect.void,
    isScrolledToBottom: () => Effect.succeed(true),
    copyText: () => Effect.succeed(true),
  });

  static readonly fromContainer = (container: HTMLElement) =>
    Layer.succeed(LogsDom, {
      focusSearchInput: () =>
        Effect.sync(() => {
          const input = container.querySelector<HTMLInputElement>('input[data-slot="input"]');
          input?.focus();
          input?.select();
        }),
      scrollToBottom: () =>
        Effect.sync(() => {
          const scroller = container.querySelector<HTMLElement>('.log-entries');
          if (scroller) {
            scroller.scrollTop = scroller.scrollHeight;
          }
        }),
      isScrolledToBottom: () =>
        Effect.sync(() => {
          const scroller = container.querySelector<HTMLElement>('.log-entries');
          if (!scroller) return true;
          return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 16;
        }),
      copyText: (text) =>
        Effect.tryPromise({
          try: async () => {
            if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
            await navigator.clipboard.writeText(text);
            return true;
          },
          catch: () => false,
        }).pipe(Effect.catch(() => Effect.succeed(false))),
    });
}
