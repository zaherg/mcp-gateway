# MCP Gateway

A macOS menu-bar app that exposes local stdio and remote Streamable HTTP MCP servers on a trusted LAN.

## Platform status

macOS on Apple silicon (arm64) is supported. The binaries require macOS 14.0 or newer; behavior on the minimum version has not been tested.
Linux and Windows are not supported.

## Use

Download a signed, notarized DMG from [GitHub Releases](https://github.com/zaherg/mcp-gateway/releases), copy the app to a writable location, and open it.

1. Add a local executable or HTTP(S) MCP upstream.
2. In Settings, choose a private IPv4 interface, port, and bearer token.
3. Start the gateway, then copy its configuration into your MCP client.

Each server has its own endpoint, such as `http://192.168.1.120:8765/mcp/bear`. Use `127.0.0.1` to restrict access to this Mac.
`Cmd+W` closes the window but keeps the gateway running. `Cmd+Q` stops the listener and owned backends, then exits.
The Bear preset permits all tools, including writes.

Logs stay in memory until you quit. **Launch app at login** is off by default.
While that setting is on, the app opens in the background at every launch, and the window opens from the menu-bar icon.

## Compatibility

By default, an endpoint serves only MCP protocol `2026-07-28`, which is stateless: every message is a `POST` to `/mcp/<name>`.
`GET` and `DELETE` return 405, and requests for older protocol versions or the `initialize` handshake return 400.
Stdio servers are bridged by the gateway.
An HTTP upstream must answer `server/discover` with `2026-07-28`; other upstreams are refused.

For clients that do not support `2026-07-28` yet, enable **Allow session-based clients** on a server, or set `"legacyProtocol": true` on it in `mcp.json`.
That endpoint then also serves session-based MCP (`2025-11-25` and earlier, as negotiated by the client), including the official `StreamableHTTPClientTransport`: `initialize`, the `Mcp-Session-Id` header, the `GET` event stream and `DELETE`.
An HTTP upstream on such an endpoint is reached as a session-based server, so it does not need to speak `2026-07-28`.
Each session runs its own backend process or upstream session.
At most 8 sessions are open across all endpoints, and each also uses one of the 16 shared backend slots; a new session beyond either limit gets 429.
A session with no open request or event stream ends after 60 seconds, and the client must initialize again.
Session requests share the 16 outstanding-call limit and the 4 MiB backend message limit with stateless requests.
App versions up to `0.3.2` reject a configuration that contains `legacyProtocol`.

## Automatic updates

Updates use the built-in Electrobun updater and the fixed feed `https://github.com/zaherg/mcp-gateway/releases/latest/download`.
Only signed stable builds can update. Development builds report that updates are unsupported and never contact the feed.
Automatic checks and downloads are on by default: a check runs about 10 seconds after launch and then daily, and a failed check or download is retried about hourly.
Turn them off in **Settings → Updates**; the choice is stored in `updates.json` beside `mcp.json`.
A release is offered only when its version is higher than the installed one.
Check manually in **Settings → Updates**. Installing requires **Restart to Update**. After confirmation, that stops the gateway and discards unsaved configuration.
If the handoff fails, the gateway stays stopped; quit and reopen the app to retry.
`0.3.2` is the first updater-capable release.
`0.3.0` has no updater, so upgrade from it manually with the `0.3.2` or later DMG.
A local rehearsal updated a signed, non-notarized test build through a loopback feed that redirected to an HTTPS test feed (see `deployment.md`).
The live GitHub update path from one published release to the next has not been exercised.

## Security

- Use a trusted LAN only: HTTP traffic is unencrypted.
- Requests need the bearer token and must originate from the selected subnet or loopback.
- The `Host` header must match the configured address and port, and a present `Origin` must match the gateway origin.
- Upstream credentials are configured separately, and client tokens are not forwarded.
- `mcp.json` can start processes, so protect it. Logs and copied client configurations can expose tokens and note data.

The gateway allows 32 concurrent HTTP requests and 240 admissions per minute.
At most 16 backend calls can be in flight across all servers; extra calls receive a capacity error.
At most 16 backend processes or upstream connections are held at once across all servers.
A slot is released on a matching reply or confirmed backend cleanup; cancelling a request does not necessarily release it immediately.
Request bodies, backend stdout lines, and backend HTTP response bodies are capped at 4 MiB; successful SSE streams have a 4 MiB per-event limit instead.
Requests time out after 30 seconds.

## Configuration

Use one `mcp.json` or `mcp.jsonc`. It belongs in `~/Library/Application Support/MCP Gateway/`, which cannot be changed.
The app also keeps `updates.json` (the automatic-update preference) in that folder.
A `.json` file must be strict JSON, while `.jsonc` allows comments and trailing commas. Having both files present is an error. Quit the app before renaming the file, then reopen it. Files are owner-only, and symlinks are refused.
If a crash leaves `mcp.json.lock` beside the configuration, quit every app instance and confirm no writer is active before removing the lock and retrying.

```json
{
  "gateway": { "host": "127.0.0.1", "port": 8765, "token": "${MCP_GATEWAY_TOKEN}" },
  "mcpServers": {
    "bear": { "command": "/Applications/Bear.app/Contents/MacOS/bearcli", "args": ["mcp-server"] },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${UPSTREAM_TOKEN}" },
      "disabled": true
    }
  }
}
```

`gateway` accepts `host`, `port`, `token`, `autoStart`, and `launchAtLogin`.
The host must be a currently assigned private IPv4 or loopback address, and the port must be 1 to 65535.
`${NAME}` reads the app environment, not your shell startup files. Missing variables are errors.
Stdio entries accept `command`, `args`, `env`, `cwd`, and `disabled`; HTTP entries accept `url`, `headers`, and `disabled`.
Server names contain 1 to 64 ASCII letters, digits, `_`, or `-` and start with a letter or digit.
Tokens require 32 to 512 non-space printable ASCII characters; configuration is limited to 1 MiB and 64 servers.

## Build from source

Install Bun 1.4.4 and Node. macOS builds also need Command Line Tools.

```sh
bun install --frozen-lockfile --ignore-scripts --cache-dir .cache/bun
bun run build  # Development package
bun run dev    # Build and launch
```

`bun run release` signs and notarizes the app. It requires exactly one Developer ID Application identity in Keychain, plus `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_PASSWORD` as environment variables or in `.env`.
By default, it writes to `build/v<version>/` and `artifacts/v<version>/`, using the version from `package.json`.
Both output directories must be absent or empty, stay inside the project, and have no symlink ancestors.
The check is not a lock, so concurrent builds must use separate directories.
Build and verify the default release from the repository root:

```sh
bun run release
bun scripts/verify-release.ts
```

To build another candidate of the same version without replacing existing files, set `MCP_GATEWAY_BUILD_ROOT` and `MCP_GATEWAY_ARTIFACTS_DIR` to fresh relative paths for both commands.

After verification passes, an updater-capable release must publish `macos-arm64-MCPGateway.dmg`, `stable-macos-arm64-update.json`, `stable-macos-arm64-update-v2.json`, and `stable-macos-arm64-MCPGateway.app.tar.zst`, all matching the version in `package.json`.
Published releases also include a `SHA256SUMS` file; `bun run release` does not generate it.

Run `bun run typecheck` and `bun run lint` for source checks. This repository has no test suites.
See [deployment.md](deployment.md#tests) for the lint workflow checks.

## Source conventions

Use named `const` arrow functions for ordinary implementations, including React components, hooks, and scripts.
Keep class and object methods, constructors, accessors, and declaration-only signatures in their existing forms to preserve their semantics.
Import TypeScript and JavaScript under `src/` through `@mcp-gateway/...`, including same-folder imports; the alias is configured for TypeScript, Bun, and Vite.
Imports outside `src/`, such as script helpers and root `package.json`, remain relative, as do CSS and resource paths.
Do not use parent traversal inside the alias or add a second root alias.
`dependencies` lists only the packages loaded from `node_modules` at runtime (the externals in `electrobun.config.ts`), and bundled packages belong in `devDependencies`.
