import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { electrobunViteAliases } from './.hutch/devkit/api/config/electrobun-vite.ts';

const nonce = randomBytes(16).toString('base64');

export default defineConfig({
  root: 'src/mainview',
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    {
      // Vite nonces its refresh preamble and injected styles; packaged CSP is unchanged.
      name: 'development-csp',
      apply: 'serve',
      config: () => ({ html: { cspNonce: nonce } }),
      transformIndexHtml: {
        order: 'pre',
        handler: (html) => {
          const policy = "script-src 'self'; style-src 'self'; connect-src ws://127.0.0.1:*;";
          if (!html.includes(policy))
            throw new Error('The development CSP transform must match the renderer policy.');
          return html.replace(
            policy,
            `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'; connect-src 'self' ws://127.0.0.1:*;`,
          );
        },
      },
    },
  ],
  resolve: {
    alias: [
      ...electrobunViteAliases('.hutch/devkit'),
      {
        find: /^@mcp-gateway\//,
        replacement: `${resolve(import.meta.dirname, 'src')}/`,
      },
    ],
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
  },
  server: { host: '127.0.0.1', strictPort: true },
});
