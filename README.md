# MCP Gateway

MCP Gateway is a macOS menu-bar app.
It shares local stdio MCP servers and remote Streamable HTTP MCP servers with other devices on a trusted LAN.

## Platform support

The app runs on Apple silicon Macs (arm64) with macOS 14.0 or newer.
It has not been tested on macOS 14.0 itself.
Linux and Windows are not supported.

## Use

Download the signed, notarized DMG from [GitHub Releases](https://github.com/zaherg/mcp-gateway/releases).
Copy the app to a writable location, then open it.

1. Add a server: a local executable or an HTTP(S) MCP server.
2. In Settings, choose a private IPv4 address, a port and a global bearer token.
3. Optionally, give a server its own key in the server dialog.
4. Start the gateway, then copy its configuration into your MCP client.

Each server gets its own endpoint, such as `http://192.168.1.120:8765/mcp/bear`.
Use `127.0.0.1` to allow only this Mac.
`Cmd+W` closes the window and leaves the gateway running.
`Cmd+Q` stops the gateway and the backends it started, then quits.
The Bear preset allows every Bear tool, including tools that change notes.

Logs are kept in memory only and are cleared when you quit.
**Launch app at login** is off by default.
When it is on, the app starts in the background, and you open the window from the menu-bar icon.

## Compatibility

By default, an endpoint speaks only MCP protocol `2026-07-28`.
This version is stateless: every message is a `POST` to `/mcp/<name>`.
`GET` and `DELETE` return 405.
Requests that use an older protocol version or the `initialize` handshake return 400.
The gateway bridges stdio servers itself.
An HTTP server must answer `server/discover` with `2026-07-28`, or the gateway refuses it.

Some clients do not support `2026-07-28` yet.
For them, turn on **Allow session-based clients** for a server, or set `"legacyProtocol": true` on it in `mcp.json`.
That endpoint then also accepts session-based MCP (`2025-11-25` and earlier, whichever the client asks for).
This includes the official `StreamableHTTPClientTransport`, with `initialize`, the `Mcp-Session-Id` header, the `GET` event stream and `DELETE`.
On such an endpoint, an HTTP server is reached with sessions too, so it does not need to speak `2026-07-28`.
Each session runs its own backend process or upstream session.
At most 8 sessions can be open across all endpoints.
Each session also takes one of the 16 shared backend slots.
A new session beyond either limit gets 429.
A session ends after 60 seconds without an open request or event stream, and the client must initialize again.
Session requests count toward the same 16-call limit and 4 MiB message limit as stateless requests.
App versions up to `0.3.2` reject a configuration that contains `legacyProtocol`.

## Automatic updates

The app updates itself with the built-in Electrobun updater.
It reads the fixed feed `https://github.com/zaherg/mcp-gateway/releases/latest/download`.
Only signed stable builds can update.
Development builds report that updates are unsupported and never contact the feed.

Automatic checks and downloads are on by default.
The first check runs about 10 seconds after launch, then once a day.
A failed check or download is retried about once an hour.
You can turn this off in **Settings → Updates**.
The app stores that choice in `updates.json`, next to `mcp.json`.
The app offers a release only when its version is higher than the installed one.

You can also check by hand in **Settings → Updates**.
An update installs only when you choose **Restart to Update** and confirm.
This stops the gateway and discards unsaved configuration changes.
If the handoff fails, the gateway stays stopped; quit and reopen the app to try again.

`0.3.2` is the first release that can update itself.
`0.3.0` cannot update, so install the `0.3.2` or later DMG by hand.
A local rehearsal updated a signed test build that was not notarized.
It used a loopback feed that redirected to an HTTPS test feed; see [RELEASING.md](RELEASING.md#testing-updates-locally).
Updating from one published GitHub release to the next has not been tested yet.

## Security

- Use the gateway only on a trusted LAN, because HTTP traffic is not encrypted.
  Separate server keys separate access, not traffic.
- Every request needs the key for its endpoint and must come from the selected subnet or from loopback.
- A server with its own key accepts only that key; the global key does not open that endpoint.
- The `Host` header must match the configured address and port.
- If a request has an `Origin` header, it must match the gateway's origin.
- Upstream credentials in `headers` are configured separately from `token`, and client tokens are never passed on.
- An upstream with configured headers must answer at its own address.
  The gateway does not follow its redirects, so those headers cannot reach another host.
- `mcp.json` can start processes, so protect it.
- Logs and copied client configurations can expose tokens and note content.

The gateway accepts at most 32 HTTP requests at once and 240 new requests per minute.
At most 16 backend calls can run at once across all servers; extra calls get a capacity error.
At most 16 backend processes or upstream connections are open at once across all servers.
A slot is freed when the matching reply arrives or the backend is confirmed closed.
Cancelling a request may not free its slot right away.
Request bodies, backend stdout lines and backend HTTP response bodies are limited to 4 MiB each.
Successful SSE streams have a 4 MiB limit per event instead.
Requests time out after 30 seconds.

## Configuration

Use one configuration file, either `mcp.json` or `mcp.jsonc`.
It lives in `~/Library/Application Support/MCP Gateway/`, and this location cannot be changed.
The same folder holds `updates.json`, the automatic-update setting.
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

`gateway` accepts `host`, `port`, `token`, `autoStart` and `launchAtLogin`.
The host must be a private IPv4 or loopback address that this Mac has right now.
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

## Build from source

See [DEVELOPMENT.md](DEVELOPMENT.md) to build, run and check the app from source.
See [RELEASING.md](RELEASING.md) to make signed releases, test updates locally and publish releases.
