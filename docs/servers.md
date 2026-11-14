# Servers

## Local commands and HTTP servers

A server is either a local executable that speaks MCP over stdio, or an existing MCP endpoint reached over Streamable HTTP.
Both kinds produce one endpoint per server, such as `/mcp/bear`.

The server dialog asks for:

- **Server name**: "Used in /mcp/server-name. Letters, numbers, hyphens and underscores."
- **Transport**: **Local command (stdio)** or **Streamable HTTP**.
- **Command** for stdio: "Executable path only. Arguments are passed separately, never through a shell."
- **Arguments (JSON array)**, **Environment (JSON object)** and **Working directory** ("Optional absolute path.") for stdio.
- **Upstream URL** ("HTTP(S), without embedded credentials or fragments.") and **Headers (JSON object)** ("String values only. Prefer environment references such as ${API_TOKEN}.") for HTTP.
- **Authentication**: **Use global key** or **Use this server's key**.
- **Allow session-based clients (MCP 2025-11-25 and earlier)** and **Disabled (do not mount this endpoint)**.

**Cancel** closes the dialog without changing the draft.
**Apply to draft** keeps the edit in the draft; **Save changes** in the draft bar applies it.

## Commands that work in Terminal but not in the app

The app reads `${NAME}` from its own environment, not from your shell startup files.
A Mac app opened from Finder or at login receives launchd's environment, which does not include the `PATH` additions or exported variables from your shell.
A bare command name such as `npx`, or a program installed by Homebrew, is then not found, and the start fails with `ENOENT`.
A script started by its full path can still fail when the program it runs, such as `node` for `npx`, is not on that `PATH`.

Two fixes work together:

1. Put an absolute path in **Command**. Run `which <command>` in Terminal and use the path it prints.
2. If the command starts another program, extend `PATH` in **Environment (JSON object)**, for example `"PATH": "/opt/homebrew/bin:${PATH}"`. Adjust the folder to the one `which` printed.

This describes standard macOS behavior for apps opened from Finder or at login; if your setup differs, check **Logs** for the exact error.

## Keys for each server

**Use global key** makes the server accept the global `gateway.token`.
**Use this server's key** accepts only the key you enter in **Server key**; the global key then gets `401` on that endpoint.
Choose **Generate secure key** to create one.

Separate keys let you revoke one client or device without touching the rest.
Changing a server key refuses the old key at once and closes that endpoint's open requests and sessions, while other endpoints keep running.
[The configuration file](configuration.md#the-configuration-file) covers the reference syntax.

## Session-based clients

Some clients still speak MCP `2025-11-25` and earlier.
**Allow session-based clients (MCP 2025-11-25 and earlier)** makes an endpoint accept that protocol as well.
Leave it off when every client supports `2026-07-28`.

Each session runs its own backend process or upstream session, and sessions are limited.
[Protocol compatibility](clients.md#protocol-compatibility) lists the limits and the error codes.

## Managing servers

Each card shows the server status: **Mounted**, **Error**, **Disabled** or **Stopped**.
**Mounted** means the endpoint is served, not that the backend handshake succeeded.
**Error** means the gateway could not mount the server; the card shows the error message, and **Logs** has the backend's output.
**Start** and **Stop** save the server's enabled state; the gateway starts separately.
Use the restart button to restart one server.
The delete button asks "Delete server?" and then removes the server from the draft; its endpoint stops when you save.
**Copy endpoint** copies only the URL.
**Copy client configuration** copies the JSON block with the endpoint and key.

Both copy buttons are disabled while you have unsaved changes, and they work while the gateway is stopped.
**Copy client configuration** refuses while the configuration has an error.
**Start**, **Stop** and restart are disabled while you have unsaved changes or a configuration error.
Restart also needs the gateway running and the server enabled.

## The Bear preset

The Bear preset allows every Bear tool, including tools that change notes.
**Fill Bear preset** in the server dialog fills the name `bear`, the command `/Applications/Bear.app/Contents/MacOS/bearcli` and the arguments `["mcp-server"]`.
**Use macOS Bear preset**, shown when no servers are configured, opens the server dialog with the same values filled in.

## Secrets in headers and environment

`${NAME}` references work in `gateway.host`, `gateway.token`, a server `token`, `url`, `headers` values, `command`, `args`, `cwd` and `env` values.
A missing variable fails validation with "A referenced environment variable is not defined."
See [Environment variables](configuration.md#environment-variables) for where the app reads them.
