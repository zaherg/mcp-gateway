import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export async function httpFixture(
  options: {
    modernDiscovery?: "json" | "sse";
    modernStream?: {
      newline: "\n" | "\r\n" | "\r";
      splitBytes?: boolean;
      fault?: "invalid-json" | "invalid-message" | "unterminated";
      holdOpen?: boolean;
    };
  } = {},
): Promise<{
  url: string;
  token: string;
  receivedAuthorization: string[];
  receivedHeaders: IncomingHttpHeaders[];
  sessionCount(): number;
  activeReplyCount(): number;
  close(): Promise<void>;
}> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const transports = new Set<StreamableHTTPServerTransport>();
  const sockets = new Set<Socket>();
  const replies = new Set<ServerResponse>();
  const token = "synthetic-upstream-only-credential";
  const receivedAuthorization: string[] = [];
  const receivedHeaders: IncomingHttpHeaders[] = [];
  const server = createServer(async (req, res) => {
    receivedAuthorization.push(req.headers.authorization ?? "");
    receivedHeaders.push(req.headers);
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const id = req.headers["mcp-session-id"];
    let transport = typeof id === "string" ? sessions.get(id) : undefined;
    let body: unknown;
    if (req.method === "POST") {
      if (req.headers["content-type"] !== "application/json") {
        req.resume();
        res.writeHead(415).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      body = JSON.parse(Buffer.concat(chunks).toString());
    }
    if (options.modernDiscovery && req.headers["mcp-protocol-version"] === "2026-07-28") {
      const message = body as {
        id: string | number;
        method: string;
        params?: { arguments?: { value?: string } };
      };
      let result: unknown;
      if (message.method === "server/discover") result = { supportedVersions: ["2026-07-28"] };
      else if (message.method === "tools/list")
        result = {
          tools: [{ name: "echo", inputSchema: { type: "object", additionalProperties: true } }],
        };
      else if (message.method === "tools/call")
        result = { content: [{ type: "text", text: message.params?.arguments?.value }] };
      else {
        res.writeHead(400).end();
        return;
      }
      const reply = { jsonrpc: "2.0", id: message.id, result };
      if (message.method === "server/discover" && options.modernDiscovery === "sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `id: priming\ndata\n\ndata:\n\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"synthetic discovery notice"}}\n\n${JSON.stringify(
            reply,
            null,
            2,
          )
            .split("\n")
            .map((line) => `data: ${line}`)
            .join("\n")}\n\n`,
        );
      } else if (message.method !== "server/discover" && options.modernStream) {
        const { newline, splitBytes, holdOpen } = options.modernStream;
        const fault = message.method === "tools/call" ? options.modernStream.fault : undefined;
        const payload =
          fault === "invalid-json"
            ? "{synthetic-private-stream-value"
            : JSON.stringify(
                fault === "invalid-message" ? { private: "synthetic-private-stream-value" } : reply,
                null,
                2,
              );
        const frame = `\uFEFF: keepalive${newline}id: priming${newline}data${newline}${newline}data:${newline}${newline}${payload
          .split("\n")
          .map((line) => `data: ${line}`)
          .join(newline)}${newline}${fault === "unterminated" ? "" : newline}`;
        replies.add(res);
        res.once("close", () => replies.delete(res));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const bytes = Buffer.from(frame);
        if (splitBytes) {
          for (const byte of bytes) {
            if (res.destroyed) return;
            res.write(Buffer.from([byte]));
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
        } else res.write(bytes);
        if (!holdOpen) res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply));
      }
      return;
    }
    if (!transport && !id && req.method === "POST") {
      let count = 0;
      const sessionMarker = randomUUID();
      const mcp = new Server(
        { name: "synthetic-upstream", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "echo", inputSchema: { type: "object", additionalProperties: true } }],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              value: request.params.arguments?.value,
              count: ++count,
              sessionMarker,
            }),
          },
        ],
      }));
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          if (transport) sessions.set(sessionId, transport);
        },
      });
      transports.add(transport);
      await mcp.connect(transport);
      const current = transport;
      const closed = transport.onclose;
      transport.onclose = () => {
        if (current.sessionId) sessions.delete(current.sessionId);
        transports.delete(current);
        closed?.();
      };
    }
    if (!transport) {
      res.writeHead(404).end();
      return;
    }
    await transport.handleRequest(req, res, body);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    receivedAuthorization,
    receivedHeaders,
    sessionCount: () => sessions.size,
    activeReplyCount: () => replies.size,
    close: async () => {
      await Promise.all([...transports].map((transport) => transport.close()));
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
