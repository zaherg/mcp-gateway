# Remote access

## Choosing an address

The gateway listens on one address at a time, the value in **Interface / address**.
The choices are loopback, a LAN address, a Tailscale address or a WireGuard address.
Settings suggests addresses with a label for each network: "this computer only", "LAN", "Tailscale" or "VPN tunnel".

Use `127.0.0.1` to allow only this Mac.
The sidebar notice names the network of the saved address: this Mac only, LAN, Tailscale or a VPN tunnel.

## Using it from another device on your LAN

1. In **Settings**, choose the LAN address of this Mac and a port.
2. Choose **Save changes**, then **Start gateway**.
3. On the other device, use `http://<lan-address>:<port>/mcp/<name>` in the client.

DHCP can give this Mac a new address.
When that happens, requests get `503` until you pick the new address; a DHCP reservation on your router avoids the problem.

## Keeping the endpoints reachable

Sleep takes the endpoints offline, and the app does not prevent sleep.
`caffeinate -i` in Terminal prevents idle sleep for as long as it runs.
Reachability from other devices is not verified by the app.

## Tailscale and WireGuard

The gateway can listen on a Tailscale or WireGuard address, so clients reach it through an encrypted tunnel.
In **Settings**, select the tunnel address, such as this Mac's `100.x.y.z` Tailscale address.
Then set **Allowed client ranges**, which is `allowedPeers` in `mcp.json`.
A `100.64.0.0/10` address cannot be saved without it, and a WireGuard interface may report a single-address netmask that admits no other device.
For Tailscale, use `100.64.0.0/10`; for WireGuard, use the tunnel's network, such as `10.8.0.0/24`.
Clients must put the tunnel address in the endpoint URL.
A MagicDNS or other host name gets 403, because the `Host` header must match the configured address.
Every device in a listed range can reach the endpoints, including devices shared into your tailnet, so keep each key private.
Tailscale access controls or WireGuard `AllowedIPs` decide which devices can connect at all.

## Allowed client ranges

**Allowed client ranges** limits which clients may connect.
The placeholder, "Selected interface's subnet", is the default: clients in the subnet of the chosen address.
Enter IPv4 ranges separated by commas to name the clients explicitly.
Leave the field empty with a loopback address such as `127.0.0.1`; the two cannot be combined.
[The configuration file](configuration.md#the-configuration-file) describes the `allowedPeers` field and its validation rules.
