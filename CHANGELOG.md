# Changelog

All notable changes to MCP Gateway are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow the `version` in `package.json`.
Release dates are the dates each section was stamped for release.

## [Unreleased]

### Added

- Save structured edits in **Settings**, **Overview** and the server dialog immediately, keeping draft mode for **Authoritative configuration**
- Replace the raw JSON editors in the server dialog with structured **Arguments**, **Environment** and **Headers** row editors, including automatic secret masking and warnings for sensitive environment variable overrides
- Import existing server definitions from Claude Desktop (`claude_desktop_config.json`) and Cursor (`~/.cursor/mcp.json`) from **Settings → Advanced** or **Authoritative configuration**
- Add **Open in External Editor** to **Settings → Advanced** and **Authoritative configuration**
- Add a collapsible schema reference popover (`?`), 2-space Tab indentation and clickable **Line N** links on validation errors in **Authoritative configuration**
- Redesign **Logs** with a single-row toolbar, **Follow Tail**, `Cmd+F` search focus, single-line tabular rows, per-row copy buttons and a collapsible info popover
- Add **View** (`Cmd+1`–`Cmd+4`, `Cmd+R`), **Server** (`Cmd+N`), **Window** (`Cmd+M`, `Cmd+W`), **About** and **Hide** items to the application menu
- Add **Copy Gateway Endpoint URL**, per-server quick-toggle items and direct **Restart to Update** to the menu-bar icon menu
- Show determinate download progress and a single **Install and Relaunch** button in **Updates**, auto-check when opening **Updates** while idle, and allow clicking **Update ready** in the sidebar to restart directly
- Post native macOS notifications for background startup errors, ready updates and failed menu-bar actions when the window is closed
- Add an automated unit, integration and full-stack end-to-end test suite (`bun run test`)

### Changed

- Replace `supergateway`, `express` and `cors` with an in-repo MCP `2026-07-28` adapter and direct `@modelcontextprotocol/sdk` Streamable HTTP transports, bundling all runtime dependencies into the app
- Switch **Overview** from a card grid to a compact server table with a gateway status pill, enable/disable switches and inline copy feedback
- Reorganize **Settings** into **General**, **Network**, **Security** and **Advanced** groups, moving the **Language** picker and **Retry login registration** into **General**
- Replace the top-of-window banner stack, header **Quit** button, page footer and in-app confirmation dialogs with a compact configuration blocker bar, per-view alerts and native macOS confirmation dialogs
- Replace periodic status polling with native push updates and persist window size and position natively through AppKit instead of `window.json`
- Access the macOS Keychain directly through `Security.framework` FFI (with `kSecAttrAccessibleWhenUnlocked`), falling back to `Bun.secrets` only when the native library is absent
- Coordinate configuration writes with advisory `flock` locking on `mcp.json.lock` so stale locks clear automatically when a writer exits
- Keep the window hidden on background launches even when release notes are pending, posting a notification on startup errors instead
- Enable delta update patch generation in release builds and update libraries

### Security

- Redact tokens, authorization and API key headers, JSON secret fields, query secrets and configured server secrets in **Logs** and sanitized error messages, and suppress raw stdio `stderr` output by default
- Restrict local stdio servers to a minimal safe allowlist of parent environment variables and reject dangerous loader and runtime environment keys (`NODE_OPTIONS`, `BUN_OPTIONS`, `DYLD_*`, `LD_*`)
- Block link-local and cloud metadata upstream addresses (`169.254.0.0/16`, `0.0.0.0/8`, `fe80::/10`, `::` and IPv4-mapped IPv6 forms) and refuse HTTP redirects on all HTTP upstreams
- Reject HTTP `Upgrade` / WebSocket requests (`403` on invalid `Host` or `Origin`, `405` otherwise), strip `Access-Control-Allow-Origin` headers and enforce a 30-second request body read timeout
- Verify downloaded update manifests when present and check the staged app bundle's code signature and `TeamIdentifier` against the installed app before restarting to update
- Harden `seen-version.json` and `key-reminder.json` with atomic owner-only file I/O, scrub Electrobun window secret globals after renderer RPC initialization and default `Bun.serve` to loopback binding
- Refuse `SIGN_VERIFY_SKIP` during release verification and require all production signature, notarization and Gatekeeper checks to pass

### Fixed

- Preserve concurrent edits in **Authoritative configuration** when a save finishes

## [0.9.0] - 2026-11-25

### Added

- Test a server's connection from its card
- Add **Keep the Mac awake while the gateway runs** to Settings
- Move existing keys into the macOS Keychain with **Move keys to Keychain** in Settings, without changing the keys that clients use
- Store the global bearer token in the macOS Keychain on a fresh install

### Changed

- Update libraries
- Earlier releases reject a configuration that contains `tokenRef` or `keepAwake`

### Fixed

- Retry an HTTP server's protocol check after an interrupted reply, instead of refusing its clients with HTTP 400 for a minute
- Free a call slot after a failed request, so failures can no longer use up all 16 slots and leave every call refused with HTTP 429
- Send a stopping server one `SIGTERM` and wait 5 seconds before `SIGKILL`, so wrappers such as `docker run -i` can shut down cleanly
- Stop the helper processes that a server leaves when it exits by itself, so **Stop gateway** and quitting the app no longer fail
- Keep one server that does not stop from delaying or failing changes to other servers, and from stopping the gateway
- Keep the gateway stopped after **Stop gateway**, even if its network interface goes away and comes back during the stop
- Report a written configuration as saved even when the gateway cannot apply it, for example because the port is in use
- Refuse an **Allowed client ranges** value that contains only commas, instead of removing the restriction without notice
- Check server names in the server dialog, so an invalid name no longer removes a server from the draft
- Remove the whole line when a form edit deletes a value from the configuration file, instead of leaving it blank
- Show configuration editor errors in a red that meets WCAG AA contrast
- Keep **Logs** updating after a failed read, without reopening the tab

## [0.8.3] - 2026-11-16

### Added

- Add Show in Finder for the configuration file
- Use the JSON editor for server dialog fields
- Move interface text into a translatable catalog
- Move language picker to the sidebar and drop the pseudo-locale
- Add French, German and Turkish translations

## [0.8.2] - 2026-11-14

### Added

- Show release notes once after an update
- Add a full-width draggable title bar with a bottom border
- Add Help menu and sidebar documentation link
- Open the window when release notes are pending after an update

### Changed

- Update libraries
- Dispatch only to endpoints built from the current configuration
- Keep redirect protection until mount cleanup settles
- Keep legacy cancelled calls charged until they end
- Publish the test feed from a private artifact copy
- Update format
- Allow Tailscale and WireGuard listeners with explicit client ranges
- Redesign the window around the listener address and a status LED
- Move the gateway start/stop button into the page heading
- Keep the authoritative configuration editor in Settings only
- Update changelog
- Move update controls from Settings to the sidebar

### Fixed

- Point configuration banners to the editor in Settings
- Remove gateway start and stop success notices

## [0.8.0] - 2026-11-14

### Added

- Show release notes once after an update
- Add a full-width draggable title bar with a bottom border
- Add Help menu and sidebar documentation link
- Open the window when release notes are pending after an update

### Changed

- Update libraries
- Dispatch only to endpoints built from the current configuration
- Keep redirect protection until mount cleanup settles
- Keep legacy cancelled calls charged until they end
- Publish the test feed from a private artifact copy
- Update format
- Allow Tailscale and WireGuard listeners with explicit client ranges
- Redesign the window around the listener address and a status LED
- Move the gateway start/stop button into the page heading
- Keep the authoritative configuration editor in Settings only
- Version bump

### Fixed

- Point configuration banners to the editor in Settings
- Remove gateway start and stop success notices

## [0.7.0] - 2026-11-11

### Added

- The raw configuration editor is now a CodeMirror 6 editor for JSON and JSONC, with highlighting, line numbers, bracket matching, indentation and undo.
- **Format** tidies the draft.
- The editor checks the draft as you type and shows the first problem with its line and column.
- **Reset** returns to the saved file after a confirmation.
- **Save** is disabled while the draft has a problem.
  Saving still validates the file again.

### Changed

- The content security policy allows inline style elements, which the editor needs.
  Scripts, style attributes and network access are unchanged.
- Discarding a draft asks for confirmation in a native macOS dialog.
- Removed dead updater options and unused injection points in the main process and the build scripts.

## [0.6.1] - 2026-11-10

### Added

- GitHub and X links below the sidebar notice, opened in the default browser.

### Changed

- Text buttons no longer show decorative icons.

## [0.6.0] - 2026-11-10

### Added

- An optional `token` on each server.
  A server with its own key accepts only that key, and the global key does not open it.
  Servers without one keep using `gateway.token`.
- A server key field in the server dialog.

### Changed

- Changing a server key refuses the old key at once and closes that endpoint's open requests and sessions, while other endpoints keep running.
- Earlier releases reject a configuration that contains a server `token`.

## [0.5.2] - 2026-11-10

### Changed

- Internal cleanup only: simpler code in several modules, parameter object types and updated libraries.

## [0.5.1] - 2026-11-09

### Fixed

- The minimum window size is applied correctly.

## [0.5.0] - 2026-11-09

### Added

- A macOS look and feel, with a hidden-inset title bar, a sidebar and a single scroller per tab.
- A resizable window that remembers its size between launches.
- A green dot on the menu-bar icon while the gateway runs.
- Hot reload for `bun run dev`.

## [0.4.0] - 2026-11-08

### Added

- **Allow session-based clients** per server, also set as `"legacyProtocol": true` in `mcp.json`.
  That endpoint then also accepts session-based MCP (`2025-11-25` and earlier), including the official `StreamableHTTPClientTransport`.
  At most 8 sessions can be open, each takes one of the 16 shared backend slots, and a session ends after 60 seconds without an open request or event stream.

### Changed

- Replaced the Effect library with zod and plain code.
- Fixed audit findings in configuration handling, protocol handling, logging and the updater.
- Earlier releases reject a configuration that contains `legacyProtocol`.

### Fixed

- Recovery after the selected network interface goes away and returns.
- Reporting of backend failures.

## [0.3.2] - 2026-11-08

The first release that can update itself.
Version `0.3.1` has no tag, and its packaged update acceptance run did not pass.

### Added

- Automatic updates with the built-in Electrobun updater, from a fixed feed on GitHub Releases.
  Settings has an **Updates** section with a switch for automatic checks, a manual check and **Restart to Update**.
  Only signed stable builds can update.
- Private update-test builds and a feed publisher for rehearsing updates before a release.

### Changed

- Linux and Windows are no longer supported; the app targets macOS on Apple silicon only.
- The configuration folder is always the macOS Application Support folder.
- Session-based MCP clients are refused in this release, because the stateful session path was removed; `0.4.0` brings them back as an opt-in per server.
- Updater, build and UI code was reorganized, and the user interface was split into smaller components.

### Fixed

- The configuration could stay locked after an update preflight was rejected.
- The login item lifetime, backend ownership and updater lifecycle.
- Upstream responses are decoded as strict UTF-8, and backend output is bounded.
- Update preferences are stored and read safely.

## [0.3.0] - 2026-11-02

The first release.

### Added

- A menu-bar app that shares local stdio MCP servers and remote Streamable HTTP MCP servers on a trusted LAN, with one endpoint per server.
- A bearer token, a selected private IPv4 address, subnet checks, and `Host` and `Origin` checks.
- Limits on concurrent requests, request rate, message sizes and request time.
- Configuration in `mcp.json` or `mcp.jsonc`, with `${NAME}` environment references.
- In-memory logs, launch at login, and an optional gateway start when the app opens.
- Experimental Linux and Windows packaging.

[Unreleased]: https://github.com/zaherg/mcp-gateway/compare/0.9.0...HEAD
[0.9.0]: https://github.com/zaherg/mcp-gateway/compare/0.8.3...0.9.0
[0.8.3]: https://github.com/zaherg/mcp-gateway/compare/0.8.2...0.8.3
[0.8.2]: https://github.com/zaherg/mcp-gateway/compare/0.8.0...0.8.2
[0.8.0]: https://github.com/zaherg/mcp-gateway/compare/0.7.0...0.8.0
[0.7.0]: https://github.com/zaherg/mcp-gateway/compare/0.6.1...0.7.0
[0.6.1]: https://github.com/zaherg/mcp-gateway/compare/0.6.0...0.6.1
[0.6.0]: https://github.com/zaherg/mcp-gateway/compare/0.5.2...0.6.0
[0.5.2]: https://github.com/zaherg/mcp-gateway/compare/0.5.1...0.5.2
[0.5.1]: https://github.com/zaherg/mcp-gateway/compare/0.5.0...0.5.1
[0.5.0]: https://github.com/zaherg/mcp-gateway/compare/0.4.0...0.5.0
[0.4.0]: https://github.com/zaherg/mcp-gateway/compare/0.3.2...0.4.0
[0.3.2]: https://github.com/zaherg/mcp-gateway/compare/v0.3.0...0.3.2
[0.3.0]: https://github.com/zaherg/mcp-gateway/releases/tag/v0.3.0
