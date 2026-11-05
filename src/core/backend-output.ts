import type { Readable } from "node:stream";

export const MAX_BACKEND_MESSAGE_BYTES = 4 * 1024 * 1024;

export class BackendOutputLimitError extends Error {
  constructor() {
    super("Backend message exceeds the 4 MiB limit.");
    this.name = "BackendOutputLimitError";
  }
}

/** Bound raw line storage before decoding or invoking either pinned JSON parser. */
export function readBackendLines(
  stdout: Readable,
  deliver: (line: string) => void,
  fail: (error: Error) => void,
  output: () => Promise<void> | undefined,
): void {
  let buffer = Buffer.alloc(0);
  let length = 0;
  let failed = false;
  const data = (chunk: Buffer) => {
    if (failed) return;
    try {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        const size = length + end - start;
        if (size > MAX_BACKEND_MESSAGE_BYTES) throw new BackendOutputLimitError();
        if (size > buffer.length) {
          const grown = Buffer.alloc(
            Math.min(MAX_BACKEND_MESSAGE_BYTES, Math.max(size, buffer.length * 2, 16 * 1024)),
          );
          buffer.copy(grown, 0, 0, length);
          buffer = grown;
        }
        chunk.copy(buffer, length, start, end);
        length = size;
        if (newline < 0) break;
        const text = buffer.subarray(0, length).toString("utf8");
        length = 0;
        deliver(text.endsWith("\r") ? text.slice(0, -1) : text);
        start = newline + 1;
      }
      const held = output();
      if (held && !stdout.isPaused()) {
        stdout.pause();
        void held.then(() => {
          if (!failed) stdout.resume();
        }, stop);
      }
    } catch (error) {
      stop(error);
    }
  };
  const stop = (error: unknown) => {
    if (failed) return;
    failed = true;
    stdout.off("data", data);
    stdout.pause();
    buffer = Buffer.alloc(0);
    length = 0;
    fail(error instanceof Error ? error : new Error("Backend output failed."));
  };
  stdout.on("data", data);
  stdout.once("close", () => {
    buffer = Buffer.alloc(0);
  });
}

/** SSE fields share one event budget; CR/LF framing does not count toward it. */
export class BackendEventBudget {
  private bytes = 0;
  private lineBytes = 0;
  private afterCR = false;

  push(chunk: Uint8Array): void {
    for (const byte of chunk) {
      if (this.afterCR && byte === 10) {
        this.afterCR = false;
        continue;
      }
      this.afterCR = byte === 13;
      if (byte === 10 || byte === 13) {
        if (this.lineBytes === 0) this.bytes = 0;
        this.lineBytes = 0;
      } else {
        this.lineBytes++;
        if (++this.bytes > MAX_BACKEND_MESSAGE_BYTES) throw new BackendOutputLimitError();
      }
    }
  }
}

/** Guard decoded HTTP body bytes before the SDK can collect JSON or SSE fields. */
export function boundedBackendResponse(
  response: Response,
  onLimit?: (error: BackendOutputLimitError) => void,
): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  // The legacy SDK collects unsuccessful responses with text(), even when labeled SSE.
  const events = response.ok && type === "text/event-stream" ? new BackendEventBudget() : undefined;
  let bytes = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (cancelled) return;
          if (next.done) {
            reader.releaseLock();
            controller.close();
            return;
          }
          if (events) events.push(next.value);
          else {
            bytes += next.value.byteLength;
            if (bytes > MAX_BACKEND_MESSAGE_BYTES) throw new BackendOutputLimitError();
          }
          controller.enqueue(next.value);
        } catch (error) {
          let reported = error;
          try {
            await reader.cancel(error);
          } catch (cleanup) {
            reported = new AggregateError([error, cleanup], "Backend response cleanup failed.");
          } finally {
            reader.releaseLock();
          }
          if (!cancelled) {
            controller.error(reported);
            if (error instanceof BackendOutputLimitError) onLimit?.(error);
          }
        }
      },
      async cancel(reason) {
        cancelled = true;
        try {
          await reader.cancel(reason);
        } finally {
          reader.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperties(bounded, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  });
  return bounded;
}
