import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { MIMEType } from 'node:util';

import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

export const MAX_BACKEND_MESSAGE_BYTES = 4 * 1024 * 1024;

export class BackendOutputLimitError extends Error {
  constructor() {
    super('Backend message exceeds the 4 MiB limit.');
    this.name = 'BackendOutputLimitError';
  }
}

/** Bound raw line storage before decoding or invoking either pinned JSON parser. */
export const readBackendLines = (
  stdout: Readable,
  deliver: (line: string) => void,
  fail: (error: Error) => void,
  output: () => Promise<void> | undefined,
): void => {
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
        const text = buffer.subarray(0, length).toString('utf8');
        length = 0;
        deliver(text.endsWith('\r') ? text.slice(0, -1) : text);
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
    stdout.off('data', data);
    stdout.pause();
    buffer = Buffer.alloc(0);
    length = 0;
    fail(error instanceof Error ? error : new Error('Backend output failed.'));
  };
  stdout.on('data', data);
  stdout.once('close', () => {
    buffer = Buffer.alloc(0);
  });
};

/** SSE fields share one event budget; CR/LF framing does not count toward it. */
class BackendEventBudget {
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
export const boundedBackendResponse = (
  response: Response,
  onLimit?: (error: BackendOutputLimitError) => void,
): Response => {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  // The legacy SDK collects unsuccessful responses with text(), even when labeled SSE.
  const events = response.ok && type === 'text/event-stream' ? new BackendEventBudget() : undefined;
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
            reported = new AggregateError([error, cleanup], 'Backend response cleanup failed.');
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
};
// A shared budget for client requests whose backend work has not ended.
//
// Separate from HTTP request admission and from backend resource ownership: a
// stateless request's call continues after its response stream closes, so its
// slot stays charged until the backend replies or the owned request cleanup
// completes. Neither a disconnect nor a cleanup deadline proves that work has ended.
export const MAX_BACKEND_CALLS = 16;

/** Opaque identity for one request's backend work. */
export type WorkOwner = object;

// Application error codes start at 1001, outside JSON-RPC's and the base spec's
// reserved server-error range (-32000..-32019).
/** Fixed sanitized refusal for a validated transport that already owns the response. */
export const BACKEND_CAPACITY_ERROR = {
  code: 1001,
  message: 'Backend work capacity is exhausted. Retry when outstanding calls finish.',
} as const;

export class BackendCalls {
  private used = 0;
  private readonly owned = new Map<WorkOwner, Map<string | number, true>>();

  constructor(private readonly limit = MAX_BACKEND_CALLS) {}

  /** A fresh ownership identity; never reused after its cleanup. */
  owner(): WorkOwner {
    return Object.freeze({});
  }

  /** Whether this owner already holds a reservation for the exact id. */
  holds(owner: WorkOwner, id: string | number): boolean {
    return this.owned.get(owner)?.has(id) === true;
  }

  /**
   * Charge one in-flight request. A duplicate id is refused rather than
   * charged twice; callers must not dispatch it a second time.
   */
  admit(owner: WorkOwner, id: string | number): boolean {
    let calls = this.owned.get(owner);
    if (calls?.has(id)) return false;
    if (this.used >= this.limit) return false;
    if (!calls) {
      calls = new Map();
      this.owned.set(owner, calls);
    }
    calls.set(id, true);
    this.used++;
    return true;
  }

  /** Release a call this owner was charged for; unknown ids release nothing. */
  settle(owner: WorkOwner, id: string | number): boolean {
    const calls = this.owned.get(owner);
    if (!calls?.delete(id)) return false;
    this.used--;
    if (calls.size === 0) this.owned.delete(owner);
    return true;
  }

  /** Release everything an owner still holds, only after confirmed cleanup. */
  settleOwner(owner: WorkOwner): number {
    const calls = this.owned.get(owner);
    if (!calls) return 0;
    this.owned.delete(owner);
    this.used -= calls.size;
    return calls.size;
  }
}

/**
 * Run `release` only when the owned cleanup fulfilled. A rejected cleanup is
 * unconfirmed and keeps its work charged for a retry.
 */
export const releaseAfterCleanup = async <T>(
  cleanup: Promise<T>,
  release: () => void,
): Promise<T> => {
  const value = await cleanup;
  release();
  return value;
};
// Shared by every endpoint. A reservation lasts until its process group or
// upstream transport has finished cleanup.
export class ResourceAdmission {
  private used = 0;

  constructor(private readonly limit: number) {}

  acquire(): ResourceLease | undefined {
    if (this.used >= this.limit) return undefined;
    this.used++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.used--;
      },
    };
  }
}

export interface ResourceLease {
  release(): void;
}

export class RequestBodyError extends Error {
  constructor(readonly status: 400 | 413 | 415) {
    super('Invalid MCP request body');
  }
}

/** One bounded read. The caller owns the deadline and aborts on response/endpoint closure. */
export const readRequestBody = async (
  request: IncomingMessage,
  limit: number,
  signal: AbortSignal,
): Promise<void> => {
  try {
    const mime = new MIMEType(request.headers['content-type'] ?? '');
    if (
      mime.essence !== 'application/json' ||
      (mime.params.get('charset') ?? 'utf-8').toLowerCase() !== 'utf-8'
    )
      throw new Error('Unsupported media type');
  } catch {
    throw new RequestBodyError(415);
  }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      signal.removeEventListener('abort', aborted);
      request.off('data', data);
      request.off('end', end);
      request.off('error', failed);
      request.off('close', aborted);
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
    signal.addEventListener('abort', aborted, { once: true });
    request.on('data', data);
    request.once('end', end);
    request.once('error', failed);
    request.once('close', aborted);
  });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
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
};
