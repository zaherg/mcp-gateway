import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, type Readable } from 'node:stream';
import { text as collectStreamText } from 'node:stream/consumers';

import {
  BackendCalls,
  BackendOutputLimitError,
  boundedBackendResponse,
  MAX_BACKEND_CALLS,
  MAX_BACKEND_MESSAGE_BYTES,
  MAX_SSE_EVENT_BYTES,
  RequestBodyError,
  ResourceAdmission,
  readBackendLines,
  readRequestBody,
  releaseAfterCleanup,
  writeJsonRpcError,
} from '@mcp-gateway/core/limits';
import { BackendProcesses, childEnvironment, createCommandRunner } from '@mcp-gateway/core/process';
import { deferred } from '../helpers/core';

const createTestLogger = () => ({
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
});

const readFirstLine = (stream: Readable): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline >= 0) {
        stream.off('data', onData);
        resolve(buffered.slice(0, newline));
      }
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });

const isProcessGone = (targetPid: number) => {
  try {
    process.kill(targetPid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
};

const forceKill = (targetPid: number) => {
  try {
    process.kill(targetPid, 'SIGKILL');
  } catch {
    // Ignore ESRCH / already-reaped processes during test teardown.
  }
};

interface MockResponseState {
  res: ServerResponse;
  headers: Map<string, string>;
  ended: boolean;
  body: Buffer | undefined;
}

const createMockResponse = (options?: { headersSent?: boolean; destroyed?: boolean }) => {
  const headers = new Map<string, string>();
  const state: MockResponseState = {
    res: null as unknown as ServerResponse,
    headers,
    ended: false,
    body: undefined,
  };
  const mock = {
    headersSent: options?.headersSent ?? false,
    destroyed: options?.destroyed ?? false,
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end(payload?: Buffer) {
      state.ended = true;
      state.body = payload;
    },
  };
  state.res = mock as unknown as ServerResponse;
  return state;
};

const createMockRequest = (
  contentType: string | undefined,
  chunks: readonly (Buffer | string)[],
) => {
  const stream = new PassThrough();
  const req = Object.assign(stream, {
    headers: contentType === undefined ? {} : { 'content-type': contentType },
  }) as unknown as IncomingMessage & { body?: unknown };
  queueMicrotask(() => {
    for (const chunk of chunks) {
      stream.write(chunk);
    }
    stream.end();
  });
  return req;
};

const streamFromChunks = (chunks: readonly Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

const expectRequestBodyErrorStatus = async (
  promise: Promise<unknown>,
  expectedStatus: 400 | 413 | 415,
) => {
  try {
    await promise;
    throw new Error(`Expected RequestBodyError(${expectedStatus}) but resolved`);
  } catch (error) {
    expect(error).toBeInstanceOf(RequestBodyError);
    expect((error as RequestBodyError).status).toBe(expectedStatus);
  }
};

describe('src/core/process.ts — environment isolation', () => {
  test('childEnvironment filters parentEnv, overlays serverEnv, strips blocked keys, and never mutates inputs', () => {
    const parentEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/Users/tester',
      LC_ALL: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/Users/tester/.config',
      AWS_SECRET_ACCESS_KEY: 'super-secret',
      GITHUB_TOKEN: 'ghp_secret',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      NODE_OPTIONS: '--inspect',
      TERM: undefined,
    };
    const serverEnv = {
      PATH: '/custom/bin:/usr/bin',
      CUSTOM_API_URL: 'https://example.internal',
      NODE_OPTIONS: '--max-old-space-size=4096',
      bun_options: '--smol',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      ld_preload: '/tmp/evil.so',
    };

    const parentSnapshot = { ...parentEnv };
    const serverSnapshot = { ...serverEnv };
    const processEnvSnapshot = { ...process.env };

    const result = childEnvironment(serverEnv, parentEnv);

    expect(result).toEqual({
      PATH: '/custom/bin:/usr/bin',
      HOME: '/Users/tester',
      LC_ALL: 'en_US.UTF-8',
      XDG_CONFIG_HOME: '/Users/tester/.config',
      CUSTOM_API_URL: 'https://example.internal',
    });
    expect(parentEnv).toEqual(parentSnapshot);
    expect(serverEnv).toEqual(serverSnapshot);

    const fromDefaultParent = childEnvironment({
      TEST_ISOLATION_ONLY_KEY: 'present',
      DYLD_LIBRARY_PATH: '/bad',
    });
    expect(fromDefaultParent.TEST_ISOLATION_ONLY_KEY).toBe('present');
    expect(fromDefaultParent.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(process.env.TEST_ISOLATION_ONLY_KEY).toBeUndefined();
    expect(process.env).toEqual(processEnvSnapshot);
  });
});

describe('src/core/process.ts — createCommandRunner', () => {
  test('throws Invalid command limit on non-positive or non-integer limits', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createCommandRunner({ defaultTimeoutMs: bad })).toThrow('Invalid command limit');
      expect(() => createCommandRunner({ maxOutputBytes: bad })).toThrow('Invalid command limit');
    }
  });

  test('rejects with Invalid command deadline on invalid per-call timeoutMs', async () => {
    const run = createCommandRunner();
    for (const bad of [0, -10, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(run('/bin/echo', ['ok'], bad)).rejects.toThrow('Invalid command deadline');
    }
  });

  test('captures stdout, stderr, exitCode, passes custom env, and rejects on ENOENT', async () => {
    const run = createCommandRunner();

    const echoed = await run('/bin/echo', ['hello', 'world']);
    expect(echoed).toEqual({
      stdout: 'hello world\n',
      stderr: '',
      exitCode: 0,
    });

    const scripted = await run(process.execPath, [
      '-e',
      "process.stdout.write('out-text'); process.stderr.write('err-text'); process.exit(7);",
    ]);
    expect(scripted).toEqual({
      stdout: 'out-text',
      stderr: 'err-text',
      exitCode: 7,
    });

    const customEnvRun = createCommandRunner({
      defaultTimeoutMs: 5_000,
      env: { CUSTOM_VAR: 'expected-val', PATH: process.env.PATH },
    });
    const envResult = await customEnvRun(process.execPath, [
      '-e',
      "process.stdout.write(process.env.CUSTOM_VAR ?? '');",
    ]);
    expect(envResult).toEqual({
      stdout: 'expected-val',
      stderr: '',
      exitCode: 0,
    });

    await expect(run('/nonexistent/mcp-gateway-binary-xyz', [])).rejects.toThrow(/ENOENT/);
  });

  test('rejects with Command timed out and kills the child when exceeding timeoutMs', async () => {
    const run = createCommandRunner();
    const startedAt = Date.now();
    await expect(
      run(process.execPath, ['-e', 'setInterval(() => {}, 30_000);'], 100),
    ).rejects.toThrow('Command timed out');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test('rejects with Command cancelled when AbortSignal is pre-aborted or aborts mid-run', async () => {
    const run = createCommandRunner();

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(run('/bin/echo', ['never'], 5_000, preAborted.signal)).rejects.toThrow(
      'Command cancelled',
    );

    const midRun = new AbortController();
    const timer = setTimeout(() => midRun.abort(), 80);
    try {
      await expect(
        run(process.execPath, ['-e', 'setInterval(() => {}, 30_000);'], 10_000, midRun.signal),
      ).rejects.toThrow('Command cancelled');
    } finally {
      clearTimeout(timer);
    }
  });

  test('rejects with Command output exceeded the limit on stdout and stderr overflow', async () => {
    const run = createCommandRunner({ maxOutputBytes: 16 });

    const exact = await run(process.execPath, ['-e', "process.stdout.write('a'.repeat(16));"]);
    expect(exact.stdout).toBe('a'.repeat(16));
    expect(exact.exitCode).toBe(0);

    await expect(
      run(process.execPath, ['-e', "process.stdout.write('a'.repeat(32));"]),
    ).rejects.toThrow('Command output exceeded the limit');

    await expect(
      run(process.execPath, ['-e', "process.stderr.write('b'.repeat(32));"]),
    ).rejects.toThrow('Command output exceeded the limit');
  });
});

describe('src/core/process.ts — BackendProcesses', () => {
  test('track deduplicates concurrent stop calls and close awaits all tracked stops', async () => {
    const processes = new BackendProcesses(createTestLogger());

    let runsA = 0;
    const gateA = deferred();
    const stopA = processes.track(async () => {
      runsA++;
      await gateA.promise;
    });

    let runsB = 0;
    let finishedB = false;
    const gateB = deferred();
    processes.track(async () => {
      runsB++;
      await gateB.promise;
      finishedB = true;
    });

    const concurrent1 = stopA();
    const concurrent2 = stopA();
    expect(runsA).toBe(0);
    await Promise.resolve();
    expect(runsA).toBe(1);

    const closePromise = processes.close();
    expect(processes.closing).toBe(true);
    gateA.resolve();
    gateB.resolve();

    await Promise.all([concurrent1, concurrent2, closePromise]);
    expect(runsA).toBe(1);
    expect(runsB).toBe(1);
    expect(finishedB).toBe(true);
  });

  test('own terminates a detached leader process cleanly with a single SIGTERM', async () => {
    const processes = new BackendProcesses(createTestLogger());

    const script = [
      'let terms = 0;',
      "process.on('SIGTERM', () => {",
      '  terms++;',
      '  if (terms === 1) {',
      '    setTimeout(() => {',
      "      process.stdout.write('terms=' + String(terms) + '\\n');",
      '      process.exit(0);',
      '    }, 15);',
      '  }',
      '});',
      "process.stdout.write('ready\\n');",
      'setInterval(() => {}, 30_000);',
    ].join('\n');

    const child = spawn(process.execPath, ['-e', script], {
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) throw new Error('Expected spawned child PID');

    try {
      const stop = processes.own(child);
      const stdout = child.stdout;
      expect(stdout).not.toBeNull();
      if (!stdout) throw new Error('Expected stdout pipe');

      const ready = await readFirstLine(stdout);
      expect(ready).toBe('ready');

      const restPromise = collectStreamText(stdout);
      await stop();
      const rest = await restPromise;

      expect(rest.trim()).toBe('terms=1');
      expect(isProcessGone(-pid)).toBe(true);
    } finally {
      forceKill(-pid);
    }
  });

  test('own cleans up a background helper in the same process group after the leader exits', async () => {
    const processes = new BackendProcesses(createTestLogger());

    const script = [
      "const { spawn } = require('node:child_process');",
      'setTimeout(() => {',
      "  const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000);'], {",
      "    stdio: 'ignore',",
      '  });',
      '  helper.unref();',
      "  process.stdout.write(String(helper.pid) + '\\n', () => process.exit(0));",
      '}, 15);',
    ].join('\n');

    const leader = spawn(process.execPath, ['-e', script], {
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const leaderPid = leader.pid;
    expect(leaderPid).toBeDefined();
    if (leaderPid === undefined) throw new Error('Expected spawned leader PID');

    let helperPid: number | undefined;
    try {
      const leaderExited = new Promise<void>((resolve) => {
        if (leader.exitCode !== null || leader.signalCode !== null) resolve();
        else leader.once('exit', () => resolve());
      });
      const stop = processes.own(leader);
      const stdout = leader.stdout;
      expect(stdout).not.toBeNull();
      if (!stdout) throw new Error('Expected leader stdout pipe');

      const line = await readFirstLine(stdout);
      helperPid = Number(line.trim());
      expect(Number.isSafeInteger(helperPid) && helperPid > 0).toBe(true);

      await leaderExited;
      expect(leader.exitCode).toBe(0);

      await stop();

      expect(isProcessGone(helperPid)).toBe(true);
      expect(isProcessGone(-leaderPid)).toBe(true);
    } finally {
      forceKill(-leaderPid);
      if (helperPid !== undefined) forceKill(helperPid);
    }
  });
});

describe('src/core/limits.ts — writeJsonRpcError', () => {
  test('writes JSON-RPC error with exact UTF-8 Content-Length, Content-Type, status, and id', () => {
    const mock = createMockResponse();
    writeJsonRpcError(mock.res, 429, { code: 1001, message: 'Busy — retry' }, 'req-42');

    expect(mock.res.statusCode).toBe(429);
    expect(mock.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(mock.ended).toBe(true);
    expect(mock.body).toBeInstanceOf(Buffer);

    const expectedJson = JSON.stringify({
      jsonrpc: '2.0',
      id: 'req-42',
      error: { code: 1001, message: 'Busy — retry' },
    });
    const expectedBytes = Buffer.byteLength(expectedJson, 'utf8');
    expect(mock.headers.get('Content-Length')).toBe(String(expectedBytes));
    expect(mock.body?.toString('utf8')).toBe(expectedJson);

    const defaultIdMock = createMockResponse();
    writeJsonRpcError(defaultIdMock.res, 400, { code: -32600, message: 'Bad request' });
    expect(JSON.parse(defaultIdMock.body?.toString('utf8') ?? '')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Bad request' },
    });
  });

  test('is a no-op when res.headersSent or res.destroyed is true', () => {
    const sent = createMockResponse({ headersSent: true });
    writeJsonRpcError(sent.res, 500, { code: -32603, message: 'Error' }, 1);
    expect(sent.ended).toBe(false);
    expect(sent.headers.size).toBe(0);
    expect(sent.res.statusCode).toBe(200);

    const destroyed = createMockResponse({ destroyed: true });
    writeJsonRpcError(destroyed.res, 503, { code: -32603, message: 'Error' }, 2);
    expect(destroyed.ended).toBe(false);
    expect(destroyed.headers.size).toBe(0);
    expect(destroyed.res.statusCode).toBe(200);
  });
});

describe('src/core/limits.ts — readBackendLines', () => {
  test('reassembles lines split across chunks and strips trailing CR on CRLF lines', () => {
    const stdout = new PassThrough();
    const lines: string[] = [];
    const failures: Error[] = [];

    readBackendLines(
      stdout,
      (line) => lines.push(line),
      (error) => failures.push(error),
      () => undefined,
    );

    stdout.write(Buffer.from('{"a":'));
    stdout.write(Buffer.from('1}\r\n{"b":2}\npart1'));
    stdout.write(Buffer.from('part2\r'));
    stdout.write(Buffer.from('\n'));
    stdout.end();

    expect(failures).toEqual([]);
    expect(lines).toEqual(['{"a":1}', '{"b":2}', 'part1part2']);
  });

  test('pauses stdout when output() returns an unsettled promise, resumes once resolved, and stops via fail() on rejection', async () => {
    const stdout = new PassThrough();
    const lines: string[] = [];
    const failures: Error[] = [];
    let releaseOutput: (() => void) | undefined;
    let holdNext = true;

    readBackendLines(
      stdout,
      (line) => lines.push(line),
      (error) => failures.push(error),
      () => {
        if (!holdNext) return undefined;
        holdNext = false;
        return new Promise<void>((resolve) => {
          releaseOutput = resolve;
        });
      },
    );

    stdout.write('first\n');
    expect(lines).toEqual(['first']);
    expect(stdout.isPaused()).toBe(true);
    expect(releaseOutput).toBeDefined();

    stdout.write('second\n');
    expect(lines).toEqual(['first']);

    releaseOutput?.();
    await Bun.sleep(0);

    expect(stdout.isPaused()).toBe(false);
    expect(lines).toEqual(['first', 'second']);
    expect(failures).toEqual([]);
    stdout.end();

    // When output() rejects, readBackendLines stops reading and calls fail(error).
    const rejectStream = new PassThrough();
    const rejectLines: string[] = [];
    const rejectFailures: Error[] = [];
    readBackendLines(
      rejectStream,
      (line) => rejectLines.push(line),
      (error) => rejectFailures.push(error),
      () => Promise.reject(new Error('downstream write failed')),
    );
    rejectStream.write('trigger\n');
    await Promise.resolve();
    expect(rejectLines).toEqual(['trigger']);
    expect(rejectFailures).toHaveLength(1);
    expect(rejectFailures[0]?.message).toBe('downstream write failed');
    expect(rejectStream.isPaused()).toBe(true);

    rejectStream.write('after-failure\n');
    expect(rejectLines).toEqual(['trigger']);
    expect(rejectFailures).toHaveLength(1);
  });

  test('fails with BackendOutputLimitError and stops reading when a line exceeds 4 MiB', () => {
    const atLimitStream = new PassThrough();
    const atLimitLines: string[] = [];
    const atLimitFailures: Error[] = [];
    readBackendLines(
      atLimitStream,
      (line) => atLimitLines.push(line),
      (error) => atLimitFailures.push(error),
      () => undefined,
    );
    atLimitStream.write(Buffer.alloc(MAX_BACKEND_MESSAGE_BYTES, 0x61));
    atLimitStream.write('\n');
    atLimitStream.end();
    expect(atLimitFailures).toEqual([]);
    expect(atLimitLines).toHaveLength(1);
    expect(atLimitLines[0]?.length).toBe(MAX_BACKEND_MESSAGE_BYTES);

    const overflowStream = new PassThrough();
    const overflowLines: string[] = [];
    const overflowFailures: Error[] = [];
    readBackendLines(
      overflowStream,
      (line) => overflowLines.push(line),
      (error) => overflowFailures.push(error),
      () => undefined,
    );

    overflowStream.write(Buffer.alloc(MAX_BACKEND_MESSAGE_BYTES, 0x61));
    expect(overflowFailures).toEqual([]);

    overflowStream.write(Buffer.from('x'));
    expect(overflowFailures).toHaveLength(1);
    expect(overflowFailures[0]).toBeInstanceOf(BackendOutputLimitError);
    expect(overflowFailures[0]?.message).toBe('Backend message exceeds the 4 MiB limit.');
    expect(overflowStream.isPaused()).toBe(true);

    // Further writes must not deliver lines or fire fail again.
    overflowStream.write('should-not-deliver\n');
    overflowStream.end();
    expect(overflowLines).toEqual([]);
    expect(overflowFailures).toHaveLength(1);
  });
});

describe('src/core/limits.ts — boundedBackendResponse', () => {
  test('returns null-body responses untouched, passes JSON up to 4 MiB, and errors + calls onLimit above 4 MiB', async () => {
    const noContent = new Response(null, { status: 204 });
    expect(boundedBackendResponse(noContent)).toBe(noContent);

    const exactPayload = new Uint8Array(MAX_BACKEND_MESSAGE_BYTES).fill(0x78);
    const exactOnLimit: BackendOutputLimitError[] = [];
    const exactResponse = boundedBackendResponse(
      new Response(streamFromChunks([exactPayload]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      (error) => exactOnLimit.push(error),
    );
    const exactBytes = new Uint8Array(await exactResponse.arrayBuffer());
    expect(exactBytes.byteLength).toBe(MAX_BACKEND_MESSAGE_BYTES);
    expect(exactOnLimit).toEqual([]);

    const oversizedOnLimit: BackendOutputLimitError[] = [];
    const oversizedResponse = boundedBackendResponse(
      new Response(streamFromChunks([exactPayload, new Uint8Array([0x79])]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      (error) => oversizedOnLimit.push(error),
    );
    await expect(oversizedResponse.arrayBuffer()).rejects.toBeInstanceOf(BackendOutputLimitError);
    expect(oversizedOnLimit).toHaveLength(1);
    expect(oversizedOnLimit[0]).toBeInstanceOf(BackendOutputLimitError);
  });

  test('applies per-event BackendEventBudget to 200 OK text/event-stream responses and total cap to non-200 SSE', async () => {
    const encoder = new TextEncoder();
    const threeMiB = 'a'.repeat(3 * 1024 * 1024);

    // LF blank-line separator: total stream > 6 MiB, each event < 4 MiB -> succeeds.
    const lfLimits: BackendOutputLimitError[] = [];
    const lfResponse = boundedBackendResponse(
      new Response(
        streamFromChunks([
          encoder.encode(`data: ${threeMiB}\n\n`),
          encoder.encode(`data: ${threeMiB}\n\n`),
        ]),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        },
      ),
      (error) => lfLimits.push(error),
    );
    const lfText = await lfResponse.text();
    expect(lfText.length).toBeGreaterThan(MAX_SSE_EVENT_BYTES);
    expect(lfLimits).toEqual([]);

    // CRLF blank-line separator split across chunks: also resets event budget.
    const crlfLimits: BackendOutputLimitError[] = [];
    const crlfResponse = boundedBackendResponse(
      new Response(
        streamFromChunks([
          encoder.encode(`data: ${threeMiB}\r`),
          encoder.encode('\n\r\n'),
          encoder.encode(`data: ${threeMiB}\r\n\r\n`),
        ]),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
      (error) => crlfLimits.push(error),
    );
    const crlfText = await crlfResponse.text();
    expect(crlfText.length).toBeGreaterThan(MAX_SSE_EVENT_BYTES);
    expect(crlfLimits).toEqual([]);

    // Single SSE event exceeding 4 MiB fails with BackendOutputLimitError.
    const singleOverflowLimits: BackendOutputLimitError[] = [];
    const singleOverflowResponse = boundedBackendResponse(
      new Response(
        streamFromChunks([
          encoder.encode(`data: ${threeMiB}\n`),
          encoder.encode(`data: ${'b'.repeat(2 * 1024 * 1024)}\n\n`),
        ]),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
      (error) => singleOverflowLimits.push(error),
    );
    await expect(singleOverflowResponse.text()).rejects.toBeInstanceOf(BackendOutputLimitError);
    expect(singleOverflowLimits).toHaveLength(1);

    // Non-200 response with text/event-stream uses total MAX_BACKEND_MESSAGE_BYTES cap (no event resets).
    const nonOkSseLimits: BackendOutputLimitError[] = [];
    const nonOkSseResponse = boundedBackendResponse(
      new Response(
        streamFromChunks([
          encoder.encode(`data: ${threeMiB}\n\n`),
          encoder.encode(`data: ${threeMiB}\n\n`),
        ]),
        {
          status: 500,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
      (error) => nonOkSseLimits.push(error),
    );
    await expect(nonOkSseResponse.text()).rejects.toBeInstanceOf(BackendOutputLimitError);
    expect(nonOkSseLimits).toHaveLength(1);
  });

  test('forwards body.cancel() reason and wraps reader.cancel() failure on limit overflow into AggregateError', async () => {
    let cancelReason: unknown;
    const cancellableStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel(reason) {
        cancelReason = reason;
      },
    });
    const boundedCancel = boundedBackendResponse(new Response(cancellableStream, { status: 200 }));
    await boundedCancel.body?.cancel('user-cancelled');
    expect(cancelReason).toBe('user-cancelled');

    const failCancelStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_BACKEND_MESSAGE_BYTES + 1));
      },
      cancel() {
        throw new Error('cancel cleanup boom');
      },
    });
    const limitTriggered: BackendOutputLimitError[] = [];
    const boundedCleanupErr = boundedBackendResponse(
      new Response(failCancelStream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      (error) => limitTriggered.push(error),
    );
    let caught: unknown;
    try {
      await boundedCleanupErr.arrayBuffer();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const agg = caught as AggregateError;
    expect(agg.message).toBe('Backend response cleanup failed.');
    expect(agg.errors[0]).toBeInstanceOf(BackendOutputLimitError);
    expect((agg.errors[1] as Error).message).toBe('cancel cleanup boom');
    expect(limitTriggered).toHaveLength(1);
  });
});

describe('src/core/limits.ts — BackendCalls, releaseAfterCleanup, and ResourceAdmission', () => {
  test('BackendCalls tracks per-owner reservations, blocks duplicates and overflow, and settles cleanly', () => {
    expect(MAX_BACKEND_CALLS).toBe(16);
    const calls = new BackendCalls(3);
    const ownerA = calls.owner();
    const ownerB = calls.owner();
    expect(ownerA).not.toBe(ownerB);

    expect(calls.admit(ownerA, 'req-1')).toBe(true);
    expect(calls.holds(ownerA, 'req-1')).toBe(true);
    // Duplicate id on the same owner is refused and does not consume capacity.
    expect(calls.admit(ownerA, 'req-1')).toBe(false);

    // Same id on a different owner is permitted.
    expect(calls.admit(ownerB, 'req-1')).toBe(true);
    expect(calls.admit(ownerA, 2)).toBe(true);

    // Capacity is now 3/3; further admits fail until settled.
    expect(calls.admit(ownerB, 'req-2')).toBe(false);

    // Settle individual call.
    expect(calls.settle(ownerA, 'unknown')).toBe(false);
    expect(calls.settle(ownerA, 'req-1')).toBe(true);
    expect(calls.settle(ownerA, 'req-1')).toBe(false);
    expect(calls.holds(ownerA, 'req-1')).toBe(false);

    // Freed slot can now be admitted.
    expect(calls.admit(ownerB, 'req-2')).toBe(true);
    expect(calls.admit(ownerA, 3)).toBe(false);

    // settleOwner releases all remaining calls for ownerB only.
    expect(calls.settleOwner(ownerB)).toBe(2);
    expect(calls.settleOwner(ownerB)).toBe(0);
    expect(calls.holds(ownerB, 'req-1')).toBe(false);
    expect(calls.holds(ownerA, 2)).toBe(true);

    // Two slots are now free again.
    expect(calls.admit(ownerA, 3)).toBe(true);
    expect(calls.admit(ownerA, 4)).toBe(true);
    expect(calls.admit(ownerA, 5)).toBe(false);
    expect(calls.settleOwner(ownerA)).toBe(3);
  });

  test('releaseAfterCleanup runs release only when cleanup resolves and keeps capacity charged on rejection', async () => {
    const admission = new ResourceAdmission(1);
    const lease = admission.acquire();
    expect(lease).toBeDefined();

    let released = 0;
    const failure = new Error('cleanup failed');
    await expect(
      releaseAfterCleanup(Promise.reject(failure), () => {
        released++;
        lease?.release();
      }),
    ).rejects.toThrow('cleanup failed');
    expect(released).toBe(0);
    expect(admission.acquire()).toBeUndefined();

    const value = await releaseAfterCleanup(Promise.resolve('done'), () => {
      released++;
      lease?.release();
    });
    expect(value).toBe('done');
    expect(released).toBe(1);

    const nextLease = admission.acquire();
    expect(nextLease).toBeDefined();
    nextLease?.release();
  });

  test('ResourceAdmission enforces limit and makes lease.release() idempotent', () => {
    const admission = new ResourceAdmission(2);
    const first = admission.acquire();
    const second = admission.acquire();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(admission.acquire()).toBeUndefined();

    // Repeated releases on the same lease must only free a single slot.
    first?.release();
    first?.release();
    first?.release();

    const third = admission.acquire();
    expect(third).toBeDefined();
    expect(admission.acquire()).toBeUndefined();

    second?.release();
    third?.release();
    const fourth = admission.acquire();
    const fifth = admission.acquire();
    expect(fourth).toBeDefined();
    expect(fifth).toBeDefined();
    fourth?.release();
    fifth?.release();
  });
});

describe('src/core/limits.ts — readRequestBody', () => {
  test('rejects non-application/json or non-UTF-8 Content-Type with RequestBodyError(415)', async () => {
    const signal = new AbortController().signal;
    const validPayload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });

    for (const contentType of [
      undefined,
      '',
      'text/plain',
      'text/event-stream',
      'application/json; charset=latin1',
      'application/json; charset=utf-16',
    ]) {
      const req = createMockRequest(contentType, [validPayload]);
      await expectRequestBodyErrorStatus(readRequestBody(req, 1024, signal), 415);
    }
  });

  test('rejects payloads exceeding limit bytes with RequestBodyError(413)', async () => {
    const signal = new AbortController().signal;
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const byteLength = Buffer.byteLength(payload, 'utf8');

    const exactReq = createMockRequest('application/json', [payload]);
    await readRequestBody(exactReq, byteLength, signal);
    expect(exactReq.body).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });

    const oversizedReq = createMockRequest('application/json', [payload]);
    await expectRequestBodyErrorStatus(readRequestBody(oversizedReq, byteLength - 1, signal), 413);
  });

  test('rejects invalid UTF-8, malformed JSON, empty array, and invalid JSON-RPC objects with RequestBodyError(400)', async () => {
    const signal = new AbortController().signal;

    const invalidUtf8 = createMockRequest('application/json', [Buffer.from([0x7b, 0xff, 0x7d])]);
    await expectRequestBodyErrorStatus(readRequestBody(invalidUtf8, 1024, signal), 400);

    const malformedJson = createMockRequest('application/json', ['{"jsonrpc":']);
    await expectRequestBodyErrorStatus(readRequestBody(malformedJson, 1024, signal), 400);

    const emptyBatch = createMockRequest('application/json', ['[]']);
    await expectRequestBodyErrorStatus(readRequestBody(emptyBatch, 1024, signal), 400);

    const invalidSchema = createMockRequest('application/json', [JSON.stringify({ hello: 'mcp' })]);
    await expectRequestBodyErrorStatus(readRequestBody(invalidSchema, 1024, signal), 400);

    const mixedBatch = createMockRequest('application/json', [
      JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { invalid: true }]),
    ]);
    await expectRequestBodyErrorStatus(readRequestBody(mixedBatch, 1024, signal), 400);
  });

  test('rejects pre-aborted signal, mid-stream abort, premature stream close, and forwards stream errors', async () => {
    // Pre-aborted signal before entry
    const preAborted = new AbortController();
    preAborted.abort();
    const preAbortedReq = createMockRequest('application/json', ['{}']);
    await expectRequestBodyErrorStatus(
      readRequestBody(preAbortedReq, 1024, preAborted.signal),
      400,
    );

    // Mid-stream abort
    const midAbort = new AbortController();
    const midStream = new PassThrough();
    const midReq = Object.assign(midStream, {
      headers: { 'content-type': 'application/json' },
    }) as unknown as IncomingMessage;
    const midPromise = readRequestBody(midReq, 1024, midAbort.signal);
    midStream.write('{"jsonrpc":');
    midAbort.abort();
    await expectRequestBodyErrorStatus(midPromise, 400);

    // Stream emits 'close' before 'end'
    const closeStream = new PassThrough();
    const closeReq = Object.assign(closeStream, {
      headers: { 'content-type': 'application/json' },
    }) as unknown as IncomingMessage;
    const closePromise = readRequestBody(closeReq, 1024, new AbortController().signal);
    closeStream.write('{"jsonrpc":');
    closeStream.destroy();
    await expectRequestBodyErrorStatus(closePromise, 400);

    // Stream emits 'error'
    const errorStream = new PassThrough();
    const errorReq = Object.assign(errorStream, {
      headers: { 'content-type': 'application/json' },
    }) as unknown as IncomingMessage;
    const errorPromise = readRequestBody(errorReq, 1024, new AbortController().signal);
    errorStream.emit('error', new Error('socket reset'));
    await expect(errorPromise).rejects.toThrow('socket reset');
  });

  test('assigns parsed single message and batch array to req.body', async () => {
    const signal = new AbortController().signal;

    const singleMessage = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const singleJson = JSON.stringify(singleMessage);
    const singleReq = createMockRequest('application/json; charset=UTF-8', [
      singleJson.slice(0, 12),
      singleJson.slice(12),
    ]);
    await readRequestBody(singleReq, 1024, signal);
    expect(singleReq.body).toEqual(singleMessage);

    const batchMessages = [
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ];
    const batchReq = createMockRequest('application/json', [JSON.stringify(batchMessages)]);
    await readRequestBody(batchReq, 1024, signal);
    expect(batchReq.body).toEqual(batchMessages);
  });
});
