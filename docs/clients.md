# Connect a client

Each client section follows that client's documentation as of 2026-11-14.
Client formats change; if a step no longer matches, check the linked source.

## What the app copies

**Copy client configuration** on a server card copies this JSON, with the server's real endpoint and its effective key:

```json
{
  "mcpServers": {
    "bear": {
      "url": "http://192.168.1.120:8765/mcp/bear",
      "headers": {
        "Authorization": "Bearer <key>"
      }
    }
  }
}
```

The key is in plain text.
Keep the paste target private.
**Copy endpoint** copies only the URL.

## Before you connect

- Start the gateway.
  The client cannot connect while the footer reads "No active listener".
- Use the IP address from the endpoint.
  A host name such as a MagicDNS name gets `403`, because the `Host` header must match the configured address.
- Turn on **Allow session-based clients (MCP 2025-11-25 and earlier)** for any server used from the clients below.
  Most desktop hosts still speak the older protocol.
- Keep the Mac awake while a client is connected; sleep takes the endpoints offline.

## Cursor

Source: https://cursor.com/help/customization/mcp, checked 2026-11-14.

Cursor reads `~/.cursor/mcp.json` for all projects, or `.cursor/mcp.json` in a project.
Both files are merged, and the project file wins for the same server name.

The copied configuration works as-is, because Cursor uses `url` and `headers` inside `mcpServers`:

```json
{
  "mcpServers": {
    "bear": {
      "url": "http://192.168.1.120:8765/mcp/bear",
      "headers": {
        "Authorization": "Bearer <key>"
      }
    }
  }
}
```

Save the file and restart Cursor.
For logs, open the Output panel (`Cmd+Shift+U`) and select **MCP Logs**.

## Claude Code

Source: https://code.claude.com/docs/en/mcp, checked 2026-11-14.

Add the server from a terminal:

```sh
claude mcp add --transport http bear http://192.168.1.120:8765/mcp/bear --header "Authorization: Bearer <key>"
```

Add `--scope user` to make it available in every project; the default is local scope.

A JSON entry must include `"type": "http"`.
An entry with a `url` and no `type` is a configuration error, because Claude Code reads it as a stdio server.
With `claude mcp add-json`, pass the object inside `mcpServers`, not the wrapper:

```sh
claude mcp add-json bear '{"type":"http","url":"http://192.168.1.120:8765/mcp/bear","headers":{"Authorization":"Bearer <key>"}}'
```

Check with `claude mcp list`, `claude mcp get bear`, or `/mcp` inside Claude Code.

## Claude Desktop

Source: https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp and https://github.com/geelen/mcp-remote, checked 2026-11-14.

Custom connectors do not work with MCP Gateway.
Claude connects to a custom connector from Anthropic's cloud infrastructure, not from your Mac, so it cannot reach a LAN address.
Custom connectors also require the public internet and port 443.

The separate mechanism, a local MCP server in `claude_desktop_config.json`, does use your local network.
The bridge package `mcp-remote` is a third-party package that `npx` downloads, and it runs with your user's permissions.
It needs Node.js 18 or newer, and Claude Desktop uses your system version of Node.

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bear": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://192.168.1.120:8765/mcp/bear",
        "--allow-http",
        "--header",
        "Authorization:${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer <key>"
      }
    }
  }
}
```

`--allow-http` is required for a plain `http://` address and should only be used on a secure private network.
The header argument uses the no-space `Authorization:${AUTH_HEADER}` form, which avoids argument escaping problems.
`mcp-remote` sends the client's `initialize` request straight through, so the server must have **Allow session-based clients** on.

Restart Claude Desktop after editing.
For logs, run `tail -n 20 -F ~/Library/Logs/Claude/mcp*.log`.

## Codex

Source: https://developers.openai.com/codex/mcp, checked 2026-11-14.

Codex reads `~/.codex/config.toml`, or `.codex/config.toml` in a trusted project.
The ChatGPT desktop app, the Codex CLI and the IDE extension share the file.

Add one table per server, with `url` and either `bearer_token_env_var` or `http_headers`:

```toml
[mcp_servers.bear]
url = "http://192.168.1.120:8765/mcp/bear"
bearer_token_env_var = "MCP_GATEWAY_BEAR_KEY"
```

`bearer_token_env_var` names an environment variable that holds the key, which keeps the key out of the file.
Set that variable in the environment Codex runs in.

The desktop app and the IDE extension also offer **Settings** (or the gear menu), then **MCP servers**, **Add server**, **Streamable HTTP**.
Save the server, then restart the desktop app or the extension.

Check with `codex mcp list` or `/mcp` in the Codex TUI.

## Hermes Agent

Source: https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp, checked 2026-11-14.

Hermes reads `~/.hermes/config.yaml`.
Add the server under `mcp_servers`:

```yaml
mcp_servers:
  bear:
    url: "http://192.168.1.120:8765/mcp/bear"
    headers:
      Authorization: "Bearer <key>"
```

Start Hermes with `hermes chat`.
After editing the file, start a new session or run `/reload-mcp`.

## OpenClaw

Source: https://docs.openclaw.ai/tools/mcp and https://docs.openclaw.ai/gateway/config-extensions, checked 2026-11-14.

OpenClaw defines servers under `mcp.servers`.
A remote entry uses `url`, `transport: "streamable-http"` and `headers`:

```json5
{
  mcp: {
    servers: {
      bear: {
        url: "http://192.168.1.120:8765/mcp/bear",
        transport: "streamable-http",
        headers: {
          Authorization: "Bearer ${MCP_GATEWAY_BEAR_KEY}",
        },
      },
    },
  },
}
```

From the terminal, add the server and then the header:

```sh
openclaw mcp add bear --url http://192.168.1.120:8765/mcp/bear --transport streamable-http
```

Add the header in the Control UI **Settings → MCP** scoped config editor.
Verify with `openclaw mcp doctor bear --probe`; saving a definition does not prove the server is reachable.

The `${MCP_GATEWAY_BEAR_KEY}` reference follows OpenClaw's own header example; replace it with the key, or provide that variable to OpenClaw.
OpenClaw's Streamable HTTP client uses sessions, so turn on **Allow session-based clients** for the server.
OpenClaw's own "Gateway" is a different program from MCP Gateway.

## Protocol compatibility

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
