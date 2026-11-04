import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isJSONRPCRequest, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { reconcileTransaction } from "../../src/main/updater/transaction";
import { eventually } from "../core/helpers";

function rpcRequest(body: string, session?: string) {
  return new Request("http://127.0.0.1/mcp", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
      ...(session ? { "mcp-session-id": session } : {}),
    },
  });
}
const initialization = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "audit-gate", version: "1" },
  },
};
const initialized = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  serverInfo: { name: "audit-gate", version: "1" },
};

test("A13 capability: installed transport uses a validated supplied body without rereading consumed input", async () => {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const checked = JSONRPCMessageSchema.parse(initialization);
  const observed: unknown[] = [];
  transport.onmessage = (message) => {
    observed.push(message);
    if (isJSONRPCRequest(message))
      void transport.send({ jsonrpc: "2.0", id: message.id, result: initialized });
  };
  await transport.start();
  try {
    const request = rpcRequest("not JSON: this input must not be parsed again");
    const response = await transport.handleRequest(request, { parsedBody: checked });
    expect(response.status).toBe(200);
    expect(request.bodyUsed).toBe(false);
    expect(observed).toEqual([checked]);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: initialized });
  } finally {
    await transport.close();
  }
});

const darwinTest = test.skipIf(process.platform !== "darwin");

darwinTest(
  "A6 authority probe: an empty transaction directory is recovered under the kernel guard",
  async () => {
    await mkdir(resolve(".cache"), { recursive: true });
    const root = await mkdtemp(resolve(".cache/audit-a6-"));
    const channel = join(root, "channel");
    const data = join(root, "data");
    try {
      await mkdir(join(channel, ".mcp-gateway-update-transaction"), {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(data, { mode: 0o700 });
      const reconciled = await reconcileTransaction({ channelRoot: channel, dataDirectory: data });
      expect(reconciled.status).toBe("none");
    } finally {
      await rm(root, { recursive: true });
    }
  },
);

test("A3 blocking probe: suppressing stream closure leaves a JSON batch waiting on the cancelled id", async () => {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => "synthetic-gate-session",
    enableJsonResponse: true,
  });
  await transport.start();
  transport.onmessage = (message) => {
    if (isJSONRPCRequest(message))
      void transport.send({ jsonrpc: "2.0", id: message.id, result: initialized });
  };
  const initializedResponse = await transport.handleRequest(
    rpcRequest(JSON.stringify(initialization)),
  );
  expect(initializedResponse.status).toBe(200);
  await initializedResponse.text();
  const seen: unknown[] = [];
  transport.onmessage = (message) => {
    seen.push(message);
  };
  let settled = false;
  const pending = transport
    .handleRequest(
      rpcRequest(
        JSON.stringify([
          { jsonrpc: "2.0", id: 20, method: "ping" },
          { jsonrpc: "2.0", id: 21, method: "ping" },
        ]),
        "synthetic-gate-session",
      ),
    )
    .then((response) => {
      settled = true;
      return response;
    });
  try {
    await eventually(() => seen.length === 2);
    // Exercise exactly the earlier proposed suppression approach, without touching SDK maps.
    const close = transport.closeSSEStream;
    transport.closeSSEStream = () => {};
    try {
      transport.closeSSEStream(20);
    } finally {
      transport.closeSSEStream = close;
    }
    await transport.send({ jsonrpc: "2.0", id: 21, result: { sibling: "kept" } });
    await Bun.sleep(30);
    expect(settled).toBe(false);
  } finally {
    // A late ordinary result is only fixture cleanup, not a proposed cancellation response.
    await transport.send({ jsonrpc: "2.0", id: 20, result: { fixtureCleanup: true } });
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { jsonrpc: "2.0", id: 20, result: { fixtureCleanup: true } },
      { jsonrpc: "2.0", id: 21, result: { sibling: "kept" } },
    ]);
    await transport.close();
  }
});
