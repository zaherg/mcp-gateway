import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureParent } from '@mcp-gateway/core/config';

export interface WindowSize {
  width: number;
  height: number;
}

// The layout is designed for this size; it is also the smallest size allowed.
export const MIN_WINDOW_SIZE: WindowSize = { width: 1120, height: 820 };

const SIZE_FILE = 'window.json';
const SAVE_DELAY_MS = 500;
// Guards against a corrupted file requesting an absurd window.
const MAX_DIMENSION = 20_000;

const isDimension = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= minimum &&
  value <= MAX_DIMENSION;

const parseSize = (text: string): WindowSize | undefined => {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return;
  const { schema_version, width, height } = document as Record<string, unknown>;
  if (schema_version !== 1) return;
  if (!isDimension(width, MIN_WINDOW_SIZE.width) || !isDimension(height, MIN_WINDOW_SIZE.height))
    return;
  return { width, height };
};

/**
 * Persists the window size across launches. The size is a convenience, so an
 * unreadable or invalid file falls back to the default size and a failed save is
 * reported without affecting the window.
 */
export class WindowSizeStore {
  private pending: WindowSize | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private latest: WindowSize | undefined,
  ) {}

  static async open(dataDirectory: string): Promise<WindowSizeStore> {
    const path = join(dataDirectory, SIZE_FILE);
    let saved: WindowSize | undefined;
    try {
      saved = parseSize(await readFile(path, 'utf8'));
      if (!saved) console.error('Saved window size is invalid; using the default size.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.error('Saved window size could not be read; using the default size.');
    }
    return new WindowSizeStore(path, saved);
  }

  /** The most recent size: this session's last resize, else the saved one. */
  get current(): WindowSize | undefined {
    return this.latest;
  }

  /** Records the latest size; the file is written once resizing settles. */
  schedule(size: WindowSize): void {
    if (!isDimension(size.width, 1) || !isDimension(size.height, 1)) return;
    this.pending = { width: Math.round(size.width), height: Math.round(size.height) };
    this.latest = this.pending;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  /** Writes any pending size now and waits for in-flight writes. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const size = this.pending;
    this.pending = undefined;
    if (size) this.writing = this.writing.then(() => this.write(size));
    await this.writing;
  }

  private async write(size: WindowSize): Promise<void> {
    const clamped = {
      width: Math.max(size.width, MIN_WINDOW_SIZE.width),
      height: Math.max(size.height, MIN_WINDOW_SIZE.height),
    };
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await ensureParent(this.path);
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ schema_version: 1, ...clamped }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      console.error(
        `Window size could not be saved: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
