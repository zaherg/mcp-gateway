import { LOG_LIMITS, type LogEntry, type LogLevel } from '@mcp-gateway/shared/types';

export interface LogBufferState {
  readonly entries: readonly LogEntry[];
  readonly cursor: number;
  readonly bufferGeneration: number | null;
  readonly gap: boolean;
}

export interface LogBufferPage {
  readonly entries: readonly LogEntry[];
  readonly cursor: number;
  readonly generation: number;
  readonly gap: boolean;
  readonly hasMore: boolean;
}

export interface LogFilters {
  readonly level: LogLevel | '';
  readonly server: string;
  readonly text: string;
}

export const EMPTY_LOG_BUFFER: LogBufferState = {
  entries: [],
  cursor: 0,
  bufferGeneration: null,
  gap: false,
};

const encoder = new TextEncoder();
const entrySizes = new WeakMap<LogEntry, number>();

const entrySize = (entry: LogEntry): number => {
  let size = entrySizes.get(entry);
  if (size === undefined) {
    size = encoder.encode(JSON.stringify(entry)).byteLength + 1;
    entrySizes.set(entry, size);
  }
  return size;
};

export const applyLogPage = (state: LogBufferState, page: LogBufferPage): LogBufferState => {
  const reset = state.bufferGeneration === null || page.generation !== state.bufferGeneration;
  let gap = state.gap || page.gap;
  let entries = state.entries;

  if (reset || page.entries.length > 0) {
    const all = reset ? [...page.entries] : [...state.entries, ...page.entries];
    let bytes = 2;
    let start = all.length;
    while (start > 0 && all.length - start < LOG_LIMITS.entries) {
      const size = entrySize(all[start - 1]);
      if (bytes + size > LOG_LIMITS.bytes) break;
      bytes += size;
      start--;
    }
    if (start > 0) gap = true;
    entries = all.slice(start);
  }

  return {
    entries,
    cursor: page.cursor,
    bufferGeneration: page.generation,
    gap,
  };
};

export const filterLogEntries = (
  entries: readonly LogEntry[],
  filters: LogFilters,
): readonly LogEntry[] => {
  const needle = filters.text.toLowerCase();
  return entries.filter(
    (entry) =>
      (!filters.level || entry.level === filters.level) &&
      (!filters.server || entry.server === filters.server) &&
      entry.text.toLowerCase().includes(needle),
  );
};

export const availableLogServers = (
  configuredServers: readonly string[],
  entries: readonly LogEntry[],
): readonly string[] =>
  Array.from(
    new Set([
      ...configuredServers,
      ...entries.flatMap((entry) => (entry.server ? [entry.server] : [])),
    ]),
  ).sort();

export const formatLogEntryForCopy = (entry: LogEntry, appSourceLabel: string): string => {
  const source = entry.server ?? appSourceLabel;
  return `${entry.time} [${entry.level.toUpperCase()}] [${source}] ${entry.text}`;
};
