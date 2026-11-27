import { afterEach, expect } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GatewayError } from '@mcp-gateway/core/errors';
import type { GatewayErrorCode } from '@mcp-gateway/shared/types';

export type ErrorCode = GatewayErrorCode;

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export interface TempDirLifecycle {
  makeTempDir(customPrefix?: string): Promise<string>;
  cleanupTempDirs(): Promise<void>;
}

export interface GatewayConfigOverrides {
  gateway?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
}

export const DEFAULT_TEST_TOKEN = 'a'.repeat(32);

const assertGatewayError = (
  error: unknown,
  code: ErrorCode,
  messageSubstring?: string | RegExp,
) => {
  expect(error).toBeInstanceOf(GatewayError);
  const gatewayError = error as GatewayError;
  expect(gatewayError.code).toBe(code);
  if (typeof messageSubstring === 'string') {
    expect(gatewayError.message).toContain(messageSubstring);
  } else if (messageSubstring instanceof RegExp) {
    expect(gatewayError.message).toMatch(messageSubstring);
  }
  return gatewayError;
};

export const expectGatewayError = (
  fn: () => unknown,
  code: ErrorCode,
  messageSubstring?: string | RegExp,
) => {
  try {
    fn();
  } catch (error) {
    return assertGatewayError(error, code, messageSubstring);
  }
  throw new Error(`Expected GatewayError(${code}) to be thrown.`);
};

export const expectAsyncGatewayError = async (
  fn: () => Promise<unknown>,
  code: ErrorCode,
  messageSubstring?: string | RegExp,
) => {
  try {
    await fn();
  } catch (error) {
    return assertGatewayError(error, code, messageSubstring);
  }
  throw new Error(`Expected GatewayError(${code}) to be rejected.`);
};

export const registerTempDirLifecycle = (prefix = 'mcp-gateway-test-') => {
  const tempDirs: string[] = [];

  const makeTempDir = async (customPrefix = prefix) => {
    const dir = await mkdtemp(join(tmpdir(), customPrefix));
    tempDirs.push(dir);
    return dir;
  };

  const cleanupTempDirs = async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      await chmod(dir, 0o700).catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  };

  afterEach(cleanupTempDirs);

  return { makeTempDir, cleanupTempDirs };
};

export const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export const flushMicrotasks = async (turns = 2) => {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
};

export const makeGatewayConfig = (overrides: GatewayConfigOverrides = {}) => ({
  gateway: {
    host: '127.0.0.1',
    port: 3333,
    token: DEFAULT_TEST_TOKEN,
    ...overrides.gateway,
  },
  mcpServers: overrides.mcpServers ?? {},
});

export const makeConfigText = (overrides: GatewayConfigOverrides = {}) =>
  JSON.stringify(makeGatewayConfig(overrides));
