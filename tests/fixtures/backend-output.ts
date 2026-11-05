import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

export interface OutputOptions {
  format: "json" | "sse" | "line";
  bytes: number;
  chunkBytes?: number;
  unfinished?: boolean;
  prefixEvents?: number;
  status?: number;
  newline?: "\n" | "\r\n" | "\r";
}

export function outputBytes(id: unknown, options: OutputOptions): Buffer {
  const prefix = options.format === "sse" ? "data: " : "";
  const reply = (text: string) =>
    JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
  const marker = "synthetic-private-output-";
  const padding = options.bytes - Buffer.byteLength(prefix + reply(marker));
  if (padding < 0 || padding > 8 * 1024 * 1024) throw new Error("Invalid fixture output size");
  const ending = options.unfinished
    ? ""
    : options.format === "json"
      ? ""
      : options.format === "sse"
        ? (options.newline ?? "\n").repeat(2)
        : "\n";
  return Buffer.from(prefix + reply(marker + "x".repeat(padding)) + ending);
}

async function streamOutput(output: Writable, bytes: Buffer, chunkBytes: number): Promise<void> {
  for (let offset = 0; offset < bytes.length && !output.destroyed; offset += chunkBytes) {
    await new Promise<void>((resolve, reject) => {
      output.write(bytes.subarray(offset, offset + chunkBytes), (error) =>
        error ? reject(error) : resolve(),
      );
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function outputServer(options: OutputOptions) {
  const token = "synthetic-output-upstream-token";
  const sockets = new Set<Socket>();
  const replies = new Set<ServerResponse>();
  const authorization: string[] = [];
  let deletes = 0;
  const server = createServer((req, res) => {
    void (async () => {
      authorization.push(req.headers.authorization ?? "");
      if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401).end();
      if (req.method === "GET") return void res.writeHead(405).end();
      if (req.method === "DELETE") {
        deletes++;
        return void res.writeHead(200).end();
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = JSON.parse(Buffer.concat(chunks).toString());
      if (request.id === undefined) return void res.writeHead(202).end();
      if (request.method === "tools/call") {
        replies.add(res);
        res.once("close", () => replies.delete(res));
        res.writeHead(options.status ?? 200, {
          "Content-Type": options.format === "sse" ? "text/event-stream" : "application/json",
        });
        for (let event = 0; event < (options.prefixEvents ?? 0); event++) {
          await streamOutput(
            res,
            Buffer.from(`: ${"x".repeat(2 * 1024 * 1024)}\n\n`),
            options.chunkBytes ?? 8192,
          );
        }
        await streamOutput(res, outputBytes(request.id, options), options.chunkBytes ?? 8192);
        if (!options.unfinished) res.end();
        return;
      }
      const result =
        request.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic-output", version: "1" },
            }
          : request.method === "tools/list"
            ? {
                tools: [
                  { name: "large", inputSchema: { type: "object", additionalProperties: true } },
                ],
              }
            : { supportedVersions: ["2026-07-28"] };
      res
        .writeHead(200, {
          "Content-Type": "application/json",
          ...(request.method === "initialize" ? { "Mcp-Session-Id": randomUUID() } : {}),
        })
        .end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    })().catch((error) => {
      if (!res.destroyed) res.destroy(error);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    authorization,
    active: () => replies.size,
    deletes: () => deletes,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

if (import.meta.main) {
  if (process.env.PID_FILE) appendFileSync(process.env.PID_FILE, `${process.pid}\n`);
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === "tools/call") {
      const options: OutputOptions = JSON.parse(process.env.OUTPUT_OPTIONS ?? "{}");
      void streamOutput(
        process.stdout,
        outputBytes(message.id, options),
        options.chunkBytes ?? 8192,
      ).catch((error) => {
        if (error.code !== "EPIPE") throw error;
      });
      return;
    }
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic-output", version: "1" },
          }
        : {
            tools: [{ name: "large", inputSchema: { type: "object", additionalProperties: true } }],
          };
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
  });
  input.on("close", () => process.exit(0));
}
