import type { ElectrobunConfig } from "electrobun";
import packageInfo from "./package.json";

export default {
  app: {
    name: "MCP Gateway",
    identifier: "dev.srvr.mcpgateway",
    version: packageInfo.version,
  },
  build: {
    buildFolder: process.env.MCP_GATEWAY_BUILD_ROOT ?? "build",
    mainProcess: "bun",
    bun: {
      entrypoint: "src/main/index.ts",
      external: ["supergateway", "supergateway/*", "jsonc-parser"],
    },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      "assets/tray.png": "views/assets/tray.png",
      ...(process.platform === "darwin"
        ? { ".cache/native/login.dylib": "native/login.dylib" }
        : {}),
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
    win: { bundleCEF: false, icon: "assets/App.iconset/icon_256x256.png" },
    linux: { bundleCEF: false, icon: "assets/App.iconset/icon_256x256.png" },
  },
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
