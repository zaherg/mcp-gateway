import { expect, mock, test } from "bun:test";
import { getEventListeners } from "node:events";
import { GatewayError } from "../../src/core/errors";
import {
  interfaceChoices,
  ipv4,
  isSelfProxyCancelled,
  peerAllowed,
  rejectSelfProxy,
  SELF_PROXY_DEADLINE_MS,
  selectInterface,
} from "../../src/core/network";
import { configFor, stdio } from "./helpers";

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
      rejectSelfProxy(config, {
        resolve: async () => addresses.map((address) => ({ address })),
      }),
    ).rejects.toMatchObject({ code: "NetworkPolicy" });
  }
  for (const addresses of [["127.0.0.1"], ["::1"], ["192.168.68.131"], ["::ffff:c0a8:4483"]]) {
    await expect(
      rejectSelfProxy(config, {
        resolve: async () => addresses.map((address) => ({ address })),
      }),
    ).resolves.toBeUndefined();
  }
  await expect(
    rejectSelfProxy(config, {
      resolve: async () => {
        throw new Error("synthetic lookup failure");
      },
    }),
  ).rejects.toMatchObject({ code: "NetworkPolicy" });
  await expect(rejectSelfProxy(config, { resolve: async () => [] })).rejects.toMatchObject({
    code: "NetworkPolicy",
  });
  const resolve = mock(async () => []);
  config.mcpServers = {
    disabled: { url: `http://synthetic.invalid:${config.gateway.port}`, disabled: true },
    differentPort: {
      url: `http://synthetic.invalid:${config.gateway.port === 1234 ? 1235 : 1234}`,
    },
  };
  await expect(rejectSelfProxy(config, { resolve })).resolves.toBeUndefined();
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

test("self-proxy validation spends one deadline across every relevant same-port upstream", async () => {
  const config = await configFor();
  config.mcpServers = {
    first: { url: `http://first.synthetic:${config.gateway.port}/mcp` },
    second: { url: `http://second.synthetic:${config.gateway.port}/mcp` },
    third: { url: `http://third.synthetic:${config.gateway.port}/mcp` },
  };
  const lookups: string[] = [];
  const began = Date.now();
  await expect(
    rejectSelfProxy(config, {
      deadline: began + 150,
      resolve: async (hostname) => {
        lookups.push(hostname);
        // Two slow answers consume the shared budget; a fresh budget per
        // hostname would still look up the third and wait for it.
        await Bun.sleep(80);
        return [{ address: "192.0.2.10" }];
      },
    }),
  ).rejects.toMatchObject({ code: "NetworkPolicy", message: expect.stringContaining("deadline") });
  expect(lookups).toEqual(["first.synthetic", "second.synthetic"]);
  expect(Date.now() - began).toBeLessThan(1_000);
});

test("self-proxy validation accepts cancellation and observes late answers without changing its refusal", async () => {
  const config = await configFor();
  config.mcpServers = { stalled: { url: `http://stall.synthetic:${config.gateway.port}/mcp` } };
  const abort = new AbortController();
  let settleLate: ((addresses: { address: string }[]) => void) | undefined;
  let rejectLate: ((error: Error) => void) | undefined;
  const resolve = (_hostname: string) =>
    new Promise<readonly { address: string }[]>((resolve, reject) => {
      settleLate = resolve;
      rejectLate = reject;
    });
  const cancelled = rejectSelfProxy(config, {
    resolve,
    signal: abort.signal,
    deadline: Date.now() + 5_000,
  });
  await Bun.sleep(10);
  const began = Date.now();
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({
    code: "Cancelled",
    message: "The self-proxy check was cancelled because the gateway is stopping.",
  });
  expect(Date.now() - began).toBeLessThan(500);
  expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  settleLate?.([{ address: config.gateway.host }]);
  await Bun.sleep(10);
  expect(isSelfProxyCancelled(await cancelled.catch((error: unknown) => error))).toBe(true);

  const timedOut = rejectSelfProxy(config, {
    resolve,
    deadline: Date.now() + 40,
  });
  const timedOutError = await timedOut.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(timedOutError instanceof GatewayError))
    throw new Error("Expected a bounded-validation refusal.");
  expect(timedOutError).toMatchObject({
    code: "NetworkPolicy",
    message: "An upstream address could not be checked before the deadline.",
  });
  rejectLate?.(new Error("synthetic late rejection"));
  await Bun.sleep(10);
  expect(timedOutError.code).toBe("NetworkPolicy");
  await expect(
    rejectSelfProxy(config, { resolve: async () => [{ address: "192.0.2.10" }] }),
  ).resolves.toBeUndefined();
  expect(SELF_PROXY_DEADLINE_MS).toBe(5_000);
});

test("cancellation and an expired deadline are refused even when no upstream needs a lookup", async () => {
  const config = await configFor();
  config.mcpServers = {
    stdio: stdio(),
    disabled: { url: `http://disabled.synthetic:${config.gateway.port}/mcp`, disabled: true },
    differentPort: { url: `http://different.synthetic:${config.gateway.port + 1}/mcp` },
  };
  const abort = new AbortController();
  abort.abort();
  const resolve = mock(async () => [{ address: config.gateway.host }]);
  await expect(
    rejectSelfProxy(config, {
      resolve,
      signal: abort.signal,
      deadline: Date.now() + 1_000,
    }),
  ).rejects.toMatchObject({
    code: "Cancelled",
    message: "The self-proxy check was cancelled because the gateway is stopping.",
  });
  expect(resolve).not.toHaveBeenCalled();
  await expect(
    rejectSelfProxy(config, { resolve, deadline: Date.now() - 1 }),
  ).rejects.toMatchObject({
    code: "NetworkPolicy",
    message: "An upstream address could not be checked before the deadline.",
  });
  expect(resolve).not.toHaveBeenCalled();
  await expect(rejectSelfProxy(config, { resolve })).resolves.toBeUndefined();
});

test("an already-cancelled validation observes a synchronously rejected lookup", async () => {
  const config = await configFor();
  config.mcpServers = { stalled: { url: `http://stall.synthetic:${config.gateway.port}/mcp` } };
  const abort = new AbortController();
  let unhandled = 0;
  const observe = () => {
    unhandled++;
  };
  process.on("unhandledRejection", observe);
  try {
    await expect(
      rejectSelfProxy(config, {
        signal: abort.signal,
        resolve: () => {
          // The resolver cancels the wait synchronously, then rejects before
          // the caller can install its settlement handlers.
          abort.abort();
          return Promise.reject(new Error("synthetic rejected lookup"));
        },
      }),
    ).rejects.toMatchObject({ code: "Cancelled" });
    await Bun.sleep(25);
    expect(unhandled).toBe(0);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
  } finally {
    process.off("unhandledRejection", observe);
  }
});

test("validation rechecks its deadline after an awaited lookup before accepting an answer", async () => {
  const config = await configFor();
  config.mcpServers = { slow: { url: `http://slow.synthetic:${config.gateway.port}/mcp` } };
  const deadline = Date.now() + 30;
  const resolve = async () => {
    // Occupy the event loop past the deadline so the resolution microtask
    // outruns the timer; the answer must still be refused.
    while (Date.now() < deadline + 15) {
      /* spin */
    }
    return [{ address: "192.0.2.10" }];
  };
  await expect(rejectSelfProxy(config, { resolve, deadline })).rejects.toMatchObject({
    code: "NetworkPolicy",
    message: "An upstream address could not be checked before the deadline.",
  });
});
