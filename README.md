# MCP Gateway

A macOS menu-bar app that exposes local stdio and remote Streamable HTTP MCP servers on a trusted LAN.
Built with Electrobun, Bun, React, TypeScript, Effect, and Tailwind CSS v4.

> [!IMPORTANT]
> 
> Current version was built with Codex (GPT 6 Astra) so that my linux-hosted Hermes agents could access [Bear](https://bear.app/?src=https://github.com/zaherg/mcp-gateway).
> 
> For a gateway with more capabilities, see [Executor](https://executor.sh/?src=https://github.com/zaherg/mcp-gateway).

## Platform status

macOS builds target macOS 14+ on arm64; development builds and native lifecycle checks have passed locally.
Linux desktop behavior and an Ubuntu native CI job are implemented in source, but native Linux execution and a hosted CI run remain unverified.
Windows provides experimental packaging commands only; its runtime remains unsupported, and storage security and descendant cleanup are not ported or bypassed.

## Use

DMG files published on [GitHub Releases](https://github.com/zaherg/mcp-gateway/releases) are signed and notarized.
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
Interactive Quit requests share the window's confirmation for unsaved configuration and open server dialogs.
Cancelling preserves those drafts; process signals retain noninteractive graceful shutdown.
On Linux, closing minimizes to a reachable taskbar entry and keeps the gateway and Logs running without a tray extension.
Use the visible **Quit MCP Gateway** button to stop the app; Linux application-menu shortcuts are unavailable.
The macOS-only Bear preset permits all accessible notes and tools, including writes; encrypted notes remain subject to Bear's restrictions.

### Startup and logs

**Launch app at login** opens the macOS menu-bar app in the background; automatic registration is unavailable on Linux.
**Start gateway when the app opens** independently enables automatic exposure.
Both are off by default; apply login changes through the UI, not just the configuration file.
On macOS, keep the app in a stable location before enabling login startup; approval may be required under **System Settings > General > Login Items**.

**Logs** stay in memory: closing the window keeps them, and quitting discards them.
Retention is limited to 500 entries / 4 MiB, with 32 KiB per entry.
Logs are not saved automatically or exposed over the LAN.
Dismissing a banner does not resolve the underlying failure; a new occurrence can appear again.

### Automatic updates

The 2026-11-05 validation passed source/SDK checks and fresh signed `0.3.1` build verification, but packaged acceptance remains incomplete.
The required delayed-renderer case failed twice before its completed-startup marker and update-trigger receipt; attribution to the application or fixture remains unresolved.
The HTTP-503 case also had two failures before three passing diagnostic-fixture runs.
See [validation results](IMPLEMENTATION-PLAN.md#validation-results-2026-11-05) for evidence, passing cases, and limits.
No release was published or installed.
The public latest release remains `0.3.0`, which has no updater, and the required updater assets are not published.

Automatic updates are limited to the signed macOS arm64 stable distribution.
Linux, Windows, Intel macOS, prerelease channels, and alternate update servers are unsupported and do not contact the update feed.
The fixed source is `https://github.com/zaherg/mcp-gateway/releases/latest/download`; updater-capable releases must publish `macos-arm64-MCPGateway.dmg`, `stable-macos-arm64-update.json`, and `stable-macos-arm64-MCPGateway.app.tar.zst` with matching versions.

Automatic checks and downloads are enabled by default.
MCP Gateway checks after startup has settled, then daily while it runs; the **Settings → Updates** switch disables new automatic checks and download admissions.
The preference is stored separately in owner-only `updates.json` in the application data directory, not in `mcp.json` or `mcp.jsonc`.
Invalid or unsafe preference files disable background work and remain visible for repair.
A failure before publication preserves the previous setting; after publication, the app reads back the saved value and warns that durability is uncertain.
If that value cannot be verified, background updates are disabled.
A missing file means enabled.

Use **Settings → Updates**, the macOS application menu **Check for Updates…**, or the tray menu for a manual check.
Manual checking never installs an update.
A discovered higher stable version can be downloaded without stopping the gateway or discarding a draft.
Preparation and restart checks reject candidates whose plist or bundled Mach-O requirements exceed this Mac's macOS version.
The launcher, Bun runtime and pinned update helpers must be regular files with executable access; a valid signature alone is insufficient.
Missing required native inspection tools or invalid metadata also refuse the update; retained manual-recovery verification remains available.
Automatic updates off requires an explicit **Download Update** action after a manual check.
The download and preparation status is shown in Settings; a background discovery also appears as a nonmodal notice when the window is open.
Preparation currently uses full archives: the application removes cached TARs and prepared records before a new attempt, even though the pinned SDK supports deltas.
Electrobun `2.0.6` archive recipes, streamed preparation, and v2 manifests are not implemented by the pinned `2.0.5` runtime.

**Restart to Update** requires confirmation, interrupts active MCP connections, and stops the gateway before handoff.
If the configuration has unsaved changes, the confirmation explicitly discards the draft; it is never silently saved.
Cleanup and handoff failures keep configuration editing locked.
Retry Update is available only when the installer is confirmed unarmed and the verified preparation remains usable.
If preparation cannot be restored or installation commitment is uncertain, Retry Update is unavailable; normal Quit and retained recovery remain available.
A downloaded update is not confirmed installed until the restarted app completes initialization and reconciles the expected version and transaction.
A verified owner-only copy of the previous application is retained for manual recovery; it is not an automatic downgrade and does not promise rollback after an arbitrary crash in the new version.

Installations of `0.3.0` and older have no updater code or update feed metadata.
Install the first updater-capable release manually once, then future stable releases can use the in-app flow.
Development and isolated builds have no update network activity or actionable update controls.

## Security

- Use a trusted LAN: HTTP does not encrypt tokens, tool arguments, or note contents.
- Connections require a bearer token and must come from the selected private subnet or loopback.
- Configure upstream credentials separately; client authorization is not forwarded.
- Protect the Mac and configuration files: configured commands can execute programs.
- Copied client configuration contains the token; Logs can contain credentials and note data.

Keep the Mac awake and connected; DHCP can change its address.

### Request limits

The gateway allows 32 concurrent HTTP requests, with 4 slots reserved for validated controls and an ordinary-request peak of 28.
Within the 240-admission-per-minute limit, at most 224 admissions are ordinary requests, leaving 16 for controls.
Reserved capacity accepts cancellation of outstanding calls, DELETE for an existing stateful session, and replies to outstanding server-originated requests.
New calls and batches containing new work cannot use it.

Incomplete POST bodies count toward the HTTP limit while being classified.
Bodies are limited to 4 MiB and requests to 30 seconds; backend resources and outstanding client calls each have a separate limit of 16.
An authenticated client occupying the reserved slots can still delay control traffic.
Protocol cancellation does not guarantee that arbitrary upstream work physically stops.

Each backend stdout line and each HTTP JSON or error body is limited to 4 MiB.
SSE events share a 4 MiB byte limit across data, metadata, and comment fields, excluding CR/LF framing.
The limits apply as chunks arrive; oversized output fails the affected backend operation instead of being truncated.
A long-lived SSE session can carry multiple bounded events whose combined size exceeds 4 MiB.

## Configuration

Use one `mcp.json` or `mcp.jsonc` in `~/Library/Application Support/MCP Gateway/` on macOS.
Linux uses `$XDG_CONFIG_HOME/MCP Gateway/`, or `~/.config/MCP Gateway/` when XDG_CONFIG_HOME is unset; a supplied XDG_CONFIG_HOME must be absolute.
An absolute `MCP_GATEWAY_DATA_DIR` overrides either location.

- `.json` requires strict JSON; `.jsonc` accepts comments and trailing commas.
- Both files present is an error; when neither exists, the app creates `mcp.json`.
- Quit before renaming the file, then reopen the app.
- UI edits preserve retained comments and unchanged saves preserve bytes; files are owner-only, symlinks are refused, and invalid external edits stop the gateway.

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

## Build from source

Install Bun 1.4.4 and Node, then install dependencies:

```sh
bun install --ignore-scripts --cache-dir .cache/bun
```

Use `MCP_GATEWAY_BUILD_ROOT` to select a project-relative build folder and `MCP_GATEWAY_ARTIFACTS_DIR` to select the distribution/artifact folder.
`dist/` holds generated UI, `build/` holds app bundles by default, and `artifacts/` holds distributions and verification files by default.
Use distinct project-local values for a candidate release so retained published artifacts are not overwritten.

### macOS builds

Requires an arm64 Mac and Apple's Command Line Tools; SDK preparation and UI compilation are automatic.

```sh
bun run build  # Development package
bun run dev    # Build and launch
```

<details>
<summary>Release signing and notarization</summary>

`bun run release` signs and notarizes the app.
It requires a Developer ID Application identity in Keychain and `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_PASSWORD`.
Export them or use a local `.env` based on `.env.example`; exported values take precedence.
Never commit credentials.

</details>

### Release assets and verification

Every updater-capable stable release must publish these exact matching assets:

- `macos-arm64-MCPGateway.dmg`
- `stable-macos-arm64-update.json`
- `stable-macos-arm64-MCPGateway.app.tar.zst`

The manifest, package version, wrapper `CFBundleVersion`, and extracted payload `version.json` must agree, and the payload must retain the fixed stable feed URL.
`scripts/verify-release.ts` also checks the wrapper and payload signatures, notarization tickets, Gatekeeper acceptance, archive digest, a complete no-follow inventory equality between the DMG-contained wrapper and the verified wrapper (including executable and signature files), and checked detachment of its owned mount.
It also scans for configured signing-account/password bytes.
The credential-scan record states whether secret values were supplied; an empty secret set is not a successful secret scan.
Cancellation waits for attach settlement and cleanup, including a mount created after the signal.
If attach settlement or detachment cannot be confirmed, verification fails and retains the mount directory for inspection.

Build, stage, and verify assets in distinct project-local directories so published files are not overwritten:

```sh
MCP_GATEWAY_BUILD_ROOT=.cache/release-0.3.1/build \
MCP_GATEWAY_ARTIFACTS_DIR=.cache/release-0.3.1/assets \
bun run release

MCP_GATEWAY_ARTIFACTS_DIR=.cache/release-0.3.1/assets \
MCP_GATEWAY_VERIFICATION_OUTPUT=.cache/release-0.3.1/release-verification.json \
bun scripts/verify-release.ts .cache/release-0.3.1/build/stable-macos-arm64/MCP\ Gateway.app
```

The verifier refuses mismatched versions, manifest hashes, archive names, fixed feed metadata, or unsafe/missing assets.
Publish the complete asset set together; drafts and prereleases must not become stable update candidates.
Do not replace assets under an already published version.
The published `0.3.0` DMG and payload remain retained; automatic downgrade is not supported.

### Linux source builds (experimental, native)

Build natively on Linux x64 or arm64, with GTK3, WebKitGTK 4.1, Ayatana AppIndicator, librsvg, and an X11/XWayland desktop.

```sh
bun run build         # Development bundle, not an installer
bun run build:linux   # Experimental unsigned stable packaging
```

The development launcher is `build/dev-linux-x64/MCPGateway-dev/bin/launcher` (substitute arm64 when applicable).
No Apple credentials or macOS login library are used on Linux.

### Windows packaging only

`bun run build:windows` selects experimental unsigned stable packaging on Windows x64 or arm64.
See [platform prerequisites](https://docs.electrobun.dev/electrobun/guides/cross-platform-development/) for native libraries and WebView2 requirements.

### Tests

```sh
bun run prepare:sdk
bun run typecheck && bun run lint
bun run test:e2e && bun run test:components && bun run test:unit
```

Browser tests require Google Chrome and use synthetic servers, not real Bear notes.
See [test details](tests/README.md) for test layers, native smoke, CI, and verification limits.
