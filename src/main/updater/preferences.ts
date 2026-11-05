import { join } from "node:path";
import { ensureParent, safeParent } from "../../core/private-parent";
import { atomicWritePrivateJson, readPrivateJson } from "./storage";

const FIELDS = ["automaticUpdates", "schema_version"];

export interface UpdatePreferencesState {
  automaticUpdates: boolean;
  status: "default" | "loaded" | "invalid" | "write-failed" | "durability-uncertain";
  error: string | null;
}

export const DEFAULT_UPDATE_PREFERENCES: UpdatePreferencesState = {
  automaticUpdates: true,
  status: "default",
  error: null,
};

function preferencePath(dataDirectory: string): string {
  return join(dataDirectory, "updates.json");
}

function invalid(): UpdatePreferencesState {
  return {
    automaticUpdates: false,
    status: "invalid",
    error: "Update preferences are invalid or unsafe. Background updates are disabled.",
  };
}

function parse(document: unknown): UpdatePreferencesState {
  if (typeof document !== "object" || document === null || Array.isArray(document))
    return invalid();
  const record = document as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== FIELDS.length ||
    !FIELDS.every((field, index) => keys[index] === field) ||
    record.schema_version !== 1 ||
    typeof record.automaticUpdates !== "boolean"
  )
    return invalid();
  return {
    automaticUpdates: record.automaticUpdates,
    status: "loaded",
    error: null,
  };
}

export async function loadUpdatePreferences(
  dataDirectory: string,
): Promise<UpdatePreferencesState> {
  const path = preferencePath(dataDirectory);
  try {
    await safeParent(path, true);
    return parse(await readPrivateJson(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...DEFAULT_UPDATE_PREFERENCES };
    return invalid();
  }
}

export async function saveUpdatePreferences(
  dataDirectory: string,
  automaticUpdates: boolean,
  previous: UpdatePreferencesState,
): Promise<UpdatePreferencesState> {
  let published = false;
  try {
    await ensureParent(preferencePath(dataDirectory));
    await atomicWritePrivateJson(
      preferencePath(dataDirectory),
      { schema_version: 1, automaticUpdates },
      () => {
        published = true;
      },
    );
    return { automaticUpdates, status: "loaded", error: null };
  } catch {
    if (published) {
      const current = await loadUpdatePreferences(dataDirectory);
      if (current.status !== "loaded")
        return {
          ...invalid(),
          error:
            "The update preference was replaced, but its current value could not be verified. Background updates are disabled.",
        };
      return {
        ...current,
        status: "durability-uncertain",
        error:
          "The update preference was changed, but its durability could not be confirmed. The displayed setting is active now; it may not survive a crash.",
      };
    }
    return {
      automaticUpdates: previous.automaticUpdates,
      status: "write-failed",
      error: "The update preference could not be saved. The previous setting remains active.",
    };
  }
}
