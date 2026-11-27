# Security

## Before you share an endpoint

- Use the gateway only on a trusted network.
  HTTP traffic is not encrypted.
- Give each client or device its own key, so one lost key can be revoked alone.
- Keep the copied configuration private.
  It contains the key in plain text.
- The signed app keeps a new installation's global key in Keychain.
  If your configuration contains plaintext keys, choose **Move keys to Keychain** so later backups do not contain them.
  Backups and copies made before the move still contain the keys; generate new keys if those may have been exposed.
  See [Keys in Keychain](configuration.md#keys-in-keychain); upstream `headers` and `env` values stay in the file.
- Treat the logs as sensitive.
  Logs automatically redact common tokens, authorization and API key headers, query secrets and configured server secrets, and suppress raw stdio `stderr` output by default, but backend output can still contain note content or other private values.
- To reach the gateway from outside your LAN, use a Tailscale or WireGuard address.
  Clients must come from this Mac, the selected interface's subnet, or **Allowed client ranges**, and those ranges accept only private and `100.64.0.0/10` addresses, so the gateway does not serve the public internet.

## Rotating a key

1. Open **Settings → Security** and choose **Generate secure token** for the global key (which saves immediately), or open a server dialog, choose **Generate secure key** and submit the dialog.
2. Update the clients that use the old key.

The old server key stops working at once, and that endpoint's open requests and sessions close.
Other endpoints keep running.
A new global key also restarts the listener.

For a key stored in Keychain, **Generate** writes a new key into the file.
Move it to Keychain again afterwards if you want; the old item stays in Keychain unused until you remove it in Keychain Access.

## What a client can do

A client with a valid key can call every tool that server offers; the gateway does not filter tools.
A local command runs as your user account, so its tools can do what you can do.
With the Bear preset, a client can change notes, not just read them.
Disable a server you do not need with its switch on **Overview** (or **Disabled (do not mount this endpoint)** in the server dialog), or delete it from the configuration.

## Rules the gateway enforces

- Use the gateway only on a trusted LAN, because HTTP traffic is not encrypted.
  Separate server keys separate access, not traffic.
- Every request needs the key for its endpoint (compared in constant time) and must come from this Mac or from an allowed client.
  Allowed clients are those in the selected interface's subnet, or only those in the `allowedPeers` ranges when that list is set.
- A server with its own key accepts only that key; the global key does not open that endpoint.
- The `Host` header must match the configured address and port.
- If a request has an `Origin` header, it must match the gateway's origin.
- HTTP `Upgrade` and WebSocket requests are refused (`403` when `Host` or `Origin` is invalid, `405` otherwise), and `Access-Control-Allow-Origin` response headers are stripped.
- Upstream credentials in `headers` are configured separately from `token`, and client tokens are never passed on.
- The gateway refuses HTTP redirects on all HTTP upstreams, whether or not custom headers are configured.
- HTTP upstream URLs pointing to link-local or cloud metadata addresses (`169.254.0.0/16`, `0.0.0.0/8`, `fe80::/10`, `::`, and IPv4-mapped IPv6 forms) are rejected.
- Local stdio commands inherit only a minimal allowlist of parent environment variables (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR`, `TERM`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `__CF_USER_TEXT_ENCODING`, plus `LC_*` and `XDG_*`) overlaid with their configured `env`; dangerous loader and runtime variables (`NODE_OPTIONS`, `BUN_OPTIONS`, `DYLD_*`, `LD_*`) are rejected by validation and stripped.
- In-app updates verify the v2 update manifest when present and check that the staged app bundle's code signature is valid and its Apple `TeamIdentifier` matches the installed app before restarting.
- `mcp.json` can start processes, so protect it.
- Logs and copied client configurations can expose private data and tokens.

The gateway accepts at most 32 HTTP requests at once and 240 new requests per minute.
At most 16 backend calls can run at once across all servers; extra calls get a capacity error.
At most 16 backend processes or upstream connections are open at once across all servers.
A slot is freed when the matching reply arrives or the backend is confirmed closed.
Cancelling a request may not free its slot right away.
A session-based client that holds 4 cancelled calls without a reply has its session closed, which frees them.
Request bodies, backend stdout lines and backend HTTP response bodies are limited to 4 MiB each.
Successful SSE streams have a 4 MiB limit per event instead.
Requests and request body reads time out after 30 seconds.
