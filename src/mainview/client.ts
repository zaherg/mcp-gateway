import { Electroview } from 'electrobun/view';

import type { AppClient, AppRPC } from '@mcp-gateway/shared/rpc';

// One native bridge for the lifetime of the renderer. No HTTP administration API.
const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: 120_000,
  handlers: {
    requests: {
      interactiveQuit: () =>
        !window.dispatchEvent(new Event('mcp-gateway:request-quit', { cancelable: true })),
    },
    messages: {},
  },
});
new Electroview({ rpc });
export const client: AppClient = rpc.request;
