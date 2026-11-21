# Configuration

## Editing in the app

Most settings are structured fields: the gateway preferences in **Settings**, and the server dialog on **Overview**.
Structured edits rewrite only the values you change; a removed value also takes its line with it when nothing else is on that line.
**Authoritative configuration**, a collapsible section in **Settings**, shows the file path and the full contents, including credentials.
A key stored in the macOS Keychain appears there only as its `tokenRef`.
Use it to edit the file directly, or to repair one that structured editing cannot load.
**Show in Finder** in that section selects the file in Finder, so you can open it in another editor; if the file is missing, it opens the folder instead.
The section below describes the file itself.

## The configuration file

The app edits this configuration for you, and **Authoritative configuration** in **Settings** opens the whole file in an editor.
The editor colors JSON and JSONC, numbers lines and matches brackets.
It checks the draft as you type and shows the problem with its line and column.
**Format** tidies the draft, **Reset** returns to the saved file after a confirmation, and **Save** stays off while the draft has a problem.
Saving always validates the file again.

Use one configuration file, either `mcp.json` or `mcp.jsonc`.
It lives in `~/Library/Application Support/MCP Gateway/`, and this location cannot be changed.
The same folder holds `updates.json`, the automatic-update setting, `seen-version.json`, the version whose release notes you closed, `language.json`, the app language you chose in the sidebar, and `key-reminder.json`, which records that the Keychain reminder was closed.
`mcp.json` must be strict JSON.
`mcp.jsonc` also allows comments and trailing commas.
If both files exist, the app reports an error.
To rename the file, quit the app first, then reopen it.
The files must be readable only by you, and symlinks are refused.
The app reloads the file when another app saves it.
Save or discard unsaved changes in the app first; otherwise its next save is refused as stale.
If the app reports that the configuration must be an owner-only regular file after an outside edit, run `chmod 600` on the file.
If it reports a second hard link after the app stopped during its first launch, delete the hidden `.mcp.json.<id>.tmp` (or `.mcp.jsonc.<id>.tmp`) file in the same folder, then reopen the app.

After a crash, an `mcp.json.lock` file may remain next to the configuration.
Quit every running copy of the app and make sure nothing else is writing the file.
Then delete the lock and try again.

```json
{
  "gateway": { "host": "127.0.0.1", "port": 8765, "token": "${MCP_GATEWAY_TOKEN}" },
  "mcpServers": {
    "bear": { "command": "/Applications/Bear.app/Contents/MacOS/bearcli", "args": ["mcp-server"] },
    "shared": { "command": "/path/to/mcp-server", "token": "${SHARED_MCP_TOKEN}" },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${UPSTREAM_TOKEN}" },
      "disabled": true
    }
  }
}
```

`gateway` accepts `host`, `port`, `token` or `tokenRef`, `autoStart`, `launchAtLogin` and `allowedPeers`.
It also accepts `keepAwake`.
Set `keepAwake` to `true` to prevent idle system sleep while the listener runs, or omit it to leave sleep unchanged.
You can change it without restarting the gateway.
Remove `keepAwake` before opening the file in an older release; older schemas reject the field even when it is `false`.
The host must be a private IPv4, `100.64.0.0/10` or loopback address that this Mac has right now.
`allowedPeers` is an optional list of 1 to 16 IPv4 ranges, such as `["100.64.0.0/10"]`.
When it is set, the gateway accepts clients in those ranges and on this Mac, instead of clients in the selected interface's subnet.
Each range must lie inside `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` or `100.64.0.0/10`, with no host bits set.
`allowedPeers` cannot be combined with a loopback host.
A `100.64.0.0/10` host requires `allowedPeers`, because Tailscale and carrier networks share that range and its interface netmask does not identify your devices.
Changing `allowedPeers` restarts the listener and closes open requests and sessions.
Earlier releases reject a configuration that contains `allowedPeers`, because their schemas are strict.
The port must be between 1 and 65535.
`${NAME}` reads a variable from the app's environment, not from your shell startup files.
A missing variable is an error.
Stdio servers accept `command`, `args`, `env`, `cwd`, `token` or `tokenRef`, and `disabled`.
HTTP servers accept `url`, `headers`, `token` or `tokenRef`, and `disabled`.
`token` is optional on a server.
Without it, the server accepts the global `gateway.token`.
With it, the server accepts only its own key, and the global key gets 401 on that endpoint.
A server `token` accepts the same `${NAME}` references as the global key.
An invalid explicit value is an error, never a silent fallback to the global key.
Bearer strings carry no identity, so give each shared server its own generated key.
Changing a server key refuses the old key at once and closes that endpoint's open requests and sessions before its replacement serves the new key, while other endpoints keep running.
Changing `gateway.token` still restarts the listener, but servers with their own key keep accepting only their own key.
Earlier releases reject a configuration that contains a server `token`, because their schemas are strict.
A key can be stored in the macOS Keychain instead; see [Keys in Keychain](#keys-in-keychain).
Server names are 1 to 64 ASCII letters, digits, `_` or `-`, and start with a letter or digit.
Tokens are 32 to 512 printable ASCII characters without spaces.
The configuration can be at most 1 MiB and hold at most 64 servers.

## Keys in Keychain

When neither `mcp.json` nor `mcp.jsonc` exists, the signed app generates the global key in memory, stores it in Keychain, and reads it back before creating `mcp.json` with only `gateway.tokenRef`.
If Keychain cannot store or verify the key, no configuration file is created; unlock Keychain, allow access, and reopen the app.

An upgrade leaves existing files and keys unchanged.
You can move the global key and each server's own key to Keychain without rotating them.
Upstream `headers` values and `env` values always stay in the file.

To move them, choose **Review keys** in the Overview reminder or **Move keys to Keychain** in **Settings**.
Save or discard any draft first.
The dialog lists the keys by name, never by value, and asks you to confirm a one-way move.
All listed keys move together, or none do.
Choosing **Stop gateway** while a requested move is still waiting to run cancels it, and nothing changes.

A key can move when it is written in the file as a literal.
Keys written as `${NAME}`, servers that use the global key, and keys already in Keychain are not offered.
Clients keep using the same keys, so nothing needs to change on their side, and the running listener and open sessions continue.

After the move, each slot holds `tokenRef` instead of `token`, for example:

```json
"gateway": { "host": "127.0.0.1", "port": 8765, "tokenRef": "0b6c2d1e-4f7a-4c1b-9e2d-3a5b6c7d8e9f" }
```

A slot holds either `token` or `tokenRef`, never both.
The app writes `tokenRef` values itself; it creates and replaces Keychain items but never deletes one.
In Keychain Access, look for the service `MCP Gateway APP` (`MCP Gateway APP Test` for signed test builds) and match the **Account** to the `tokenRef` UUID.
Items created before the rename stay under `MCP Gateway` or `MCP Gateway Test` and remain readable there.
If storing or reading back a key fails, or the file changed in the meantime, the file is left unchanged and any item already created stays unused in Keychain; remove it in Keychain Access if you want.

The move cannot be undone in the app.
To go back by hand, find the matching service and account in Keychain Access, copy the item's password, and replace `"tokenRef": "…"` with `"token": "<the copied key>"` in the file.
To replace a stored key instead, choose **Generate secure token** in Settings or **Generate secure key** in the server dialog, then save; this writes a new literal key that you can move again.

Limits:

- Earlier releases cannot open a file that contains `tokenRef`, because their schemas are strict.
- Copying the configuration file to another Mac does not copy the Keychain items.
- Unsigned development builds never access Keychain: they create new files with a literal `token` and report an error for a file with `tokenRef`.
  The signed `MCP Gateway Dev` build uses Keychain like the production app.
- When the Keychain is locked, macOS may ask for your password; the app stops waiting after 5 seconds and shows a configuration error until the key can be read.
  After unlocking, choose **Start gateway** to read the key again.

The reminder on Overview appears once, until you close it, choose **Keep keys in file**, or start a move.
It does not come back after that, even after a restart or an update.
A new installation shows no reminder; the **Settings** button stays available while a key can move.

## Environment variables

The app expands `${NAME}` from its own environment rather than from your shell startup files.
A missing variable fails validation with "A referenced environment variable is not defined."

A Mac app opened from Finder or at login receives launchd's environment, so variables exported in a shell profile are not visible to it.
`launchctl setenv NAME value` sets a variable for apps launched afterwards, and the value lasts until the Mac restarts.
Quit and reopen MCP Gateway after setting it.
To keep a gateway key out of the file without an environment variable, write it as a literal key and move it to the macOS Keychain; see [Keys in Keychain](#keys-in-keychain).

This describes standard macOS behavior; it was not tested with this release.

To extend the `PATH` of a local command, set it in the server's **Environment (JSON object)**, for example `"PATH": "/opt/homebrew/bin:${PATH}"`.
See [Commands that work in Terminal but not in the app](servers.md#commands-that-work-in-terminal-but-not-in-the-app).
