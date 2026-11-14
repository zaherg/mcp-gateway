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

Unless `MCP_GATEWAY_BUILD_ROOT` is set, the development app is `build/dev-macos-arm64/MCP Gateway-dev.app`.
`bun run build` and release builds load the bundled files and need no development server.
A running app can read or change its configuration; see [Configuration](docs/configuration.md).

The build prepares the toolchain by itself.
It writes generated files under `.cache/`, `.hutch/`, `.hutch-home/`, `dist/`, `assets/` and the chosen build folder.
Builds share these folders, so use a separate checkout for each build that runs at the same time.

## Toolchain

`hutch.config.ts` pins Electrobun 2.0.6 and the matching Hutch 0.29.0.
`bun run prepare:sdk` uses the installed Electrobun bootstrap to download and verify that toolchain under `.hutch-home/`.
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
A restart discards unsaved drafts and interrupts gateway requests.
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
```

This repository has no unit, component, browser or packaged-acceptance test suites.

`.github/workflows/lint.yml` runs on branch pushes, pull requests, manual runs and calls from the release workflow.
It uses Actionlint 1.7.12, ShellCheck 0.11.0 and Typos 1.52.0, each pinned by checksum.
Actionlint checks the workflows and the shell commands inside them.
ShellCheck also checks tracked `.sh` and `.bash` files.
Typos checks our own source and documentation with the rules in `_typos.toml`.
It skips generated outputs, dependencies, private environment files and vendored skills.
If one linter fails, the others still run, as long as the tools installed correctly.
The workflow only reports findings; it changes no files and runs no test suites.

## Source conventions

Write ordinary functions as named `const` arrow functions, including React components, hooks and scripts.
Keep class and object methods, constructors, accessors and declaration-only signatures as they are, so their behavior does not change.
Import TypeScript and JavaScript under `src/` through `@mcp-gateway/...`, even from the same folder.
TypeScript, Bun and Vite all understand this alias.
Imports from outside `src/`, such as script helpers and the root `package.json`, stay relative.
CSS and resource paths stay relative too.
Do not use `..` inside the alias, and do not add a second root alias.
`dependencies` lists only packages loaded from `node_modules` at runtime, which are the externals in `electrobun.config.ts`.
Bundled packages belong in `devDependencies`.
