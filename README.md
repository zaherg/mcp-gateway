# MCP Gateway

A macOS menu-bar app that exposes local stdio and remote Streamable HTTP MCP servers on a trusted LAN.
Built with Electrobun, Bun, React, TypeScript, Effect, and Tailwind CSS v4.

> Built with Codex (GPT 6 Astra) so Linux-hosted Hermes agents could access [Bear](https://bear.app/?src=https://github.com/zaherg/mcp-gateway).
> For a gateway with more capabilities, see [Executor](https://executor.sh/?src=https://github.com/zaherg/mcp-gateway).

## Platform status

The signed [0.2.0 release](RELEASE.md) targets macOS 14+ on arm64.
Linux desktop behavior and mandatory Ubuntu native CI are implemented in source; actual Linux execution is not yet verified.
Windows has a packaging command only; its runtime port remains out of scope.

## Use

Copy the app from the DMG to a writable location, open it, and select its menu-bar icon.
The gateway starts stopped, with no servers configured.

1. Add a local executable and arguments, or an HTTP(S) MCP upstream.
2. Choose a private IPv4 interface, port, and bearer token in Settings.
3. Save and select **Start gateway**.
4. Copy the server's client configuration into your MCP client.

Each server has its own endpoint, such as `http://192.168.1.120:8765/mcp/bear`.
Use `127.0.0.1` for access from this Mac only.
**Mounted** means the route is ready; backends connect when clients use them.

**Cmd+W** closes the window without stopping the gateway; **Cmd+Q** stops the listener and owned backends, then exits.
On Linux, closing minimizes to a reachable taskbar entry, retaining the gateway and Logs without a tray extension.
Use the visible **Quit MCP Gateway** button to stop the app; Linux application-menu shortcuts are unavailable.
The macOS-only Bear preset permits all accessible notes and tools, including writes; encrypted notes remain subject to Bear's restrictions.

## Security

- Use a trusted LAN: HTTP does not encrypt tokens, tool arguments, or note contents.
- Connections require a bearer token and must come from the selected private subnet or loopback.
- Configure upstream credentials separately; client authorization is not forwarded.
- Protect the Mac and configuration files: configured commands can execute programs.
- Copied client configuration contains the token; Logs can contain credentials and note data.

Keep the Mac awake and connected; DHCP can change its address.

## Configuration

Use one `mcp.json` or `mcp.jsonc` in `~/Library/Application Support/MCP Gateway/` on macOS.
Linux uses `$XDG_CONFIG_HOME/MCP Gateway/`, or `~/.config/MCP Gateway/` when XDG_CONFIG_HOME is unset; a supplied XDG_CONFIG_HOME must be absolute.
An absolute `MCP_GATEWAY_DATA_DIR` overrides either location.

- `.json` requires strict JSON; `.jsonc` accepts comments and trailing commas.
- Both files present is an error; when neither exists, the app creates `mcp.json`.
- Quit before renaming the file, then reopen the app.
- UI edits preserve retained comments and unchanged saves preserve bytes.
- Files are owner-only; symlinks are refused and invalid external edits stop the gateway.

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 8765,
    "token": "${MCP_GATEWAY_TOKEN}"
  },
  "mcpServers": {
    "bear": {
      "command": "/Applications/Bear.app/Contents/MacOS/bearcli",
      "args": ["mcp-server"]
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${UPSTREAM_TOKEN}" },
      "disabled": true
    }
  }
}
```

`${NAME}` uses the app's environment, not shell startup files; missing variables are errors, including in disabled servers.
Use full executable paths when needed.
Stdio entries accept `command`, `args`, `env`, `cwd`, and `disabled`; HTTP entries accept `url`, `headers`, and `disabled`.
Unknown fields and duplicate keys are rejected.

Server names contain 1 to 64 ASCII letters, digits, underscores, or hyphens and start with a letter or digit.
Tokens require 32 to 512 non-space printable ASCII characters; configuration is limited to 1 MiB and 64 servers.
If a crash leaves `mcp.json.lock`, quit every instance and confirm no writer is active before removing it.
After repairing invalid configuration, start the gateway explicitly.

## Startup

- **Launch app at login:** opens the macOS menu-bar app in the background; automatic registration is explicitly unavailable on Linux.
- **Start gateway when the app opens:** independently enables automatic exposure.

Both are off by default.
Apply login changes through the UI, not just the configuration file; macOS may require approval under **System Settings > General > Login Items**.
Keep the app in a stable location before enabling login startup.

## Logs and notifications

**Logs**, below Settings, supports level/server/text filtering and clearing.
History stays in memory: closing the window keeps it; quitting discards it.
Retention is limited to 500 entries / 4 MiB, with 32 KiB per entry; logs are not automatically saved or exposed over the LAN.
Dismissing a banner does not fix or clear the underlying failure; a new occurrence can appear again.

## Build from source

Install Bun 1.4.4 and Node, then install dependencies:

```sh
bun install --ignore-scripts --cache-dir .cache/bun
```

### macOS builds

Requires an arm64 Mac and Apple's Command Line Tools.
SDK preparation and UI compilation are automatic.

```sh
bun run build  # Development package
bun run dev    # Build and launch
```

`bun run release` signs and notarizes the app.
It requires a Developer ID Application identity in Keychain and `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_PASSWORD`.
Export them or use a local `.env` based on `.env.example`; exported values take precedence.
Never commit credentials.
Use `MCP_GATEWAY_BUILD_ROOT` to select a project-relative output folder.

### Linux source builds

Build natively on Linux x64 or arm64, with GTK3, WebKitGTK 4.1, Ayatana AppIndicator, librsvg, and an X11/XWayland desktop.

```sh
bun run build         # Development bundle, not an installer
bun run build:linux   # Experimental unsigned stable packaging
```

The development launcher is `build/dev-linux-x64/MCPGateway-dev/bin/launcher` (substitute arm64 when applicable).
No Apple credentials or macOS login library are used on Linux.
Native Linux execution, Wayland/XWayland desktops, tray interaction, and installed packages remain unverified pending a native run.
CI checks the development bundle under isolated Xvfb, DBus, and Openbox without disabling the WebKit sandbox.

### Windows packaging only

`bun run build:windows` selects experimental unsigned stable packaging on Windows x64 or arm64.
The Windows runtime remains explicitly unsupported; storage security and descendant cleanup are not ported or bypassed.
See [platform prerequisites](https://docs.electrobun.dev/electrobun/guides/cross-platform-development/) for native libraries and WebView2 requirements.

### Generated directories

`dist/` holds generated UI, `build/` holds app bundles, and `artifacts/` holds distributions and verification files.
Keep `dist/` ignored at the project root; Vite clears its contents, including a nested `.gitignore`.

### Tests

[GitHub Actions](.github/workflows/test.yml) requires these checks plus a development build and native WebKitGTK smoke on Ubuntu 24.04 x64 for pushes, pull requests, and manual runs.
Hosted execution has not yet been performed.

```sh
bun run prepare:sdk
bun run typecheck && bun run lint
bun run test:e2e && bun run test:components && bun run test:unit
```

Browser tests require Google Chrome and use synthetic servers, not real Bear notes.
See [test details](tests/README.md) and [release results](RELEASE.md).
