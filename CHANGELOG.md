# Changelog

All notable changes to MCP Gateway are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow the `version` in `package.json`.
Release dates are the dates each section was stamped for release.

## [Unreleased]

Changes after `0.8.0`.

## [0.8.0] - 2026-11-14

### Added

- Show release notes once after an update
- Add a full-width draggable title bar with a bottom border
- Add Help menu and sidebar documentation link

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

[Unreleased]: https://github.com/zaherg/mcp-gateway/compare/0.8.0...HEAD
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
