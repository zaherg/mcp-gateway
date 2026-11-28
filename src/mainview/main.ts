import { BrowserHost } from '@effect/ui/html';
import { Effect, Layer } from 'effect';

import {
  client,
  onMenuCommand,
  onSnapshotChanged,
  setUnsavedRawConfigChecker,
} from '@mcp-gateway/mainview/client';
import { AppLiveLayers, AppRoot } from '@mcp-gateway/mainview/effect-app/AppView';
import { GatewayRpc, WindowEnv } from '@mcp-gateway/mainview/effect-app/services';
import { alertClasses } from '@mcp-gateway/mainview/effect-ui';

import './styles/styles.css';

// The renderer shows document.title as the app name; index.html holds the production name.
if (import.meta.env.VITE_APP_NAME) document.title = import.meta.env.VITE_APP_NAME;
if (typeof window.matchMedia === 'function') {
  document.documentElement.dataset.appearance = window.matchMedia('(prefers-color-scheme: dark)')
    .matches
    ? 'dark'
    : 'light';
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root.');

const envLayer = Layer.mergeAll(
  GatewayRpc.live(client, {
    onSnapshotChanged,
    onMenuCommand,
    setUnsavedRawConfigChecker,
  }),
  WindowEnv.live,
);

const runtimeLayer = Layer.mergeAll(envLayer, AppLiveLayers.pipe(Layer.provide(envLayer)));

Effect.runFork(
  Layer.launch(
    BrowserHost.mount(AppRoot, {}, root, {
      head: false,
      fallback: (_failure, h) =>
        h.main
          .class('flex min-h-screen items-center justify-center p-6')
          .children(
            h.div
              .attr('role', 'alert')
              .class(alertClasses('error', 'max-w-md'))
              .children('Unable to render MCP Gateway. Restart the application to recover.'),
          ),
    }).pipe(Layer.provide(runtimeLayer)),
  ),
);
