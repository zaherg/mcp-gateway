import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StatefulSession } from "supergateway/dist/gateways/statefulSession.js";

type RequestId = string | number;
function unavailable(): never {
  throw new Error("Pinned legacy cancellation capabilities are unavailable.");
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function map(value: unknown): Map<unknown, unknown> {
  if (!(value instanceof Map)) unavailable();
  return value;
}

/** Supergateway 4.2.1 / SDK 1.30.0: retire a batch member without fabricating a reply. */
export function legacyCancellation(
  transport: StreamableHTTPServerTransport | WebStandardStreamableHTTPServerTransport,
): (requestId: RequestId) => void {
  const outer: unknown = transport;
  if (!object(outer)) unavailable();
  const sdk = outer._webStandardTransport ?? outer;
  if (!object(sdk) || sdk._eventStore !== undefined || typeof sdk._enableJsonResponse !== "boolean")
    unavailable();
  const requests = map(sdk._requestToStreamMapping);
  const replies = map(sdk._requestResponseMap);
  const streams = map(sdk._streamMapping);
  const resumable = sdk._resumableStreams;
  if (!(resumable instanceof Set)) unavailable();
  const joined = new WeakSet<object>();

  return (requestId) => {
    const streamId = requests.get(requestId);
    if (streamId === undefined) return;
    if (typeof streamId !== "string") unavailable();
    // A reply won the race. Its existing response must remain in the batch.
    if (replies.has(requestId)) return;
    const remaining: RequestId[] = [];
    for (const [id, stream] of requests) {
      if (stream !== streamId || id === requestId) continue;
      if (typeof id !== "string" && typeof id !== "number") unavailable();
      remaining.push(id);
    }
    const stream = streams.get(streamId);
    if (stream !== undefined && (!object(stream) || typeof stream.cleanup !== "function"))
      unavailable();
    const ready = remaining.every((id) => replies.has(id));
    const messages = ready
      ? remaining.map((id) => {
          const parsed = JSONRPCMessageSchema.safeParse(replies.get(id));
          if (
            !parsed.success ||
            "method" in parsed.data ||
            !("id" in parsed.data) ||
            parsed.data.id !== id
          )
            unavailable();
          return parsed.data;
        })
      : [];
    if (sdk._enableJsonResponse && stream !== undefined) {
      if (
        !object(stream) ||
        typeof stream.resolveJson !== "function" ||
        typeof stream.cleanup !== "function"
      )
        unavailable();
      if (!joined.has(stream)) {
        const resolve = stream.resolveJson.bind(stream);
        const cleanup = stream.cleanup.bind(stream);
        stream.resolveJson = (response: Response) => {
          resolve(response);
          cleanup();
        };
        joined.add(stream);
      }
    }

    requests.delete(requestId);
    replies.delete(requestId);
    if (!ready) return;
    if (object(stream)) {
      if (sdk._enableJsonResponse && typeof stream.resolveJson === "function") {
        const headers = new Headers();
        if (typeof sdk.sessionId === "string") headers.set("mcp-session-id", sdk.sessionId);
        // Cancellation has no RPC response. Even JSON-mode clients accept SSE,
        // so an empty completed SSE response settles an entirely cancelled POST.
        headers.set("content-type", messages.length ? "application/json" : "text/event-stream");
        stream.resolveJson(
          new Response(
            messages.length ? JSON.stringify(messages.length === 1 ? messages[0] : messages) : "",
            { status: 200, headers },
          ),
        );
      }
      if (typeof stream.cleanup !== "function") unavailable();
      stream.cleanup();
    }
    for (const id of remaining) {
      requests.delete(id);
      replies.delete(id);
    }
    resumable.delete(streamId);
  };
}

export function installLegacyCancellation(
  session: StatefulSession,
): (requestId: RequestId) => void {
  if (typeof session.settle !== "function" || typeof session.endCancelled !== "function")
    unavailable();
  const cancel = legacyCancellation(session.transport);
  // Settlement is authorized only after admitPeer successfully forwards the cancel.
  session.endCancelled = () => {};
  return (id) => {
    cancel(id);
    session.settle(id);
  };
}
