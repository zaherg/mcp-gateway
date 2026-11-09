import { LOG_LIMITS, type LogEntry, type LogPage, type LogQuery } from '@mcp-gateway/shared/types';

/** Reads data descriptors only: diagnostic capture must never invoke custom inspection or getters. */
const diagnosticText = (values: readonly unknown[]): string => {
  let remaining = LOG_LIMITS.entryBytes;
  const seen = new Set<object>();
  const take = (text: string): string => {
    const part = text.slice(0, remaining);
    remaining -= part.length;
    return part;
  };
  const format = (value: unknown, depth: number): string => {
    if (remaining <= 0) return '';
    if (typeof value === 'string') return take(value);
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint' ||
      typeof value === 'undefined'
    )
      return take(String(value));
    if (typeof value !== 'object') return take(`[${typeof value}]`);
    if (seen.has(value)) return take('[circular]');
    if (depth >= 8) return take('[depth limit]');
    seen.add(value);
    let output = take('{');
    try {
      // Reflecting a proxy can throw. Never call user-provided toJSON/toString/inspect.
      const keys = Reflect.ownKeys(value);
      for (const key of keys.slice(0, 100)) {
        if (remaining <= 0) break;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor) continue;
        output += take(`${typeof key === 'string' ? key : '[symbol]'}: `);
        output += 'value' in descriptor ? format(descriptor.value, depth + 1) : take('[accessor]');
        output += take(', ');
      }
      if (keys.length > 100) output += take('[property limit]');
    } catch {
      output += take('[unreadable object]');
    }
    return output + take('}');
  };
  let output = '';
  for (const value of values) {
    if (remaining <= 0) break;
    if (output) output += take(' ');
    output += format(value, 0);
  }
  return output;
};

export class LogBuffer {
  private entries: LogEntry[] = [];
  // Serialized size of each retained entry (plus separator), measured once on append.
  private readonly sizes = new WeakMap<LogEntry, number>();
  private bytes = 0;
  private sequence = 0;
  private generation = 0;

  append(
    metadata: Pick<LogEntry, 'server' | 'level' | 'source'>,
    values: readonly unknown[],
  ): void {
    let text = diagnosticText(values);
    const truncated = Buffer.byteLength(text) >= LOG_LIMITS.entryBytes;
    if (truncated) {
      const marker = '\n[entry truncated]';
      text =
        Buffer.from(text)
          .subarray(0, LOG_LIMITS.entryBytes - Buffer.byteLength(marker) - 3)
          .toString('utf8') + marker;
    }
    const entry = {
      ...metadata,
      id: ++this.sequence,
      time: new Date().toISOString(),
      text,
      truncated,
    };
    // Include escaped text and metadata in retention and RPC byte accounting.
    // One proportional pass per check: removing 256 characters at a time would
    // re-serialize the whole entry dozens of times.
    const marker = '\n[entry truncated]';
    let size = Buffer.byteLength(JSON.stringify(entry));
    while (size > LOG_LIMITS.entryBytes) {
      entry.truncated = true;
      const keep = Math.max(
        0,
        Math.floor((entry.text.length * LOG_LIMITS.entryBytes) / size) - 256,
      );
      entry.text = `${entry.text.slice(0, keep)}${marker}`;
      size = Buffer.byteLength(JSON.stringify(entry));
    }
    // The loop above leaves `size` equal to the final entry's serialized length.
    this.entries.push(entry);
    this.sizes.set(entry, size + 1);
    this.bytes += size + 1;
    while (this.entries.length > LOG_LIMITS.entries || this.bytes + 2 > LOG_LIMITS.bytes) {
      const removed = this.entries.shift();
      if (removed) this.bytes -= this.sizes.get(removed) ?? 0;
    }
  }

  clear(): LogPage {
    this.entries = [];
    this.bytes = 0;
    this.generation++;
    return this.read({ after: this.sequence });
  }

  read(query: LogQuery): LogPage {
    const oldest = this.entries[0]?.id ?? this.sequence + 1;
    const gap = query.after < oldest - 1 || query.after > this.sequence;
    let cursor = gap ? oldest - 1 : query.after;
    const entries: LogEntry[] = [];
    // Reserve room for page metadata and entry separators within the response cap.
    let bytes = 512;
    for (const entry of this.entries) {
      if (entry.id <= cursor) continue;
      const size = this.sizes.get(entry) ?? 0;
      if (entries.length >= LOG_LIMITS.batchEntries || bytes + size > LOG_LIMITS.batchBytes) break;
      entries.push({ ...entry });
      bytes += size;
      cursor = entry.id;
    }
    return { entries, cursor, generation: this.generation, gap, hasMore: cursor < this.sequence };
  }
}
