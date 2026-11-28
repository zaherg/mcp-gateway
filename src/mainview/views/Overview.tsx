import type { Renderer } from '@effect/ui';
import { BrowserHost } from '@effect/ui/html';
import { DevTools } from '@effect/ui-devtools';
import { Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { useEffect, useMemo, useRef } from 'react';

import { useGatewayView } from '@mcp-gateway/mainview/context/GatewayViewContext';
import { bearPreset, emptyEditor } from '@mcp-gateway/mainview/dialogs/ServerEditor';
import {
  OverviewCommandLayers,
  OverviewMessage,
  type OverviewModel,
  type OverviewProps,
  OverviewView,
} from '@mcp-gateway/mainview/effect-overview/OverviewView';
import {
  OverviewActions,
  type OverviewCallbacks,
  TestServerOutcome,
} from '@mcp-gateway/mainview/effect-overview/services';
import { useI18n } from '@mcp-gateway/mainview/i18n';

type OverviewRoot = Renderer.Root<
  typeof OverviewModel.Type,
  typeof OverviewMessage.Type,
  typeof OverviewProps.Type
>;

export const Overview = () => {
  const {
    gateway,
    config,
    snapshot,
    dirty,
    error,
    operationalError,
    clearError,
    dismissOperationalError,
    openKeyMigration,
    dismissKeyReminder,
    configurationLocked,
    run,
    client,
    openServerEditor,
    toggleServer,
    deleteServer,
    setEditor,
    setEditorError,
  } = useGatewayView();
  const { locale } = useI18n();

  const overviewProps = useMemo<typeof OverviewProps.Type>(() => {
    const servers = config
      ? Object.entries(config.mcpServers).map(([name, server]) => {
          const live = gateway?.servers.find((item) => item.name === name);
          const status = live?.status ?? (server.disabled ? 'disabled' : 'stopped');
          const http = 'url' in server;
          return {
            name,
            transport: http ? ('http' as const) : ('stdio' as const),
            target: http ? server.url : server.command,
            disabled: Boolean(server.disabled),
            status,
            hasLive: live !== undefined,
            liveError: live?.error?.message ?? null,
          };
        })
      : [];

    return {
      locale,
      hasConfig: config !== null,
      dirty,
      running: Boolean(gateway?.running),
      revision: gateway?.revision ?? null,
      listenerAddress: config ? `${config.gateway.host}:${config.gateway.port}` : null,
      configurationLocked,
      hasConfigError: Boolean(gateway?.configError),
      configErrorCode: gateway?.configError?.code ?? null,
      error,
      operationalError: operationalError
        ? { code: operationalError.code, message: operationalError.message }
        : null,
      keyReminder: Boolean(snapshot?.keyReminder),
      servers,
    };
  }, [config, configurationLocked, dirty, error, gateway, locale, operationalError, snapshot]);

  const mountStatusKey = useMemo(
    () =>
      JSON.stringify([
        overviewProps.running,
        overviewProps.servers.map((server) => [server.name, server.status]),
      ]),
    [overviewProps.running, overviewProps.servers],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<OverviewRoot | null>(null);
  const latestPropsRef = useRef(overviewProps);
  latestPropsRef.current = overviewProps;

  const callbacksRef = useRef<OverviewCallbacks>({
    clearError: () => {},
    dismissOperationalError: () => {},
    dismissKeyReminder: () => {},
    openKeyMigration: () => {},
    openServerEditor: () => {},
    openBearPreset: () => {},
    toggleServer: async () => {},
    deleteServer: async () => {},
    copyClientConfig: async () => false,
    testServer: async () => TestServerOutcome.Unavailable(),
  });
  callbacksRef.current = {
    clearError,
    dismissOperationalError,
    dismissKeyReminder,
    openKeyMigration,
    openServerEditor,
    openBearPreset: () => {
      if (configurationLocked) return;
      setEditorError(null);
      setEditor({ ...emptyEditor(), ...bearPreset() });
    },
    toggleServer,
    deleteServer,
    copyClientConfig: (name) => run(() => client.copyClientConfig({ name }), ''),
    testServer: async (name, expectedRevision) => {
      try {
        const result = await client.testServer({ name, expectedRevision });
        if (result.ok) {
          return TestServerOutcome.Passed({ protocolVersion: result.value.protocolVersion });
        }
        return result.error.code === 'Cancelled'
          ? TestServerOutcome.Cancelled({ message: result.error.message })
          : TestServerOutcome.Failed({ message: result.error.message });
      } catch {
        return TestServerOutcome.Unavailable();
      }
    },
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scope = Scope.makeUnsafe();
    const useDevTools = import.meta.env.DEV && !('Bun' in globalThis);
    const commandLayers = OverviewCommandLayers.pipe(
      Layer.provide(OverviewActions.fromRef(callbacksRef)),
    );
    const layers = useDevTools
      ? Layer.mergeAll(commandLayers, DevTools.layer({ position: 'BottomRight' }))
      : commandLayers;

    const mountProgram = Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(layers, scope);
      return yield* BrowserHost.mountEffect(OverviewView, latestPropsRef.current, container, {
        head: false,
      }).pipe(Effect.provideContext(context), Effect.provideService(Scope.Scope, scope));
    });

    let disposed = false;
    let mountFiber: Fiber.Fiber<OverviewRoot> | null = null;

    if (useDevTools) {
      mountFiber = Effect.runFork(
        mountProgram.pipe(
          Effect.tap((root) =>
            Effect.sync(() => {
              if (disposed) return;
              rootRef.current = root;
              root.setProps(latestPropsRef.current);
            }),
          ),
        ),
      );
    } else {
      rootRef.current = Effect.runSync(mountProgram);
    }

    return () => {
      disposed = true;
      rootRef.current = null;
      const closeScope = Scope.close(scope, Exit.void);
      Effect.runFork(
        mountFiber ? Fiber.interrupt(mountFiber).pipe(Effect.andThen(closeScope)) : closeScope,
      );
    };
  }, []);

  useEffect(() => {
    rootRef.current?.setProps(overviewProps);
  }, [overviewProps]);

  useEffect(() => {
    if (!mountStatusKey) return;
    rootRef.current?.send(OverviewMessage.ClearedOutdatedTest());
  }, [mountStatusKey]);

  return <div ref={containerRef} className="min-w-0" />;
};
