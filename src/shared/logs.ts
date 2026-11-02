export const LOG_LIMITS = Object.freeze({
  entries: 500,
  bytes: 4 * 1024 * 1024,
  entryBytes: 32 * 1024,
  batchEntries: 50,
  batchBytes: 256 * 1024,
  requestTimeoutMs: 10_000,
  queryTextCharacters: 512,
});
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export interface LogEntry {
  id: number;
  time: string;
  server: string | null;
  level: LogLevel;
  source: "logger" | "stderr" | "controller";
  text: string;
  truncated: boolean;
}
export interface LogQuery {
  after: number;
  level?: LogLevel;
  server?: string;
  text?: string;
}
export interface LogPage {
  entries: LogEntry[];
  cursor: number;
  generation: number;
  gap: boolean;
  hasMore: boolean;
}
