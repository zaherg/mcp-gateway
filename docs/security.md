# Security

## Before you share an endpoint

- Use the gateway only on a trusted network.
  HTTP traffic is not encrypted.
- Give each client or device its own key, so one lost key can be revoked alone.
- Keep the copied configuration private.
  It contains the key in plain text.
- Treat the logs as sensitive.
  They can contain credentials and note content.
- To reach the gateway from outside your LAN, use a Tailscale or WireGuard address.
  Clients must come from this Mac, the selected interface's subnet, or **Allowed client ranges**, and those ranges accept only private and `100.64.0.0/10` addresses, so the gateway does not serve the public internet.

## Rotating a key

1. Open **Settings** and choose **Generate secure token** for the global key, or a server dialog and **Generate secure key** for one server.
2. Choose **Save changes**.
3. Update the clients that use the old key.

The old server key stops working at once, and that endpoint's open requests and sessions close.
Other endpoints keep running.
A new global key also restarts the listener.

## What a client can do

A client with a valid key can call every tool that server offers; the gateway does not filter tools.
A local command runs as your user account, so its tools can do what you can do.
With the Bear preset, a client can change notes, not just read them.
Disable a server you do not need with **Disabled (do not mount this endpoint)**, or delete it from the configuration.

## Rules the gateway enforces

- Use the gateway only on a trusted LAN, because HTTP traffic is not encrypted.
  Separate server keys separate access, not traffic.
- Every request needs the key for its endpoint and must come from this Mac or from an allowed client.
  Allowed clients are those in the selected interface's subnet, or only those in the `allowedPeers` ranges when that list is set.
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
A session-based client that holds 4 cancelled calls without a reply has its session closed, which frees them.
Request bodies, backend stdout lines and backend HTTP response bodies are limited to 4 MiB each.
Successful SSE streams have a 4 MiB limit per event instead.
Requests time out after 30 seconds.
