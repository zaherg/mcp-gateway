import type { Renderer } from '@effect/ui';
import { BrowserHost } from '@effect/ui/html';
import { Effect, Exit, Layer, Scope } from 'effect';
import { useEffect, useRef } from 'react';

import {
  LogsCommandLayers,
  LogsMessage,
  type LogsModel,
  LogsView,
  type LogsProps as LogsViewProps,
} from '@mcp-gateway/mainview/effect-logs/LogsView';
import { LogsDom, LogsRpc } from '@mcp-gateway/mainview/effect-logs/services';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import type { AppClient } from '@mcp-gateway/shared/rpc';

interface LogsProps {
  client: AppClient;
  servers: string[];
}

type LogsRoot = Renderer.Root<
  typeof LogsModel.Type,
  typeof LogsMessage.Type,
  typeof LogsViewProps.Type
>;

export const Logs = ({ client, servers }: LogsProps) => {
  const { locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<LogsRoot | null>(null);
  const latestPropsRef = useRef<typeof LogsViewProps.Type>({ servers, locale });
  latestPropsRef.current = { servers, locale };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scope = Scope.makeUnsafe();
    const layers = LogsCommandLayers.pipe(
      Layer.provide(
        Layer.mergeAll(LogsRpc.fromAppClient(client), LogsDom.fromContainer(container)),
      ),
    );

    const root = Effect.runSync(
      Effect.gen(function* () {
        const context = yield* Layer.buildWithScope(layers, scope);
        return yield* BrowserHost.mountEffect(LogsView, latestPropsRef.current, container, {
          head: false,
        }).pipe(Effect.provideContext(context), Effect.provideService(Scope.Scope, scope));
      }),
    );
    rootRef.current = root;

    // Forward direct `window` keydown dispatches (such as DOM tests targeting `window`)
    // without duplicating events that already originate inside `document`.
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (
        event.target === window &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault();
        root.send(LogsMessage.PressedFindShortcut());
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);

    return () => {
      window.removeEventListener('keydown', onWindowKeyDown);
      rootRef.current = null;
      Effect.runFork(Scope.close(scope, Exit.void));
    };
  }, [client]);

  useEffect(() => {
    rootRef.current?.setProps({ servers, locale });
  }, [servers, locale]);

  return <div ref={containerRef} className="flex min-h-0 flex-1 flex-col" />;
};
