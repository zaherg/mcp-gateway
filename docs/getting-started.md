# Getting started

## Before you start

- An Apple silicon Mac with macOS 14 or newer.
  See [Platform support](../README.md#platform-support).
- A trusted network.
  HTTP traffic is not encrypted, so keep the gateway off the public internet.
- The MCP client you want to connect, such as Cursor or Claude Code.

## Install and open the app

1. Download the signed, notarized DMG from [GitHub Releases](https://github.com/zaherg/mcp-gateway/releases).
2. Copy the app to `/Applications` or another writable folder.
3. Open the app.
   A window opens, and an icon appears in the menu bar.

The window has three tabs: **Overview**, **Settings** and **Logs**.
After you close the window, choose **Open MCP Gateway** from the menu-bar icon, or open the app again, to bring it back.

## Add your first server

1. Open **Overview** and choose **Add server** (or press `Cmd+N`).
2. Enter a **Server name**.
   It becomes part of the endpoint, as in `/mcp/server-name`.
3. Choose **Local command (stdio)** for an executable on this Mac, or **Streamable HTTP** for an existing MCP endpoint.
4. Fill in the fields for that transport.
   The command is an executable path only; add each argument as a row under **Arguments (JSON array)** with **Add Argument**.
5. Submit the dialog (**Apply to draft**).

Submitting the server dialog saves the configuration right away and closes the dialog.

If the server list is empty, **Use macOS Bear preset** opens the same dialog already filled in for Bear.
See [The Bear preset](servers.md#the-bear-preset) for what it fills in.
You can also import existing servers from Claude Desktop or Cursor from **Settings → Advanced**.

## Choose who can connect

Open **Settings** and set:

- **Network → Interface / address**: start with `127.0.0.1` to allow this Mac only, then pick a LAN, Tailscale or WireGuard address when another device needs access.
- **Network → Port**: any port from 1 to 65535 that is free on this Mac.
- **Security → Global bearer token**: on a fresh install this shows **Stored in Keychain**.
  Keep that key unless you want to replace it.

Text fields in **Settings** save when you leave the field or press `Return`; switches and key-generation buttons save right away.
For keys already saved in a configuration file, see [Keys in Keychain](configuration.md#keys-in-keychain).

## Start the gateway

Choose **Start gateway** in the page heading, or use the menu-bar icon.
The status pill next to **Servers** on **Overview** reads **Gateway running** with the listening `<address>:<port>`, and the menu-bar icon shows a green dot.
Each enabled server shows a green status light (hover it to see **Mounted**); [Managing servers](servers.md#managing-servers) explains what the status covers.

## Test the server

Choose **Test connection** on the server row.
The gateway starts the server, or contacts its HTTP upstream, and waits for the MCP handshake a client would send.
A result such as "Server answered through the gateway (MCP 2026-07-28)." means the server works through its endpoint on this Mac.
If the test fails, the row says what to change; [A server test fails](troubleshooting.md#a-server-test-fails) has examples.

## Connect a client

Choose **Copy client configuration** on a server row, then paste the JSON into your client.
The copied configuration holds the server's endpoint and its key.
Follow [Connect a client](clients.md) for the format each client expects.

Most desktop clients still use an older MCP protocol.
Turn on **Allow session-based clients (MCP 2025-11-25 and earlier)** for a server before connecting one of them; [Protocol compatibility](clients.md#protocol-compatibility) explains the details.

## Next steps

- [Remote access](remote-access.md): reach the gateway from another device.
- [Security](security.md): keys, what clients can do and sharing rules.
- [Troubleshooting](troubleshooting.md): status codes and common failures.
