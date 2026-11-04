import type { IncomingMessage } from "node:http";
import { MIMEType } from "node:util";
import { type JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";

export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413 | 415) {
    super("Invalid MCP request body");
  }
}

const messagesByRequest = new WeakMap<IncomingMessage, readonly JSONRPCMessage[]>();
export const requestMessages = (request: IncomingMessage) => messagesByRequest.get(request);

/** One bounded read. The caller owns the deadline and aborts on response/endpoint closure. */
export async function readRequestBody(
  request: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<readonly JSONRPCMessage[]> {
  try {
    const mime = new MIMEType(request.headers["content-type"] ?? "");
    if (
      mime.essence !== "application/json" ||
      (mime.params.get("charset") ?? "utf-8").toLowerCase() !== "utf-8"
    )
      throw new Error("Unsupported media type");
  } catch {
    throw new RequestBodyError(415);
  }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      signal.removeEventListener("abort", aborted);
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      request.off("close", aborted);
    };
    const failed = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const aborted = () => failed(new RequestBodyError(400));
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > limit) {
        failed(new RequestBodyError(413));
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks, length));
    };
    if (signal.aborted || request.destroyed) {
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
    request.once("close", aborted);
  });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestBodyError(400);
  }
  const items = Array.isArray(body) ? body : [body];
  if (!items.length) throw new RequestBodyError(400);
  const messages = items.map((item) => {
    const parsed = JSONRPCMessageSchema.safeParse(item);
    if (!parsed.success) throw new RequestBodyError(400);
    return parsed.data;
  });
  // Pinned body-parser 1.x checks _body before reading. Keep its exact checked
  // value and skip only its second byte read, never the transport's validation.
  Object.assign(request, { body: Array.isArray(body) ? messages : messages[0], _body: true });
  messagesByRequest.set(request, messages);
  return messages;
}
