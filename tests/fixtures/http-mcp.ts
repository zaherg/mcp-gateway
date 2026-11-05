import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export async function httpFixture(
  options: {
    modernDiscovery?: "json" | "sse";
    modernStream?: {
      newline: "\n" | "\r\n" | "\r";
      splitBytes?: boolean;
      fault?:
        | "invalid-json"
        | "invalid-message"
        | "unterminated"
        | "invalid-utf8"
        | "invalid-utf8-continuation"
        | "truncated-utf8";
      holdOpen?: boolean;
    };
  } = {},
): Promise<{
  url: string;
  token: string;
  receivedAuthorization: string[];
  receivedHeaders: IncomingHttpHeaders[];
  activeReplyCount(): number;
  close(): Promise<void>;
}> {
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
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    if (req.headers["content-type"] !== "application/json") {
      req.resume();
      res.writeHead(415).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    // Only the 2026-07-28 protocol is served; session clients are refused like
    // the gateway refuses them.
    if (req.headers["mcp-protocol-version"] !== "2026-07-28") {
      res.writeHead(400).end();
      return;
    }
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
      let bytes = Buffer.from(frame);
      let splitFrom = 0;
      if (
        fault === "invalid-utf8" ||
        fault === "invalid-utf8-continuation" ||
        fault === "truncated-utf8"
      ) {
        const textField = Buffer.from('"text": "');
        const fieldOffset = bytes.indexOf(textField);
        if (fieldOffset < 0) throw new Error("UTF-8 fault fixture requires a text result");
        const textOffset = fieldOffset + textField.length;
        // Split the malformed code units without delaying the valid frame prefix.
        splitFrom = textOffset;
        const invalid = Buffer.from(
          fault === "invalid-utf8"
            ? [0xff]
            : fault === "invalid-utf8-continuation"
              ? [0xe2, 0x28, 0xa1]
              : [0xe2, 0x82],
        );
        bytes = Buffer.concat([
          bytes.subarray(0, textOffset),
          invalid,
          fault === "truncated-utf8" ? Buffer.alloc(0) : bytes.subarray(textOffset),
        ]);
      }
      if (splitBytes) {
        if (splitFrom > 0) res.write(bytes.subarray(0, splitFrom));
        for (const byte of bytes.subarray(splitFrom)) {
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
    activeReplyCount: () => replies.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
