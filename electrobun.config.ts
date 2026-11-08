import type { ElectrobunConfig } from "electrobun";
import packageInfo from "./package.json";
import { prepareBuildIdentity, releaseArtifactFolder } from "./scripts/build-config";

const UPDATER_FEED_URL = "https://github.com/zaherg/mcp-gateway/releases/latest/download";

const executingBuild = prepareBuildIdentity(import.meta.dir, packageInfo.version);

export default {
  app: {
    name: "MCP Gateway",
    identifier: "dev.srvr.mcpgateway",
    version: packageInfo.version,
  },
  build: {
    buildFolder: process.env.MCP_GATEWAY_BUILD_ROOT ?? "build",
    artifactFolder: releaseArtifactFolder(),
    mainProcess: "bun",
    bun: {
      entrypoint: "src/main/index.ts",
      define: executingBuild.define,
      external: ["supergateway", "supergateway/*", "jsonc-parser"],
    },
    copy: {
      ...executingBuild.copy,
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      "assets/tray.png": "views/assets/tray.png",
      ".cache/native/login.dylib": "native/login.dylib",
      ".cache/runtime-deps/node_modules": "node_modules",
    },
    watchIgnore: ["dist/**", ".cache/**", "node_modules/**", "release/**"],
    mac: {
      bundleCEF: false,
      icons: "assets/App.iconset",
      codesign: true,
      notarize: true,
      createDmg: true,
    },
  },
  runtime: { exitOnLastWindowClosed: false },
  release: { baseUrl: UPDATER_FEED_URL },
} satisfies ElectrobunConfig;
