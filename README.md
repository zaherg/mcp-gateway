# MCP Gateway

A macOS menu-bar app that exposes local stdio and remote Streamable HTTP MCP servers on a trusted LAN.

> Built with Codex (GPT 6 Astra) for Linux-hosted Hermes agents using [Bear](https://bear.app/?src=https://github.com/zaherg/mcp-gateway).

## Platform status

macOS 14+ on arm64 is supported. Linux builds are unverified. Windows packaging is experimental, and its runtime is unsupported.

## Use

Download a signed, notarized DMG from [GitHub Releases](https://github.com/zaherg/mcp-gateway/releases), copy the app to a writable location, and open it.

1. Add a local executable or HTTP(S) MCP upstream.
2. In Settings, choose a private IPv4 interface, port, and bearer token.
3. Start the gateway, then copy its configuration into your MCP client.

Each server has its own endpoint, such as `http://192.168.1.120:8765/mcp/bear`. Use `127.0.0.1` to restrict access to this Mac.
`Cmd+W` closes the window but keeps the gateway running. `Cmd+Q` stops the listener and owned backends, then exits.
The Bear preset permits all tools, including writes.

Logs stay in memory until you quit. **Launch app at login** is off by default.

## Automatic updates

Automatic checks and downloads are enabled by default for the signed macOS arm64 stable build. Updates come from `https://github.com/zaherg/mcp-gateway/releases/latest/download`.
Check manually in **Settings → Updates**. Installing requires **Restart to Update**. After confirmation, that stops the gateway and discards unsaved configuration.
Automatic updates are not yet available: packaged acceptance for `0.3.1` is incomplete, and no updater-capable release has been published. Because `0.3.0` has no updater, install the first updater-capable release manually. See [validation results](tests/UPDATER-VALIDATION.md).

## Security

- Use a trusted LAN only: HTTP traffic is unencrypted.
- Requests need the bearer token and must originate from the selected subnet or loopback.
- Upstream credentials are configured separately, and client tokens are not forwarded.
- `mcp.json` can start processes, so protect it. Logs and copied client configurations can expose tokens and note data.

The gateway allows 32 concurrent requests and 240 admissions per minute. Request bodies and backend output are capped at 4 MiB, and requests time out after 30 seconds.

## Configuration

Use one `mcp.json` or `mcp.jsonc`. On macOS it belongs in `~/Library/Application Support/MCP Gateway/`; on Linux, use `$XDG_CONFIG_HOME/MCP Gateway/`, or `~/.config/MCP Gateway/` when the variable is unset. An absolute `MCP_GATEWAY_DATA_DIR` overrides either location.
A `.json` file must be strict JSON, while `.jsonc` allows comments and trailing commas. Having both files present is an error. Quit the app before renaming the file, then reopen it. Files are owner-only, and symlinks are refused.

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

`${NAME}` reads the app environment, not your shell startup files. Missing variables are errors.
Stdio entries accept `command`, `args`, `env`, and `cwd`; HTTP entries accept `url` and `headers`.
Server names contain 1 to 64 ASCII letters, digits, `_`, or `-`. Tokens require 32 to 512 printable characters, and configuration is limited to 1 MiB and 64 servers.

## Build from source

Install Bun 1.4.4 and Node. macOS builds also need Command Line Tools.

```sh
bun install --ignore-scripts --cache-dir .cache/bun
bun run build  # Development package
bun run dev    # Build and launch
```

`bun run release` signs and notarizes the app. It requires exactly one Developer ID Application identity in Keychain, plus `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_PASSWORD` as environment variables or in `.env`.
`bun run build:linux` and `bun run build:windows` produce experimental unsigned packages and must run on their target platform. Linux builds require GTK3, WebKitGTK 4.1, Ayatana AppIndicator, librsvg, and X11/XWayland. Windows builds require WebView2.
