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
After you close the window, choose **Open settings…** from the menu-bar icon, or open the app again, to bring it back.

## Add your first server

1. Open **Overview** and choose **Add server**.
2. Enter a **Server name**.
   It becomes part of the endpoint, as in `/mcp/server-name`.
3. Choose **Local command (stdio)** for an executable on this Mac, or **Streamable HTTP** for an existing MCP endpoint.
4. Fill in the fields for that transport.
   The command is an executable path only; arguments go in **Arguments (JSON array)**.
5. Choose **Apply to draft**.

Applying changes only the draft.
Nothing reaches the gateway until you choose **Save changes**.

If the server list is empty, **Use macOS Bear preset** opens the same dialog already filled in for Bear.
See [The Bear preset](servers.md#the-bear-preset) for what it fills in.

## Choose who can connect

Open **Settings** and set:

- **Interface / address**: start with `127.0.0.1` to allow this Mac only, then pick a LAN, Tailscale or WireGuard address when another device needs access.
- **Port**: any port from 1 to 65535 that is free on this Mac.
- **Global bearer token**: choose **Generate secure token**, or paste your own 32 to 512 printable ASCII characters without spaces.

Choose **Save changes** in the draft bar.

## Start the gateway

Choose **Start gateway** in the page heading, or use the menu-bar icon.
The page footer reads "Listener active" once the gateway is listening.
Each enabled server shows **Mounted**; [Managing servers](servers.md#managing-servers) explains what the status covers.

## Connect a client

Choose **Copy client configuration** on a server card, then paste the JSON into your client.
The copied configuration holds the server's endpoint and its key.
Follow [Connect a client](clients.md) for the format each client expects.

Most desktop clients still use an older MCP protocol.
Turn on **Allow session-based clients (MCP 2025-11-25 and earlier)** for a server before connecting one of them; [Protocol compatibility](clients.md#protocol-compatibility) explains the details.

## Next steps

- [Remote access](remote-access.md): reach the gateway from another device.
- [Security](security.md): keys, what clients can do and sharing rules.
- [Troubleshooting](troubleshooting.md): status codes and common failures.
