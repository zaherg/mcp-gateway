# Servers

## Local commands and HTTP servers

A server is either a local executable that speaks MCP over stdio, or an existing MCP endpoint reached over Streamable HTTP.
Both kinds produce one endpoint per server, such as `/mcp/bear`.
When the gateway stops a local command, for example on **Stop gateway**, a restart or quit, it sends `SIGTERM` to the command's process group once, then `SIGKILL` if the group is still running 5 seconds later.
The same applies to programs the command started that keep running after the command exits.

The server dialog asks for:

- **Server name**: "Used in /mcp/server-name. Letters, numbers, hyphens and underscores."
- **Transport**: **Local command (stdio)** or **Streamable HTTP**.
- **Command** for stdio: "Executable path only. Arguments are passed separately, never through a shell."
- **Arguments (JSON array)**, **Environment (JSON object)** and **Working directory** ("Optional absolute path.") for stdio.
- **Upstream URL** ("HTTP(S), without embedded credentials or fragments.") and **Headers (JSON object)** ("String values only. Prefer environment references such as ${API_TOKEN}.") for HTTP.
- **Authentication**: **Use global key** or **Use this server's key**.
- **Allow session-based clients (MCP 2025-11-25 and earlier)** and **Disabled (do not mount this endpoint)**.

The dialog uses structured row editors instead of raw JSON text boxes:

- **Arguments (JSON array)** lists one row per argument; choose **Add Argument** (or press `Return` in an argument input) to add a row and `-` to remove one.
- **Environment (JSON object)** and **Headers (JSON object)** use key-value tables with **Add Row** and `-`.
  Keys that look like secrets (such as `Authorization`, `X-API-Key`, or names ending in `token`, `secret`, `password` or `key`) are masked automatically unless the value contains an environment reference `${NAME}`, which shows a lock icon; other rows can be masked or revealed with the eye button.

The dialog validates the server name and key-value rows live (flagging duplicate names, invalid names, empty keys, duplicate keys and reserved prototype keys).
When an environment table overrides sensitive execution variables (`PATH`, `HOME`, `PYTHONSTARTUP`, `PYTHONPATH`, `NODE_EXTRA_CA_CERTS`, `GIT_SSH_COMMAND`, `BASH_ENV`, `ZDOTDIR`), a warning banner lists them.

**Cancel** closes the dialog without saving.
Submitting (**Apply to draft**) saves the configuration immediately and closes the dialog.

## Commands that work in Terminal but not in the app

The app reads `${NAME}` from its own environment, not from your shell startup files.
A Mac app opened from Finder or at login receives launchd's environment, which does not include the `PATH` additions or exported variables from your shell.
In addition, local stdio commands inherit only a minimal safe subset of parent environment variables (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR`, `TERM`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `__CF_USER_TEXT_ENCODING`, plus `LC_*` and `XDG_*`), overlaid with the server's configured `env`.
Dangerous loader and runtime variables (`NODE_OPTIONS`, `BUN_OPTIONS`, `DYLD_*`, `LD_*`) are rejected by validation and stripped from the child environment.

A bare command name such as `npx`, or a program installed by Homebrew, is then not found, and the server fails to start with `ENOENT`.
A script started by its full path can still fail when the program it runs, such as `node` for `npx`, is not on that `PATH`.

Two fixes work together:

1. Put an absolute path in **Command**.
   Run `which <command>` in Terminal and use the path it prints.
2. If the command starts another program, add a `PATH` row in **Environment (JSON object)** with a value such as `/opt/homebrew/bin:${PATH}`.
   Adjust the folder to the one `which` printed.

This describes standard macOS behavior for apps opened from Finder or at login; if your setup differs, check **Logs** for the exact error.

## Importing servers from Claude Desktop or Cursor

From **Settings → Advanced** (**Import Servers from Claude Desktop / Cursor**) or **Authoritative configuration** (**Import from Claude / Cursor**), the app can import server definitions from `~/Library/Application Support/Claude/claude_desktop_config.json` and `~/.cursor/mcp.json`.

The importer ignores symlinks and oversized files, skips servers whose names are already configured or invalid, rejects blocked environment keys, disallowed upstream URLs, self-gateway URLs and forbidden headers, and respects the 64-server limit.
Imported servers are saved immediately, and the UI reports how many new servers were added.
Import is disabled while **Authoritative configuration** has unsaved edits.

## Keys for each server

**Use global key** makes the server accept the global `gateway.token`.
**Use this server's key** accepts only the key you enter in **Server key**; the global key then gets `401` on that endpoint.
Choose **Generate secure key** to create one.

Separate keys let you revoke one client or device without touching the rest.
Changing a server key refuses the old key at once and closes that endpoint's open requests and sessions, while other endpoints keep running.
[The configuration file](configuration.md#the-configuration-file) covers the reference syntax.

A server's own key can be moved to the macOS Keychain; see [Keys in Keychain](configuration.md#keys-in-keychain).
The dialog then shows **Stored in Keychain** instead of the key.
**Generate secure key** replaces a stored key with a new key in the file, and **Use global key** removes the server's own key when you submit the dialog.

## Session-based clients

Some clients still speak MCP `2025-11-25` and earlier.
**Allow session-based clients (MCP 2025-11-25 and earlier)** makes an endpoint accept that protocol as well.
Leave it off when every client supports `2026-07-28`.

Each session runs its own backend process or upstream session, and sessions are limited.
[Protocol compatibility](clients.md#protocol-compatibility) lists the limits and the error codes.

## Managing servers

**Overview** lists configured servers in a compact table.
Each row shows a status light (hover it to read **Mounted**, **Error**, **Disabled** or **Stopped**), the server name, a **STDIO** or **HTTP** badge, the `/mcp/<name>` path and target command or URL.

**Mounted** means the endpoint is served, not that the backend handshake succeeded.
**Test connection** checks the handshake: it sends the request a client would send to the server's endpoint, with the endpoint's key, and shows the result below the row.
The test needs no unsaved raw edits, a running gateway and a started server.
With **Allow session-based clients** on, it tests the session-based protocol that most desktop clients use.
It starts the command, or contacts the HTTP upstream, but calls no tool and changes no setting.
One test runs at a time, and it stops after 30 seconds.
When the button is unavailable, the detail line under the row says why.
The result stays on the row until the configuration changes, the gateway stops or the server restarts.
A passing test does not show that other devices can reach the gateway; see [Remote access](remote-access.md).

**Error** means the gateway could not mount the server; the detail line shows the error message, and **Logs** has the redacted backend output.
The enable/disable switch saves the server's enabled state immediately; the gateway starts separately.
You can also toggle individual servers from the menu-bar icon menu.
Use the restart button to restart one server.
The delete button asks **Delete server?** in a native macOS dialog and saves the removal immediately, stopping the endpoint right away.
The copy icon next to `/mcp/<name>` copies only the endpoint URL; **Copy client configuration** copies the JSON block with the endpoint and key and briefly displays **Copied**.

Both copy buttons are disabled while **Authoritative configuration** has unsaved edits, and they work while the gateway is stopped.
**Copy client configuration** refuses while the configuration has an error.
The enable/disable switch, restart button and **Test connection** are disabled while **Authoritative configuration** has unsaved edits or there is a configuration error.
Restart also needs the gateway running and the server enabled.

## The Bear preset

The Bear preset allows every Bear tool, including tools that change notes.
**Fill Bear preset** in the server dialog fills the name `bear`, the command `/Applications/Bear.app/Contents/MacOS/bearcli` and the argument `mcp-server`.
**Use macOS Bear preset**, shown when no servers are configured, opens the server dialog with the same values filled in.

## Secrets in headers and environment

`${NAME}` references work in `gateway.host`, `gateway.token`, a server `token`, `url`, `headers` values, `command`, `args`, `cwd` and `env` values.
Only the gateway keys can move to the macOS Keychain; `headers` and `env` values always stay in the configuration file.
A missing variable fails validation with "A referenced environment variable is not defined."
See [Environment variables](configuration.md#environment-variables) for where the app reads them.
