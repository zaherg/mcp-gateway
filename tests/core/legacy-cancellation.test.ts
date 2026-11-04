import { expect, test } from "bun:test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isJSONRPCRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createParser } from "eventsource-parser";
import { legacyCancellation } from "../../src/core/legacy-cancellation";
import { eventually } from "./helpers";

function request(body: unknown) {
  return new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": "synthetic",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify(body),
  });
}
async function fixture(json: boolean) {
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: json,
    sessionIdGenerator: () => "synthetic",
  });
  const cancel = legacyCancellation(transport);
  await transport.start();
  transport.onmessage = (message) => {
    if (isJSONRPCRequest(message))
      void transport.send({ jsonrpc: "2.0", id: message.id, result: {} });
  };
  const initialized = await transport.handleRequest(
    request({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "synthetic", version: "1" },
      },
    }),
  );
  await initialized.text();
  const seen: JSONRPCMessage[] = [];
  transport.onmessage = (message) => {
    seen.push(message);
  };
  const counts = () =>
    ["_requestToStreamMapping", "_requestResponseMap", "_streamMapping"].map((key) => {
      const value: unknown = Reflect.get(transport, key);
      if (!(value instanceof Map)) throw new Error("Pinned map unavailable");
      return value.size;
    });
  return { transport, cancel, seen, counts, baseline: counts() };
}
async function messages(response: Response): Promise<unknown[]> {
  expect(response.status).toBe(200);
  if (response.headers.get("content-type")?.includes("application/json")) {
    const result: unknown = await response.json();
    return Array.isArray(result) ? result : [result];
  }
  const result: unknown[] = [];
  createParser({ onEvent: ({ data }) => result.push(JSON.parse(data)) }).feed(
    await response.text(),
  );
  return result;
}

for (const json of [false, true]) {
  for (const cancelled of [0, "0", 2] as const) {
    for (const replyFirst of [false, true]) {
      test(`batch cancellation json=${json}, id=${typeof cancelled}:${cancelled}, replyFirst=${replyFirst}`, async () => {
        const f = await fixture(json);
        const ids = [0, "0", 2] as const;
        const kept = ids.filter((id) => id !== cancelled);
        const responses = kept.map((id) => ({ jsonrpc: "2.0" as const, id, result: { kept: id } }));
        const pending = f.transport.handleRequest(
          request(ids.map((id) => ({ jsonrpc: "2.0", id, method: "ping" }))),
        );
        try {
          await eventually(() => f.seen.length === 3);
          if (replyFirst) for (const response of responses) await f.transport.send(response);
          f.cancel(cancelled);
          f.cancel(cancelled);
          f.cancel("unknown");
          if (!replyFirst) for (const response of responses) await f.transport.send(response);
          expect(await messages(await pending)).toEqual(responses);
          expect(f.counts()).toEqual(f.baseline);
        } finally {
          for (const id of ids) f.cancel(id);
          await pending;
          await f.transport.close();
        }
      });
    }
  }
  test(`entirely cancelled batches complete without an invented reply, json=${json}`, async () => {
    const f = await fixture(json);
    try {
      for (let round = 0; round < 20; round++) {
        f.seen.length = 0;
        const pending = f.transport.handleRequest(
          request([0, "0"].map((id) => ({ jsonrpc: "2.0", id, method: "ping" }))),
        );
        await eventually(() => f.seen.length === 2);
        f.cancel(0);
        f.cancel("0");
        const response = await pending;
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        expect(await messages(response)).toEqual([]);
        expect(f.counts()).toEqual(f.baseline);
      }
    } finally {
      await f.transport.close();
    }
  });
}

test("unsupported pinned transport capabilities are refused before dispatch", async () => {
  const transport = new WebStandardStreamableHTTPServerTransport();
  Object.defineProperty(transport, "_requestToStreamMapping", { value: undefined });
  expect(() => legacyCancellation(transport)).toThrow("capabilities are unavailable");
});
