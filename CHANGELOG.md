# Changelog

All notable changes to MCP Gateway are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow the `version` in `package.json`.
Release dates are the dates each section was stamped for release.

## [Unreleased]

Changes after `1.0.0`.

## [1.0.0] - 2026-11-28

### Added

- Test a server's connection from its card
- Keep the Mac awake while the gateway runs
- Move gateway keys to the macOS Keychain
- Rename Keychain services and the signed development app
- Store the initial gateway key in Keychain on fresh signed installs
- Polish UI/UX, add manual appearance setting, and remove server restart

### Changed

- Update libraries
- Update changelog
- Add the pause note
- Update libraries
- Update libraries
- Complete audit remediation plans 047-053 (security, direct SDK transports, native macOS UX)
- Remove inferrable TypeScript type annotations
- PR-1 pin Effect UI snapshot deps and verify build gate
- PR-2 build pure log buffer, Effect UI LogsView, and Story/Scene/Play tests
- PR-3 mount Effect UI LogsView inside React Logs adapter
- PR-4 wire dev-only Effect UI DevTools and write SPIKE-REPORT.md
- Record live macOS Electrobun verification in SPIKE-REPORT.md
- Migrate Settings view to Effect UI and @effect/ui-kit Switch
- Record live Settings and Logs inspection findings
- Migrate Overview view to Effect UI and @effect/ui-kit Switch
- Record live Overview CRUD and 3-tab handoff inspection
- Remove React and migrate full renderer to Effect UI

### Fixed

- Name the Dev app in its labels and clarify first-run Keychain failures
- Apply review fixes for discovery, shutdown, Stop and validation
- Refuse queued controller work at dequeue after Stop
- Clean up helpers left by a backend that exits by itself
- Keep one server's stuck cleanup from blocking other changes
- Report a written configuration as saved when applying it fails
- Keep an enabled server's pending cleanup off unrelated saves
- Redact bearer token fields with Schema.Redacted
- Defer window reveal until snapshot ready and match native background
- Remediate Effect UI migration audit findings
- Use native window drag, block prod context menu, and refine logs toolbar
- Resolve nested app bundle inside Electrobun staging dir

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

[Unreleased]: https://github.com/zaherg/mcp-gateway/compare/1.0.0...HEAD
[1.0.0]: https://github.com/zaherg/mcp-gateway/compare/0.9.0...1.0.0
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
