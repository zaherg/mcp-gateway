import { createParser } from "eventsource-parser";
import type { Upstream } from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
import { getVersion } from "supergateway/dist/lib/getVersion.js";
import { MODERN_VERSION, SPEAKS_FOR_MS } from "supergateway/dist/lib/upstreamModernChild.js";

const MAX_DISCOVERY_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 10_000;

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
          id: "supergateway-discover",
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
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_DISCOVERY_BYTES) return false;
          chunks.push(value);
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          reader.releaseLock();
        }
      }
      if (!response.ok) return false;
      const text = Buffer.concat(chunks).toString("utf8");
      let data: string | undefined = text;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        data = undefined;
        const parser = createParser({
          onEvent: (event) => {
            if (event.data) data ??= event.data;
          },
        });
        // Input is complete and bounded; normalize terminal CRs without flushing an unfinished event.
        parser.feed(text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
      }
      const body: unknown = JSON.parse(data ?? "null");
      if (typeof body !== "object" || body === null || !("result" in body)) return false;
      const result = body.result;
      return (
        typeof result === "object" &&
        result !== null &&
        "supportedVersions" in result &&
        Array.isArray(result.supportedVersions) &&
        result.supportedVersions.includes(MODERN_VERSION)
      );
    } catch {
      // Per the pinned discovery contract, failure/unsupported responses select
      // legacy handling. Never publish a remote error, response or credential.
      return false;
    }
  }
}
