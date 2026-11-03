export interface WorkerFailure {
  status: "failed" | "unavailable" | "no-update";
  reason: "identity" | "channel" | "feed" | "check" | "download" | "version" | "result";
}

export interface WorkerSelected {
  status: "available" | "ready";
  selected: {
    version: string;
    hash: string;
  };
  channelRoot: string;
}

export type WorkerResult = WorkerSelected | WorkerFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWorkerResult(value: unknown): value is WorkerResult {
  if (!isRecord(value)) return false;
  if (value.status === "available" || value.status === "ready") {
    const selected = value.selected;
    return (
      isRecord(selected) &&
      typeof selected.version === "string" &&
      typeof selected.hash === "string" &&
      typeof value.channelRoot === "string"
    );
  }
  return (
    (value.status === "failed" || value.status === "unavailable" || value.status === "no-update") &&
    typeof value.reason === "string"
  );
}
