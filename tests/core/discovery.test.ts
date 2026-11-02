import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { UpstreamDiscovery } from "../../src/core/discovery";
import { configFor, eventually, setup, TOKEN } from "./helpers";

const supported = JSON.stringify({ result: { supportedVersions: ["2026-07-28"], label: "🦊" } });
const multiline = JSON.stringify(JSON.parse(supported), null, 2)
  .split("\n")
  .map((line) => `data: ${line}`)
  .join("\n");
const atByteCap = `:${" ".repeat(65_536 - Buffer.byteLength(supported) - 10)}\ndata: ${supported}\n\n`;
const accepted = [
  { name: "JSON", contentType: "application/json", body: supported },
  { name: "single-line SSE", contentType: "text/event-stream", body: `data: ${supported}\n\n` },
  { name: "multiline SSE", contentType: "text/event-stream", body: `${multiline}\n\n` },
  {
    name: "SSE after bare-data priming event",
    contentType: "text/event-stream",
    body: `id: priming\ndata\n\ndata: ${supported}\n\n`,
  },
  {
    name: "SSE after empty-data keepalive event",
    contentType: "text/event-stream",
    body: `data:\n\ndata: ${supported}\n\n`,
  },
  {
    name: "CRLF SSE with comments and split network chunks",
    contentType: "text/event-stream",
    body: `: keepalive\r\n\r\nevent: message\r\nid: discovery\r\n${multiline.replaceAll("\n", "\r\n: comment\r\n")}\r\n\r\n`,
    chunked: true,
  },
  {
    name: "CR-only SSE",
    contentType: "text/event-stream",
    body: `${multiline.replaceAll("\n", "\r")}\r\r`,
  },
  {
    name: "SSE with BOM and no space after data colon",
    contentType: "text/event-stream",
    body: `\uFEFFdata:${supported}\n\n`,
  },
  {
    name: "SSE exactly at the byte cap",
    contentType: "text/event-stream",
    body: atByteCap,
  },
];
for (const { name, contentType, body, chunked } of accepted) {
  test(`discovery accepts ${name}, coalesces probes, caches results and closes`, async () => {
    let calls = 0;
    let authorized = false;
    const upstream = createServer(async (req, res) => {
      req.resume();
      calls++;
      authorized = req.headers.authorization === "Bearer synthetic-discovery-token";
      res.writeHead(200, { "Content-Type": contentType });
      if (chunked) {
        for (const byte of Buffer.from(body)) {
          if (res.destroyed) return;
          res.write(Uint8Array.of(byte));
          await Bun.sleep(1);
        }
        res.end();
      } else res.end(body);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No upstream address");
    const probe = new UpstreamDiscovery({
      type: "streamableHttp",
      url: new URL(`http://127.0.0.1:${address.port}/mcp`),
      headers: { Authorization: "Bearer synthetic-discovery-token" },
    });
    try {
      expect(await Promise.all([probe.speaks(), probe.speaks()])).toEqual([true, true]);
      expect(await probe.speaks()).toBe(true);
      expect(calls).toBe(1);
      expect(authorized).toBe(true);
      await probe.close();
      expect(await probe.speaks()).toBe(false);
      expect(calls).toBe(1);
    } finally {
      await probe.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
}

for (const { name, contentType, body, status = 200 } of [
  { name: "malformed JSON", contentType: "application/json", body: "{" },
  {
    name: "unsupported version",
    contentType: "application/json",
    body: '{"result":{"supportedVersions":["2025-03-26"]}}',
  },
  {
    name: "invalid versions",
    contentType: "application/json",
    body: '{"result":{"supportedVersions":"2026-07-28"}}',
  },
  { name: "oversized JSON", contentType: "application/json", body: "x".repeat(65_537) },
  { name: "truncated SSE event", contentType: "text/event-stream", body: `data: ${supported}\n` },
  { name: "malformed SSE JSON", contentType: "text/event-stream", body: "data: {\n\n" },
  {
    name: "JSON split across separate SSE events",
    contentType: "text/event-stream",
    body: 'data: {"result":\n\ndata: {"supportedVersions":["2026-07-28"]}}\n\n',
  },
  { name: "SSE comments without data", contentType: "text/event-stream", body: ": keepalive\n\n" },
  {
    name: "SSE empty events only",
    contentType: "text/event-stream",
    body: "id: priming\ndata\n\ndata:\n\n",
  },
  { name: "oversized SSE", contentType: "text/event-stream", body: `${atByteCap} ` },
  { name: "failed HTTP status", contentType: "application/json", body: supported, status: 503 },
]) {
  test(`discovery rejects ${name}`, async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      res.writeHead(status, { "Content-Type": contentType });
      res.end(body);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No upstream address");
    const probe = new UpstreamDiscovery({
      type: "streamableHttp",
      url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    });
    try {
      expect(await probe.speaks()).toBe(false);
    } finally {
      await probe.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
}

for (const streaming of [false, true]) {
  test(`endpoint stop cancels pending discovery (streaming=${streaming}) and never starts a late backend`, async () => {
    let discoveries = 0;
    let finished = false;
    let otherRequests = 0;
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.method === "server/discover") {
        discoveries++;
        if (streaming) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${supported}\n`);
        }
        res.on("close", () => {
          finished = true;
        });
        return;
      }
      otherRequests++;
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No upstream address");
    const context = await setup(
      await configFor({ remote: { url: `http://127.0.0.1:${address.port}/mcp` } }),
    );
    try {
      const { address: gateway } = await context.controller.start();
      const request = fetch(`${gateway}/mcp/remote`, {
        method: "POST",
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "Mcp-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }).then(
        async (response) => {
          await response.text();
        },
        () => {},
      );
      await eventually(() => discoveries === 1);
      await context.controller.stop();
      await eventually(() => finished, 1_000);
      await request;
      expect(otherRequests).toBe(0);
      expect(context.controller.snapshot().running).toBe(false);
    } finally {
      await context.cleanup();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  }, 20_000);
}

test("discovery times out an unfinished SSE body and closes its reader", async () => {
  let closed = false;
  const upstream = createServer((req, res) => {
    req.resume();
    res.on("close", () => {
      closed = true;
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${supported}\n`);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No upstream address");
  const probe = new UpstreamDiscovery({
    type: "streamableHttp",
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
  });
  try {
    expect(await probe.speaks()).toBe(false);
    await eventually(() => closed);
  } finally {
    await probe.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}, 15_000);
