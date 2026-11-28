# Troubleshooting

## When the client cannot connect at all

Check these first:

- The gateway is running.
  **Overview** shows **Gateway running** next to **Servers**, and the menu-bar icon shows a green dot.
- The Mac is awake.
  Sleep takes the endpoints offline.
- The endpoint uses the address currently saved in **Settings → Network**, not an older DHCP address.
- The port in the client matches the port in **Settings → Network**.

## Status codes

The client reports the status code.
MCP Gateway does not log refused requests, so read the code in the client's own logs.

| Status | Cause |
| --- | --- |
| `401` | Missing or wrong `Authorization: Bearer` key for that endpoint. A server with its own key rejects the global key. |
| `503` | The gateway is closing, or the configured address is no longer on this Mac. |
| `403` | The client is outside the allowed clients (the interface subnet, or **Allowed client ranges**); the `Host` header is not exactly `<address>:<port>`, which rejects host names such as MagicDNS names; the `Origin` header does not match; or an HTTP `Upgrade` request had an invalid `Host` or `Origin`. |
| `404` | No such server, the server is disabled, or it is not mounted, for example a server in **Error**. |
| `405` | A method the endpoint does not accept, such as `GET` or `DELETE` without **Allow session-based clients**, or an HTTP `Upgrade` / WebSocket request. |
| `406` | Missing `Accept` header containing both `application/json` and `text/event-stream` on a stateless (`2026-07-28`) request. |
| `400` | Protocol mismatch: an older protocol version or the `initialize` handshake on a stateless endpoint, mismatched `_meta` or `mcp-*` headers, an expired continuation handle, a body on a non-`POST` request, or a request body read that exceeded 30 seconds. |
| `413` | Request body over 4 MiB. |
| `415` | Compressed request body, or a `Content-Type` other than `application/json` on a stateless (`2026-07-28`) request. |
| `429` | More than 32 requests at once, more than 240 per minute, or a session limit. |
| `504` | No reply within 30 seconds. |
| `502` | The backend failed. The details are in **Logs**. |

`400`, `405` and `406` usually mean the client speaks an older protocol.
Turn on **Allow session-based clients** for that server and try again; see [Protocol compatibility](clients.md#protocol-compatibility).

## The server shows an error

A red status light (hover it to read **Error**) means the gateway could not mount the server.
The detail line below the row shows the error message; open **Logs** and read the last entries for that server.

If the message says that backend cleanup did not complete, a process from that server's previous run is still running.
Other servers keep working and accept configuration changes, but **Stop gateway** and quit fail until that process exits.
Quit the process, for example in Activity Monitor, then toggle that server off and back on.
Cleanup completion alone does not remount the server; a later configuration change may also recover it.

**Mounted** with failing tools also points at the backend; check **Logs** for its output.

## A command is not found

A command that works in Terminal can fail in the app with `ENOENT`.
An app opened from Finder or at login does not get the `PATH` from your shell, and local commands inherit only a minimal allowlist of parent environment variables.
Use an absolute path in **Command**, and add a `PATH` row in **Environment (JSON object)** when the command starts another program.
See [Commands that work in Terminal but not in the app](servers.md#commands-that-work-in-terminal-but-not-in-the-app).

## A server test fails

**Test connection** on a server row names what to check:

- "The gateway could not find the program in Command."
  The app cannot find the executable, usually because **Command** holds a bare name such as `php`.
  Run `command -v php` in Terminal, with your program's name, and enter the printed path in **Command**.
  Keep the script and its options in **Arguments (JSON array)**.
- "The server stopped before it answered."
  The program started but exited.
  If **Command** starts another program, add a `PATH` row in **Environment (JSON object)**, for example `/folder/of/the/program:${PATH}`.
  Otherwise read the server's last entries in **Logs**.
- "The server does not support MCP 2026-07-28."
  Turn on **Allow session-based clients** in the server dialog, submit and test again.
- "Link-local and cloud metadata upstream addresses are not allowed."
  Change the HTTP server's **Upstream URL** so it does not target `169.254.0.0/16`, `0.0.0.0/8`, `fe80::/10`, `::`, or IPv4-mapped IPv6 equivalents.
- "The gateway refused this Mac" or "The gateway refused the test".
  The gateway's own rules refused the request; see [Status codes](#status-codes).

For example, a Laravel Herd MCP entry whose **Command** is `php` passes in Terminal but fails in the app, because the app does not get your shell's `PATH`.
Enter the full path that `command -v php` prints, submit the server dialog and test again.

A failed test also marks the row with the gateway's own error, which stays until you save a change to that server or toggle it off and on.

## A referenced environment variable is not defined

The configuration uses `${NAME}` for a variable that the app's environment does not define.
See [Environment variables](configuration.md#environment-variables) for where the app reads them and how to set one for apps.

## Keychain setup failed on first launch

The signed app did not create `mcp.json` because it could not store and verify the initial global key.
Unlock the login Keychain and reopen the app, allowing access if macOS asks.
The app does not fall back to a plaintext key.
A failed attempt can leave an unused item under the `MCP Gateway APP` service, for example when you answer or dismiss a macOS dialog late.
Items whose account matches no `tokenRef` in `mcp.json` are unused; remove them in Keychain Access if you want.

## A Keychain key could not be read

The configuration refers to a key in Keychain with `tokenRef`, and the app could not read it.
The Keychain may be locked, access may have been denied, or the item may have been deleted.
The listener does not start, and no other key is used instead.
The form in **Settings** stays editable, unlike other configuration errors.

- Unlock the login Keychain, then choose **Start gateway**, which reads the key again.
- If the item is gone, choose **Generate secure token** in **Settings → Security** (which saves immediately) or **Generate secure key** in the server dialog and submit, then update your clients.
- An unsigned development build never reads Keychain; it shows "Keys stored in Keychain need the signed MCP Gateway app. Generate a new key to use this build."

See [Keys in Keychain](configuration.md#keys-in-keychain).

## Start gateway is disabled

Hover the button to read the reason.
Unsaved edits in **Authoritative configuration** show "Save or discard the unsaved changes first."
A configuration error shows "Repair the configuration first."
An unreadable Keychain key is the exception: **Start gateway** stays available so it can read the key again.

## Configuration errors

A configuration error pauses structured editing and shows a red blocker bar above the workspace with an **Authoritative configuration** button.
Open **Authoritative configuration** in **Settings** (`Cmd+4`) to repair the file; your original text stays available there, and validation errors include a **Line N** button to jump to the problem line.
To repair it in another editor, choose **Open in External Editor** or **Show in Finder** in **Settings → Advanced** (or **Authoritative configuration**), or **Help → Show Configuration in Finder**.

Common causes:

- Both `mcp.json` and `mcp.jsonc` exist.
  The app accepts one file only.
- The file is not readable only by you, or it is a symlink.
- Another running writer holds the advisory `flock` lock on `mcp.json.lock`, or `mcp.json.lock` is not an owner-only regular file (`0600`).
  Quit any other copy of the app, check permissions (`chmod 600`), and retry.
- An HTTP upstream `url` targets a link-local or cloud metadata address (`169.254.0.0/16`, `0.0.0.0/8`, `fe80::/10`, `::`, or an IPv4-mapped IPv6 form).
- A stdio server's `env` includes a blocked key (`NODE_OPTIONS`, `BUN_OPTIONS`, `DYLD_*`, `LD_*`).
- A field this version does not accept.
  Earlier releases reject `allowedPeers`, a server `token`, `tokenRef` and `keepAwake`.
- A slot has both `token` and `tokenRef`, or a `tokenRef` that is not a key ID in the form the app creates.
  Keep exactly one of them.

[The configuration file](configuration.md#the-configuration-file) lists the accepted fields and limits.
