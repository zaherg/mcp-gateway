import type { Renderer } from '@effect/ui';
import { BrowserHost } from '@effect/ui/html';
import { DevTools } from '@effect/ui-devtools';
import { Effect, Exit, Fiber, Layer, Scope } from 'effect';
import { useEffect, useMemo, useRef } from 'react';

import { useGatewayView } from '@mcp-gateway/mainview/context/GatewayViewContext';
import { formatPeersDraft, formatPortDraft } from '@mcp-gateway/mainview/effect-settings/logic';
import {
  SettingsCommandLayers,
  SettingsMessage,
  type SettingsModel,
  type SettingsProps,
  SettingsView,
} from '@mcp-gateway/mainview/effect-settings/SettingsView';
import {
  applyGatewayMutation,
  SettingsActions,
  type SettingsCallbacks,
} from '@mcp-gateway/mainview/effect-settings/services';
import { useI18n } from '@mcp-gateway/mainview/i18n';
import { generateToken } from '@mcp-gateway/mainview/lib/token';
import { parseLanguagePreference } from '@mcp-gateway/shared/i18n';
import { needsLoginRetry, parseAppearancePreference } from '@mcp-gateway/shared/rpc';

type SettingsRoot = Renderer.Root<
  typeof SettingsModel.Type,
  typeof SettingsMessage.Type,
  typeof SettingsProps.Type
>;

export const Settings = () => {
  const {
    config,
    gateway,
    snapshot,
    dirty,
    busy,
    error,
    operationalError,
    clearError,
    dismissOperationalError,
    configurationLocked,
    commitConfig,
    showToken,
    setShowToken,
    filename,
    openKeyMigration,
    changeLanguage,
    changeAppearance,
    revealConfig,
    openConfigInEditor,
    importExternalServers,
  } = useGatewayView();
  const { locale } = useI18n();

  const movable = gateway?.keyMigration;
  const revision = gateway?.revision ?? null;
  const savedHost = config?.gateway.host ?? '';
  const savedPort = config ? formatPortDraft(config.gateway.port) : '';
  const savedPeers = formatPeersDraft(config?.gateway.allowedPeers);
  const savedToken = config?.gateway.token ?? '';
  const savedSyncKey = JSON.stringify([revision, savedHost, savedPort, savedPeers, savedToken]);

  const retryLogin = Boolean(
    snapshot &&
      config &&
      !gateway?.configError &&
      needsLoginRetry(snapshot.login, config.gateway.launchAtLogin ?? false),
  );

  const settingsProps = useMemo<typeof SettingsProps.Type>(
    () => ({
      locale,
      filename,
      hasSnapshot: snapshot !== null,
      dirty,
      busy,
      configurationLocked,
      showToken,
      error,
      operationalError: operationalError
        ? { code: operationalError.code, message: operationalError.message }
        : null,
      revision,
      appearance: snapshot?.appearance ?? 'system',
      languagePreference: snapshot?.language.preference ?? 'system',
      availableLanguages: snapshot ? [...snapshot.language.available] : [],
      login: snapshot
        ? {
            supported: snapshot.login.supported,
            enabled: snapshot.login.enabled,
            error: snapshot.login.error,
          }
        : { supported: false, enabled: false, error: null },
      retryLogin,
      interfaces: gateway
        ? gateway.interfaces.map(({ name, address, kind }) => ({ name, address, kind }))
        : [],
      hasMovableKeys: Boolean(movable && (movable.gateway || movable.servers.length > 0)),
      savedConfig: config
        ? {
            host: config.gateway.host,
            port: config.gateway.port,
            allowedPeers: config.gateway.allowedPeers ? [...config.gateway.allowedPeers] : null,
            token: config.gateway.token ?? null,
            tokenRef: config.gateway.tokenRef ?? null,
            launchAtLogin: config.gateway.launchAtLogin ?? false,
            autoStart: config.gateway.autoStart ?? false,
            keepAwake: config.gateway.keepAwake ?? false,
          }
        : null,
    }),
    [
      busy,
      config,
      configurationLocked,
      dirty,
      error,
      filename,
      gateway,
      locale,
      movable,
      operationalError,
      retryLogin,
      revision,
      showToken,
      snapshot,
    ],
  );

  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<SettingsRoot | null>(null);
  const latestPropsRef = useRef(settingsProps);
  latestPropsRef.current = settingsProps;

  const latestSyncRef = useRef({
    key: savedSyncKey,
    drafts: {
      hostInput: savedHost,
      portInput: savedPort,
      peersText: savedPeers,
      tokenInput: savedToken,
    },
  });
  latestSyncRef.current = {
    key: savedSyncKey,
    drafts: {
      hostInput: savedHost,
      portInput: savedPort,
      peersText: savedPeers,
      tokenInput: savedToken,
    },
  };
  const lastSyncedKeyRef = useRef(savedSyncKey);

  const callbacksRef = useRef<SettingsCallbacks>({
    commitGatewayMutation: () => {},
    clearError: () => {},
    dismissOperationalError: () => {},
    setShowToken: () => {},
    openKeyMigration: () => {},
    changeLanguage: () => {},
    changeAppearance: () => {},
    revealConfig: () => {},
    openConfigInEditor: () => {},
    importExternalServers: async () => null,
    generateToken,
  });
  callbacksRef.current = {
    commitGatewayMutation: (mutation) => {
      if (!config) return;
      void commitConfig({ ...config, gateway: applyGatewayMutation(config.gateway, mutation) });
    },
    clearError,
    dismissOperationalError,
    setShowToken,
    openKeyMigration,
    changeLanguage: (preference) => {
      if (!snapshot) return;
      const parsed = parseLanguagePreference(preference, snapshot.language.available);
      if (parsed) changeLanguage(parsed);
    },
    changeAppearance: (preference) => {
      const parsed = parseAppearancePreference(preference);
      if (parsed) changeAppearance(parsed);
    },
    revealConfig,
    openConfigInEditor,
    importExternalServers,
    generateToken,
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scope = Scope.makeUnsafe();
    const useDevTools = import.meta.env.DEV && !('Bun' in globalThis);
    const commandLayers = SettingsCommandLayers.pipe(
      Layer.provide(SettingsActions.fromRef(callbacksRef)),
    );
    const layers = useDevTools
      ? Layer.mergeAll(commandLayers, DevTools.layer({ position: 'BottomRight' }))
      : commandLayers;

    const mountedSyncKey = latestSyncRef.current.key;
    lastSyncedKeyRef.current = mountedSyncKey;

    const mountProgram = Effect.gen(function* () {
      const context = yield* Layer.buildWithScope(layers, scope);
      return yield* BrowserHost.mountEffect(SettingsView, latestPropsRef.current, container, {
        head: false,
      }).pipe(Effect.provideContext(context), Effect.provideService(Scope.Scope, scope));
    });

    let disposed = false;
    let mountFiber: Fiber.Fiber<SettingsRoot> | null = null;

    if (useDevTools) {
      mountFiber = Effect.runFork(
        mountProgram.pipe(
          Effect.tap((root) =>
            Effect.sync(() => {
              if (disposed) return;
              rootRef.current = root;
              root.setProps(latestPropsRef.current);
              if (latestSyncRef.current.key !== mountedSyncKey) {
                lastSyncedKeyRef.current = latestSyncRef.current.key;
                root.send(SettingsMessage.SyncedSavedConfig(latestSyncRef.current.drafts));
              }
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
    rootRef.current?.setProps(settingsProps);
  }, [settingsProps]);

  useEffect(() => {
    if (!rootRef.current || savedSyncKey === lastSyncedKeyRef.current) return;
    lastSyncedKeyRef.current = savedSyncKey;
    rootRef.current.send(
      SettingsMessage.SyncedSavedConfig({
        hostInput: savedHost,
        portInput: savedPort,
        peersText: savedPeers,
        tokenInput: savedToken,
      }),
    );
  }, [savedHost, savedPeers, savedPort, savedSyncKey, savedToken]);

  return <div ref={containerRef} className="min-w-0" />;
};
