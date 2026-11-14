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

## A referenced environment variable is not defined

The configuration uses `${NAME}` for a variable that the app's environment does not define.
See [Environment variables](configuration.md#environment-variables) for where the app reads them and how to set one for apps.

## Start gateway is disabled

Hover the button to read the reason.
An open draft shows "Save or discard the unsaved changes first."
A configuration error shows "Repair the configuration first."

## Configuration errors

A configuration error pauses structured editing and shows a banner.
Open **Authoritative configuration** in **Settings** to repair the file; your original text stays available there.

Common causes:

- Both `mcp.json` and `mcp.jsonc` exist.
  The app accepts one file only.
- The file is not readable only by you, or it is a symlink.
- A leftover `mcp.json.lock` from a crash.
  Quit every running copy, make sure nothing else is writing the file, then delete the lock.
- A field this version does not accept.
  Earlier releases reject `allowedPeers` and a server `token`.

[The configuration file](configuration.md#the-configuration-file) lists the accepted fields and limits.
