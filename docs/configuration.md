# Configuration

## Editing in the app

Most settings are structured fields: the gateway preferences in **Settings**, and the server dialog on **Overview**.
The whole file is editable in **Authoritative configuration**, a collapsible section in **Settings**.
Use it to review or edit the whole file at once, or to repair a file that structured editing cannot load; it shows the file path and the full contents, including credentials.
The section below describes the file itself.

## The configuration file

The app edits this configuration for you, and **Authoritative configuration** in **Settings** opens the whole file in an editor.
The editor colors JSON and JSONC, numbers lines and matches brackets.
It checks the draft as you type and shows the problem with its line and column.
**Format** tidies the draft, **Reset** returns to the saved file after a confirmation, and **Save** stays off while the draft has a problem.
Saving always validates the file again.

Use one configuration file, either `mcp.json` or `mcp.jsonc`.
It lives in `~/Library/Application Support/MCP Gateway/`, and this location cannot be changed.
The same folder holds `updates.json`, the automatic-update setting, and `seen-version.json`, the version whose release notes you closed.
`mcp.json` must be strict JSON.
`mcp.jsonc` also allows comments and trailing commas.
If both files exist, the app reports an error.
To rename the file, quit the app first, then reopen it.
The files must be readable only by you, and symlinks are refused.

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

`gateway` accepts `host`, `port`, `token`, `autoStart`, `launchAtLogin` and `allowedPeers`.
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
Stdio servers accept `command`, `args`, `env`, `cwd`, `token` and `disabled`.
HTTP servers accept `url`, `headers`, `token` and `disabled`.
`token` is optional on a server.
Without it, the server accepts the global `gateway.token`.
With it, the server accepts only its own key, and the global key gets 401 on that endpoint.
A server `token` accepts the same `${NAME}` references as the global key.
An invalid explicit value is an error, never a silent fallback to the global key.
Bearer strings carry no identity, so give each shared server its own generated key.
Changing a server key refuses the old key at once and closes that endpoint's open requests and sessions before its replacement serves the new key, while other endpoints keep running.
Changing `gateway.token` still restarts the listener, but servers with their own key keep accepting only their own key.
Earlier releases reject a configuration that contains a server `token`, because their schemas are strict.
Server names are 1 to 64 ASCII letters, digits, `_` or `-`, and start with a letter or digit.
Tokens are 32 to 512 printable ASCII characters without spaces.
The configuration can be at most 1 MiB and hold at most 64 servers.

## Environment variables

The app expands `${NAME}` from its own environment rather than from your shell startup files.
A missing variable fails validation with "A referenced environment variable is not defined."

A Mac app opened from Finder or at login receives launchd's environment, so variables exported in a shell profile are not visible to it.
`launchctl setenv NAME value` sets a variable for apps launched afterwards, and the value lasts until the Mac restarts.
Quit and reopen MCP Gateway after setting it.

This describes standard macOS behavior; it was not tested with this release.

To extend the `PATH` of a local command, set it in the server's **Environment (JSON object)**, for example `"PATH": "/opt/homebrew/bin:${PATH}"`.
See [Commands that work in Terminal but not in the app](servers.md#commands-that-work-in-terminal-but-not-in-the-app).
