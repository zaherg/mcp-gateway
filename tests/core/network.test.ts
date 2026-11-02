import { expect, mock, test } from "bun:test";
import {
  interfaceChoices,
  ipv4,
  peerAllowed,
  rejectSelfProxy,
  selectInterface,
} from "../../src/core/network";
import { configFor } from "./helpers";

const selected = {
  name: "synthetic",
  address: "192.168.68.130",
  netmask: "255.255.252.0",
  loopback: false,
};
test("network admits only selected private subnet and loopback, including mapped IPv4", () => {
  for (const address of [
    "192.168.68.1",
    "192.168.71.254",
    "127.0.0.1",
    "::ffff:192.168.69.2",
    "::ffff:c0a8:4502",
    "::ffff:7f00:1",
  ])
    expect(peerAllowed(address, selected)).toBe(true);
  for (const address of [
    "192.168.72.1",
    "10.0.0.1",
    "172.16.0.1",
    "8.8.8.8",
    "::1",
    "2001:db8::1",
    "::ffff:8.8.8.8",
    "garbage",
  ])
    expect(peerAllowed(address, selected)).toBe(false);
  expect(peerAllowed("192.168.68.1", { ...selected, loopback: true })).toBe(false);
  expect(ipv4("::ffff:c0a8:4502")).toBe("192.168.69.2");
});

test("binding requires a currently assigned private or loopback interface", () => {
  expect(interfaceChoices().some((entry) => entry.address === "127.0.0.1")).toBe(true);
  expect(selectInterface("127.0.0.1").loopback).toBe(true);
  for (const address of ["0.0.0.0", "::", "8.8.8.8", "192.0.2.5", "localhost"])
    expect(() => selectInterface(address)).toThrow();
});

test("distinct private listener and loopback upstream may share a port", async () => {
  const config = await configFor();
  config.gateway.host = selected.address;
  config.mcpServers = { local: { url: `http://127.0.0.1:${config.gateway.port}/mcp` } };
  await expect(rejectSelfProxy(config)).resolves.toBeUndefined();
});

test("self-proxy checks all resolved addresses against the listener and fails closed on unresolved targets", async () => {
  const config = await configFor();
  config.gateway.host = selected.address;
  config.mcpServers = { alias: { url: `http://synthetic.invalid:${config.gateway.port}/mcp` } };
  for (const addresses of [
    [selected.address],
    ["127.0.0.1", selected.address],
    ["::ffff:192.168.68.130"],
    ["::ffff:c0a8:4482"],
    ["0.0.0.0"],
    ["::"],
    ["::ffff:0:0"],
  ]) {
    await expect(
      rejectSelfProxy(config, async () => addresses.map((address) => ({ address }))),
    ).rejects.toMatchObject({ code: "NetworkPolicy" });
  }
  for (const addresses of [["127.0.0.1"], ["::1"], ["192.168.68.131"], ["::ffff:c0a8:4483"]]) {
    await expect(
      rejectSelfProxy(config, async () => addresses.map((address) => ({ address }))),
    ).resolves.toBeUndefined();
  }
  await expect(
    rejectSelfProxy(config, async () => {
      throw new Error("synthetic lookup failure");
    }),
  ).rejects.toMatchObject({ code: "NetworkPolicy" });
  await expect(rejectSelfProxy(config, async () => [])).rejects.toMatchObject({
    code: "NetworkPolicy",
  });
  const resolve = mock(async () => []);
  config.mcpServers = {
    disabled: { url: `http://synthetic.invalid:${config.gateway.port}`, disabled: true },
    differentPort: {
      url: `http://synthetic.invalid:${config.gateway.port === 1234 ? 1235 : 1234}`,
    },
  };
  await expect(rejectSelfProxy(config, resolve)).resolves.toBeUndefined();
  expect(resolve).not.toHaveBeenCalled();
});

test("self-proxy recursion is refused for literal, DNS and mapped loopback addresses", async () => {
  const config = await configFor();
  for (const host of ["127.0.0.1", "localhost", "[::ffff:127.0.0.1]", "0.0.0.0"]) {
    config.mcpServers = { recursive: { url: `http://${host}:${config.gateway.port}/mcp/echo` } };
    await expect(rejectSelfProxy(config)).rejects.toMatchObject({ code: "NetworkPolicy" });
  }
  config.mcpServers = {
    differentPort: { url: `http://127.0.0.1:${config.gateway.port === 1234 ? 1235 : 1234}/mcp` },
  };
  await rejectSelfProxy(config);
});
