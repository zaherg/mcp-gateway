import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  BackendEventBudget,
  BackendOutputLimitError,
  boundedBackendResponse,
  MAX_BACKEND_MESSAGE_BYTES as LIMIT,
  readBackendLines,
} from "../../src/core/backend-output";

function response(
  chunks: Uint8Array[],
  type: string,
  cancel: (reason: unknown) => void = () => {},
  status = 200,
) {
  let index = 0;
  return new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (index < chunks.length) controller.enqueue(chunks[index++]);
          else controller.close();
        },
        cancel,
      },
      { highWaterMark: 0 },
    ),
    { status, headers: { "Content-Type": type } },
  );
}

for (const newline of ["\n", "\r\n", "\r"]) {
  test(`SSE event budgets reset across split ${JSON.stringify(newline)} but not data or metadata fields`, () => {
    for (const prefix of ["data: ", "id: ", "event: ", ": ", "unknown: "]) {
      const budget = new BackendEventBudget();
      const exact = Buffer.from(prefix + "x".repeat(LIMIT - prefix.length));
      budget.push(exact.subarray(0, 17));
      budget.push(exact.subarray(17));
      expect(() => budget.push(Buffer.from("x"))).toThrow(BackendOutputLimitError);
      const frames = new BackendEventBudget();
      for (let i = 0; i < 3; i++) {
        frames.push(exact);
        for (const byte of Buffer.from(newline.repeat(2))) frames.push(Buffer.from([byte]));
      }
      const multiline = new BackendEventBudget();
      multiline.push(Buffer.from(`id: first${newline}data: `));
      expect(() => multiline.push(Buffer.alloc(LIMIT, 120))).toThrow(BackendOutputLimitError);
    }
  });
}

test("SSE budgets count UTF-8 bytes rather than characters and handle several events in one chunk", () => {
  const budget = new BackendEventBudget();
  expect(() => budget.push(Buffer.from(`${"é".repeat(LIMIT / 2)}é`))).toThrow(
    BackendOutputLimitError,
  );
  const many = Buffer.from(`data: ${"x".repeat(LIMIT / 2)}\n\n`.repeat(3));
  expect(() => new BackendEventBudget().push(many)).not.toThrow();
});

for (const type of ["application/json", "text/plain", "text/event-stream"]) {
  test(`HTTP ${type} refuses chunked overflow and cancels its reader without publishing offending bytes`, async () => {
    let cancelled = 0;
    let refusal: unknown;
    const input = response([Buffer.alloc(LIMIT, 120), Buffer.from("y")], type, (reason) => {
      expect(reason).toBeInstanceOf(BackendOutputLimitError);
      cancelled++;
    });
    const wrapped = boundedBackendResponse(input, (error) => {
      refusal = error;
    });
    if (!wrapped.body) throw new Error("Missing fixture body");
    const reader = wrapped.body.getReader();
    try {
      expect((await reader.read()).value?.byteLength).toBe(LIMIT);
      await expect(reader.read()).rejects.toBeInstanceOf(BackendOutputLimitError);
      expect(cancelled).toBe(1);
      expect(refusal).toBeInstanceOf(BackendOutputLimitError);
      expect(input.body?.locked).toBe(false);
    } finally {
      reader.releaseLock();
    }
  });
}

test("HTTP permits the exact JSON bound regardless of Content-Length and retains response metadata", async () => {
  const input = response([Buffer.alloc(LIMIT - 1, 32), Buffer.from("0")], "application/json");
  input.headers.set("Content-Length", "1");
  Object.defineProperties(input, {
    url: { value: "https://synthetic.invalid/mcp" },
    redirected: { value: true },
  });
  const wrapped = boundedBackendResponse(input);
  expect(await wrapped.json()).toBe(0);
  expect(wrapped.url).toBe(input.url);
  expect(wrapped.redirected).toBe(true);
  expect(wrapped.headers.get("Content-Length")).toBe("1");
  expect(input.body?.locked).toBe(false);
});

test("a content-type parameter cannot select per-event limits for a JSON body", async () => {
  const input = response(
    [Buffer.alloc(LIMIT, 32), Buffer.from("\n\n0")],
    "application/json; note=text/event-stream",
  );
  await expect(boundedBackendResponse(input).json()).rejects.toBeInstanceOf(
    BackendOutputLimitError,
  );
});

test("HTTP error bodies retain a cumulative limit even when labeled as SSE", async () => {
  const event = Buffer.from(`: ${"x".repeat(LIMIT / 2)}\n\n`);
  const input = response([event, event, event], "text/event-stream", () => {}, 500);
  await expect(boundedBackendResponse(input).text()).rejects.toBeInstanceOf(
    BackendOutputLimitError,
  );
});

test("HTTP cancellation propagates while an upstream read is pending", async () => {
  let cancelled: unknown;
  const input = new Response(
    new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = reason;
      },
    }),
  );
  const wrapped = boundedBackendResponse(input);
  if (!wrapped.body) throw new Error("Missing fixture body");
  const reader = wrapped.body.getReader();
  const pending = reader.read();
  const reason = new Error("Synthetic downstream disconnect");
  await reader.cancel(reason);
  expect(await pending).toEqual({ done: true, value: undefined });
  expect(cancelled).toBe(reason);
  expect(input.body?.locked).toBe(false);
  reader.releaseLock();
});

test("HTTP reports cleanup rejection rather than silently discarding it", async () => {
  const cleanup = new Error("Synthetic cancel failure");
  const input = response([Buffer.alloc(LIMIT + 1)], "application/json", () => {
    throw cleanup;
  });
  let failure: unknown;
  try {
    await boundedBackendResponse(input).text();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected cleanup error");
  expect(failure.errors[0]).toBeInstanceOf(BackendOutputLimitError);
  expect(failure.errors[1]).toBe(cleanup);
  expect(input.body?.locked).toBe(false);
});

test("stdout bounds unfinished and complete lines before delivery, preserving valid split UTF-8/CRLF", () => {
  for (const complete of [false, true]) {
    const stream = new PassThrough();
    const lines: string[] = [];
    const errors: Error[] = [];
    readBackendLines(
      stream,
      (line) => lines.push(line),
      (error) => errors.push(error),
      () => undefined,
    );
    try {
      const valid = Buffer.from("é🐻\r\nsecond\n");
      for (const byte of valid) stream.write(Buffer.from([byte]));
      expect(lines).toEqual(["é🐻", "second"]);
      stream.write(Buffer.alloc(LIMIT, 120));
      expect(errors).toHaveLength(0);
      stream.write(Buffer.from(complete ? "x\n" : "x"));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(BackendOutputLimitError);
      expect(lines).toEqual(["é🐻", "second"]);
      expect(stream.isPaused()).toBe(true);
    } finally {
      stream.destroy();
    }
  }
});

test("stdout accepts exact-limit and multiple lines in one chunk", () => {
  const stream = new PassThrough();
  const lengths: number[] = [];
  readBackendLines(
    stream,
    (line) => lengths.push(line.length),
    (error) => {
      throw error;
    },
    () => undefined,
  );
  try {
    stream.write(Buffer.concat([Buffer.alloc(LIMIT, 120), Buffer.from("\nnext\n")]));
    expect(lengths).toEqual([LIMIT, 4]);
  } finally {
    stream.destroy();
  }
});

test("stdout retains backpressure and reports rejected drain promises", async () => {
  const stream = new PassThrough();
  let reject!: (error: Error) => void;
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail;
  });
  const errors: Error[] = [];
  readBackendLines(
    stream,
    () => {},
    (error) => errors.push(error),
    () => held,
  );
  try {
    stream.write(Buffer.from("first\n"));
    expect(stream.isPaused()).toBe(true);
    const error = new Error("Synthetic drain failure");
    reject(error);
    await Promise.resolve();
    expect(errors).toEqual([error]);
    expect(stream.isPaused()).toBe(true);
  } finally {
    stream.destroy();
  }
});
