import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { createParser } from "eventsource-parser";
import type { Upstream } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
import { getVersion } from "supergateway/dist/lib/getVersion.js";
import { MODERN_VERSION, SPEAKS_FOR_MS } from "supergateway/dist/lib/upstreamModernChild.js";

const MAX_DISCOVERY_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_ID = "supergateway-discover";

function discoveryResult(data: string): boolean | undefined {
  const message = JSONRPCMessageSchema.parse(JSON.parse(data));
  if (!("id" in message) || "method" in message || message.id !== DISCOVERY_ID) return undefined;
  if (!("result" in message)) return false;
  const versions = message.result.supportedVersions;
  return (
    Array.isArray(versions) &&
    versions.every((version) => typeof version === "string") &&
    versions.includes(MODERN_VERSION)
  );
}

/** Pinned Supergateway capability check with explicit cancellation and bounded input.
 * Its original remoteSpeaksModern helper provides neither a signal nor a close hook.
 */
export class UpstreamDiscovery {
  private readonly lifetime = new AbortController();
  private last: { at: number; result: Promise<boolean> } | undefined;

  constructor(private readonly upstream: Upstream) {}

  readonly speaks = (): Promise<boolean> => {
    if (this.lifetime.signal.aborted) return Promise.resolve(false);
    if (this.last && Date.now() - this.last.at < SPEAKS_FOR_MS) return this.last.result;
    const result = this.discover();
    this.last = { at: Date.now(), result };
    return result;
  };

  async close(): Promise<void> {
    this.lifetime.abort();
    await this.last?.result;
  }

  private async discover(): Promise<boolean> {
    try {
      const response = await fetch(this.upstream.url, {
        method: "POST",
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)]),
        headers: {
          ...this.upstream.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN_VERSION,
          "mcp-method": "server/discover",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: DISCOVERY_ID,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
              "io.modelcontextprotocol/clientInfo": { name: "supergateway", version: getVersion() },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      if (!response.body) return false;
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let result: boolean | undefined;
      const parser = response.headers.get("content-type")?.includes("text/event-stream")
        ? createParser({
            onEvent: ({ data }) => {
              if (data && result === undefined) result = discoveryResult(data);
            },
          })
        : undefined;
      let afterCR = false;
      const feed = (text: string) => {
        if (!text) return;
        const normalized = afterCR && text.startsWith("\n") ? text.slice(1) : text;
        afterCR = text.endsWith("\r");
        parser?.feed(normalized.replace(/\r\n?/g, "\n"));
      };
      let length = 0;
      try {
        if (!response.ok) return false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_DISCOVERY_BYTES) return false;
          if (parser) {
            feed(decoder.decode(value, { stream: true }));
            if (result !== undefined) return result;
          } else chunks.push(value);
        }
        if (!parser) return discoveryResult(decoder.decode(Buffer.concat(chunks))) ?? false;
        // Finish UTF-8 decoding, but never dispatch an incomplete SSE frame.
        feed(decoder.decode());
        return result ?? false;
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
    } catch {
      // Per the pinned discovery contract, failure/unsupported responses select
      // legacy handling. Never publish a remote error, response or credential.
      return false;
    }
  }
}
