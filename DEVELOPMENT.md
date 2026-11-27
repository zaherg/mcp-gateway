# Development

This guide explains how to build and run MCP Gateway from source on your Mac.
For signed releases, update testing and publishing, see [RELEASING.md](RELEASING.md).
Run every command from the repository root unless a step says otherwise.

## Prerequisites

- An Apple silicon Mac with macOS 14 or later.
- Git, Bun 1.4.4 and Node.js; the CI workflow uses Node.js 26.13.0.
- Xcode Command Line Tools, including `clang` and `swiftc`.
- Network access, to install dependencies and download the pinned Electrobun toolchain.

To install the Command Line Tools, run `xcode-select --install`.

## Build from source

Clone the repository, or use an existing checkout of the revision you want to build:

```sh
git clone https://github.com/zaherg/mcp-gateway.git
cd mcp-gateway
bun install --frozen-lockfile --ignore-scripts --cache-dir .cache/bun
```

Build a development package:

```sh
bun run build
```

Unless `MCP_GATEWAY_BUILD_ROOT` is set, the unsigned development app is `build/dev-macos-arm64/MCP Gateway-dev.app`.
For the signed `MCP Gateway Dev.app` build with Keychain support, see [Testing updates](UPDATE-TESTING.md#build-and-verify-two-versions).
`bun run build` and release builds load the bundled files and need no development server.
A running app can read or change its configuration; see [Configuration](docs/configuration.md).

The build prepares the toolchain by itself and compiles the Objective-C sources in `src/native/` (`keychain.m`, `locale.m`, `login.m`, `notifications.m`, `power.m`, `signals.m`, `tray.m`, `window.m`) into `.cache/native/login.dylib`, linked against `Foundation`, `ServiceManagement`, `AppKit`, `Security` and `UserNotifications`.
It writes generated files under `.cache/`, `.hutch/`, `.hutch-home/`, `dist/`, `assets/` and the chosen build folder.
Builds share these folders, so use a separate checkout for each build that runs at the same time.

## Toolchain

`hutch.config.ts` pins Electrobun 2.0.6 and the matching Hutch 0.29.0.
`bun run prepare:sdk` verifies that `node_modules/electrobun/bin/electrobun.cjs` is installed as a regular file, then uses it to download and verify that toolchain under `.hutch-home/`.
It then copies the SDK into `.hutch/devkit/`.
You do not need a global `hutch` installation.

## Run with live reload

```sh
bun run dev
```

This builds and launches the development app with React hot reload and main-process restart.
It starts Vite on `127.0.0.1:5173` and stops if that port is already in use.
Renderer edits reload in place with React Fast Refresh.
Main-process and shared-code edits rebuild and restart the app.
A restart discards unsaved raw configuration drafts and interrupts gateway requests.
Press `Ctrl+C` to stop the command; it closes Vite and the development app.
Run the command again after changing native code, dependencies or build scripts.

Development builds have **Developer → Open Developer Tools** (`Cmd+Option+I`).
Use it to inspect the renderer, the console and network requests.
Close the inspector with its own close button.
Release builds do not have this menu.

## Checks

Run the available checks:

```sh
bun run typecheck
bun run lint
bun run test
```

`bun run format` formats `src`, `tests`, `scripts`, root `*.ts` and `*.json` files with Biome.

`bun run test` runs the Bun test suite (`bun test`), covering 19 test files across six areas:

- `tests/core/`: stateless `2026-07-28` and session-based MCP adapters, upstream discovery caching, config validation and locking, ingress, `test-server`, controller lifecycle, IPv4/network checks, child process isolation, limits and log redaction.
- `tests/shared/`: configuration document editing and secret detection, i18n formatting, identity, changelog parsing and RPC schemas.
- `tests/main/`: `AppService` RPC handlers, updater verification, quit lifecycle, native FFI wrappers and private preference stores.
- `tests/mainview/`: React components, dialogs, views, `GatewayViewContext`, hooks and renderer utilities under Happy-DOM.
- `tests/scripts/`: build config, toolchain helpers, release artifact verification and DMG/inventory helpers.
- `tests/e2e/`: full-stack tests wiring `<App />`, `AppService` and `McpGatewayController` to live loopback ports, real stdio MCP servers, real Streamable HTTP upstreams and an in-memory Keychain store.

Tests run against temporary folders, loopback ports and mock or in-memory stores; they do not touch your real configuration, Keychain items or external services.
Run a subset with `bun test tests/<folder>`, such as `bun test tests/core` or `bun test tests/e2e`.

`.github/workflows/lint.yml` runs on branch pushes, pull requests, manual runs and calls from the release workflow.
It uses Actionlint 1.7.12, ShellCheck 0.11.0 and Typos 1.52.0, each pinned by checksum.
Actionlint checks the workflows and the shell commands inside them.
ShellCheck also checks tracked `.sh` and `.bash` files.
Typos checks our own source and documentation with the rules in `_typos.toml`.
It skips generated outputs, dependencies, private environment files and vendored skills.
If one linter fails, the others still run, as long as the tools installed correctly.
The workflow only reports findings; it changes no files and runs no test suites.

## Translations

Interface text lives in `src/shared/locales/<language>_<REGION>.json`, one file per locale, such as `en_US.json`.
The region is part of the name because wording differs between countries; `de_DE` and `de_AT` would be separate files.
`en_US.json` is the source: every other file must have exactly its keys, and `bun run typecheck` fails when a key is missing.
Keep each `{placeholder}` unchanged; the app puts names, versions and paths there.
Write plain text only, without HTML or Markdown.
`language.name` is the locale's name in its own language, such as `English (United States)`.

To add a locale:

1. Copy `src/shared/locales/en_US.json` to the new file and translate every value.
2. In `src/shared/i18n.ts`, import the file and add its code to `CATALOG_LOCALES` and `CATALOGS`.
3. Run `bun run typecheck`, `bun run lint` and `bun run test`.

Current locales: `en_US`, `fr_FR`, `de_DE` and `tr_TR`.
When no catalog matches a region exactly, the first listed catalog in the same language is used, so list the preferred regional variant first.
The app picks the first macOS language that matches a locale, by language and region and then by language alone, and falls back to `en_US`.
**Settings → General** shows the language picker; the choice is stored in `language.json` next to `mcp.json`.
Messages from the gateway, servers and logs are not translated.
Right-to-left languages are not supported yet.

## Source conventions

Write ordinary functions as named `const` arrow functions, including React components, hooks and scripts.
Keep class and object methods, constructors, accessors and declaration-only signatures as they are, so their behavior does not change.
Import TypeScript and JavaScript under `src/` through `@mcp-gateway/...`, even from the same folder.
TypeScript, Bun and Vite all understand this alias.
`tsconfig.json` also maps `jsonc-parser` to `./node_modules/jsonc-parser/lib/esm/main`.
Imports from outside `src/`, such as script helpers and the root `package.json`, stay relative.
CSS and resource paths stay relative too.
Do not use `..` inside the alias, and do not add a second root alias.
All runtime JavaScript dependencies (`dependencies` in `package.json`) are bundled directly into the app; `electrobun.config.ts` defines no externals and ships no `node_modules` directory.
Build, UI, lint, typecheck and test packages belong in `devDependencies`.
