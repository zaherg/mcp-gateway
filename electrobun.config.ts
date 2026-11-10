import type { ElectrobunConfig } from 'electrobun';

import packageInfo from './package.json';
import { buildIdentity } from './scripts/build-config';

const identity = buildIdentity();

export default {
  app: {
    name: 'MCP Gateway',
    identifier: identity.identifier,
    version: packageInfo.version,
  },
  build: {
    buildFolder: process.env.MCP_GATEWAY_BUILD_ROOT ?? 'build',
    artifactFolder: process.env.MCP_GATEWAY_ARTIFACTS_DIR ?? 'artifacts',
    mainProcess: 'bun',
    bun: {
      entrypoint: 'src/main/index.ts',
      external: ['supergateway', 'supergateway/*', 'jsonc-parser'],
    },
    copy: {
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
      'assets/tray.png': 'views/assets/tray.png',
      '.cache/native/login.dylib': 'native/login.dylib',
      '.cache/runtime-deps/node_modules': 'node_modules',
    },
    watch: ['src/main', 'src/core', 'src/shared'],
    // Vite owns renderer updates; rebuilding the app would discard React state.
    watchIgnore: ['src/mainview/**', 'dist/**', '.cache/**', 'node_modules/**', 'release/**'],
    mac: {
      bundleCEF: false,
      icons: 'assets/App.iconset',
      codesign: true,
      notarize: identity.notarize,
      createDmg: true,
    },
  },
  runtime: {
    exitOnLastWindowClosed: false,
    developmentServerUrl: process.env.MCP_GATEWAY_DEV_SERVER_URL,
  },
  release: { baseUrl: identity.feed },
} satisfies ElectrobunConfig;
