# Troubleshooting

## When the client cannot connect at all

Check these first:

- The gateway is running.
  The footer reads "Listener active".
- The Mac is awake.
  Sleep takes the endpoints offline.
- The endpoint uses the address currently saved in **Settings**, not an older DHCP address.
- The port in the client matches the port in **Settings**.

## Status codes

The client reports the status code.
MCP Gateway does not log refused requests, so read the code in the client's own logs.

| Status | Cause |
| --- | --- |
| `401` | Missing or wrong `Authorization: Bearer` key for that endpoint. A server with its own key rejects the global key. |
| `503` | The gateway is closing, or the configured address is no longer on this Mac. |
| `403` | The client is outside the allowed clients (the interface subnet, or **Allowed client ranges**); the `Host` header is not exactly `<address>:<port>`, which rejects host names such as MagicDNS names; or the `Origin` header does not match. |
| `404` | No such server, the server is disabled, or it is not mounted, for example a server in **Error**. |
| `405` | A method the endpoint does not accept, such as `GET` or `DELETE` without **Allow session-based clients**. |
| `400` | Protocol mismatch: an older protocol version or the `initialize` handshake on a stateless endpoint, or a body on a request that is not a `POST`. |
| `413` | Request body over 4 MiB. |
| `415` | Compressed request body. |
| `429` | More than 32 requests at once, more than 240 per minute, or a session limit. |
| `504` | No reply within 30 seconds. |
| `502` | The backend failed. The details are in **Logs**. |

`400` and `405` usually mean the client speaks an older protocol.
Turn on **Allow session-based clients** for that server and try again; see [Protocol compatibility](clients.md#protocol-compatibility).

## The server shows an error

A red light and the word **Error** mean the gateway could not mount the server.
The card shows the error message; open **Logs** and read the last entries for that server.

**Mounted** with failing tools also points at the backend; check **Logs** for its output.

## A command is not found

A command that works in Terminal can fail in the app with `ENOENT`.
An app opened from Finder or at login does not get the `PATH` from your shell.
Use an absolute path in **Command**, and extend `PATH` in **Environment (JSON object)** when the command starts another program.
See [Commands that work in Terminal but not in the app](servers.md#commands-that-work-in-terminal-but-not-in-the-app).

## A server test fails

**Test connection** on a server card names what to check:

- "The gateway could not find the program in Command."
  The app cannot find the executable, usually because **Command** holds a bare name such as `php`.
  Run `command -v php` in Terminal, with your program's name, and enter the printed path in **Command**.
  Keep the script and its options in **Arguments**.
- "The server stopped before it answered."
  The program started but exited.
  If **Command** starts another program, add that program's folder to `PATH` in **Environment (JSON object)**, for example `"PATH": "/folder/of/the/program:${PATH}"`.
  Otherwise read the server's last entries in **Logs**.
- "The server does not support MCP 2026-07-28."
  Turn on **Allow session-based clients**, save and test again.
- "The gateway refused this Mac" or "The gateway refused the test".
  The gateway's own rules refused the request; see [Status codes](#status-codes).

For example, a Laravel Herd MCP entry whose **Command** is `php` passes in Terminal but fails in the app, because the app does not get your shell's `PATH`.
Enter the full path that `command -v php` prints, save and test again.

A failed test also marks the card with the gateway's own error, which stays until you save a change to that server or restart it.

## A referenced environment variable is not defined

The configuration uses `${NAME}` for a variable that the app's environment does not define.
See [Environment variables](configuration.md#environment-variables) for where the app reads them and how to set one for apps.

## Keychain setup failed on first launch

The signed app did not create `mcp.json` because it could not store and verify the initial global key.
Unlock the login Keychain and reopen the app, allowing access if macOS asks.
The app does not fall back to a plaintext key.
A failed attempt can leave an unused item under the `MCP Gateway APP` service, for example when you answer the macOS dialog after the app stopped waiting.
Items whose account matches no `tokenRef` in `mcp.json` are unused; remove them in Keychain Access if you want.

## A Keychain key could not be read

The configuration refers to a key in Keychain with `tokenRef`, and the app could not read it.
The Keychain may be locked, access may have been denied, or the item may have been deleted.
When macOS asks for the Keychain password, the app stops waiting after 5 seconds, but the macOS dialog stays open until you answer it.
The listener does not start, and no other key is used instead.
The form in **Settings** stays editable, unlike other configuration errors.

- Unlock the login Keychain, then choose **Start gateway**, which reads the key again.
- If the item is gone, choose **Generate secure token** in Settings or **Generate secure key** in the server dialog, save, and update your clients.
- An unsigned development build never reads Keychain; it shows "Keys stored in Keychain need the signed MCP Gateway app. Generate a new key to use this build."

See [Keys in Keychain](configuration.md#keys-in-keychain).

## Start gateway is disabled

Hover the button to read the reason.
An open draft shows "Save or discard the unsaved changes first."
A configuration error shows "Repair the configuration first."
An unreadable Keychain key is the exception: **Start gateway** stays available so it can read the key again.

## Configuration errors

A configuration error pauses structured editing and shows a banner.
Open **Authoritative configuration** in **Settings** to repair the file; your original text stays available there.
To repair it in another editor, choose **Show in Finder** in that section, or **Help > Show Configuration in Finder**.

Common causes:

- Both `mcp.json` and `mcp.jsonc` exist.
  The app accepts one file only.
- The file is not readable only by you, or it is a symlink.
- A leftover `mcp.json.lock` from a crash.
  Quit every running copy, make sure nothing else is writing the file, then delete the lock.
- A field this version does not accept.
  Earlier releases reject `allowedPeers`, a server `token` and `tokenRef`.
- A slot has both `token` and `tokenRef`, or a `tokenRef` that is not a key ID in the form the app creates.
  Keep exactly one of them.

[The configuration file](configuration.md#the-configuration-file) lists the accepted fields and limits.
