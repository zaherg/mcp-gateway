import { appendFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ViewportPolicy } from "../src/shared/rpc";

export interface FixtureRoots {
  home: string;
  tmp: string;
  dataDirectory: string;
  configPath: string;
  appBundlePath: string;
}
export interface StartupMarker extends FixtureRoots {
  schemaVersion: 1;
  phase: "initialized";
  version: string;
  hash: string;
  pid: number;
  rpc: ViewportPolicy;
  transaction: { status: "confirmed"; version: string; hash: string } | null;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid update acceptance record.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0"))
    throw new Error("Invalid update acceptance text.");
  return value;
}
function pid(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 1)
    throw new Error("Missing synthetic process identity.");
  return value;
}
function viewport(value: unknown): ViewportPolicy {
  const rpc = object(value);
  if (rpc.supported !== true || rpc.documentOverscroll !== "none" || rpc.bodyOverscroll !== "none")
    throw new Error("Completed startup requires a functional renderer viewportPolicy RPC.");
  return {
    supported: true,
    documentOverscroll: "none",
    bodyOverscroll: "none",
    bodyBackground: text(rpc.bodyBackground),
  };
}
function marker(value: unknown): StartupMarker {
  const entry = object(value);
  if (entry.schemaVersion !== 1 || entry.phase !== "initialized")
    throw new Error("Startup did not complete initialization.");
  const roots = {
    home: text(entry.home),
    tmp: text(entry.tmp),
    dataDirectory: text(entry.dataDirectory),
    configPath: text(entry.configPath),
    appBundlePath: text(entry.appBundlePath),
  };
  if (!Object.values(roots).every(isAbsolute)) throw new Error("Startup roots must be absolute.");
  let transaction: StartupMarker["transaction"] = null;
  if (entry.transaction !== null) {
    const result = object(entry.transaction);
    if (result.status !== "confirmed") throw new Error("Startup transaction is not confirmed.");
    transaction = { status: "confirmed", version: text(result.version), hash: text(result.hash) };
  }
  return {
    schemaVersion: 1,
    phase: "initialized",
    ...roots,
    version: text(entry.version),
    hash: text(entry.hash),
    pid: pid(entry.pid),
    rpc: viewport(entry.rpc),
    transaction,
  };
}

export function parseStartupMarkers(source: string): StartupMarker[] {
  if (!source.endsWith("\n") || source.length > 32_768)
    throw new Error("Startup evidence is missing, truncated, or oversized.");
  return source
    .slice(0, -1)
    .split("\n")
    .map((line) => marker(JSON.parse(line)));
}

/** Private fixture only: observation never writes inside the signed application. */
export async function recordCompletedStartup(
  path: string,
  identity: unknown,
  probe: () => Promise<unknown>,
): Promise<void> {
  const rpc = await probe();
  const record = marker({ ...object(identity), schemaVersion: 1, phase: "initialized", rpc });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function replaceOnce(source: string, anchor: string, replacement: string): string {
  const index = source.indexOf(anchor);
  if (!anchor || index < 0 || source.indexOf(anchor, index + anchor.length) >= 0)
    throw new Error("Private fixture patch anchor is missing or ambiguous.");
  return source.slice(0, index) + replacement + source.slice(index + anchor.length);
}

export interface PreHandoffObservation {
  schemaVersion: 1;
  attemptId: number;
  authoritativeAttemptId: number;
  version: string;
  hash: string;
  syntheticPid: number;
  backendAlive: boolean;
}

/** Observe once, without waiting for or terminating the backend. */
export async function recordPreHandoff(
  path: string,
  observation: Omit<PreHandoffObservation, "schemaVersion" | "backendAlive">,
): Promise<void> {
  pid(observation.syntheticPid);
  let backendAlive = true;
  try {
    process.kill(observation.syntheticPid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH")
      throw new Error("Backend absence is uncertain before handoff.");
    backendAlive = false;
  }
  const record: PreHandoffObservation = { schemaVersion: 1, ...observation, backendAlive };
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  if (backendAlive) throw new Error("Synthetic backend is still alive before handoff.");
}

export function assertUpdateAcceptance(input: {
  startupText: string;
  preHandoffText: string;
  initial: { version: string; hash: string };
  target: { version: string; hash: string };
  roots: FixtureRoots;
  trigger: unknown;
  oldProcessExit: number;
  oldChildAlive: boolean;
  configByteIdentical: boolean;
}): [StartupMarker, StartupMarker] {
  const startups = parseStartupMarkers(input.startupText);
  const [initialStartup, targetStartup] = startups;
  if (
    !initialStartup ||
    !targetStartup ||
    startups.length !== 2 ||
    initialStartup.pid === targetStartup.pid
  )
    throw new Error("Expected exactly one completed initial and target startup.");
  for (const [index, identity] of [input.initial, input.target].entries()) {
    const entry = startups[index];
    if (
      !entry ||
      entry.version !== identity.version ||
      entry.hash !== identity.hash ||
      Object.entries(input.roots).some(([key, value]) => entry[key as keyof FixtureRoots] !== value)
    )
      throw new Error("Startup identity or isolated roots do not match.");
  }
  const transaction = startups[1]?.transaction;
  if (
    transaction?.status !== "confirmed" ||
    transaction.version !== input.target.version ||
    transaction.hash !== input.target.hash
  )
    throw new Error("Target startup did not confirm the exact native transaction.");
  const trigger = object(input.trigger);
  const syntheticPid = pid(trigger.syntheticPid);
  if (!input.preHandoffText.endsWith("\n") || input.preHandoffText.length > 4096)
    throw new Error("Missing pre-handoff evidence.");
  const observations = input.preHandoffText.trimEnd().split("\n");
  if (observations.length !== 1) throw new Error("Expected exactly one pre-handoff observation.");
  const observation = object(JSON.parse(observations[0] ?? ""));
  if (
    observation.schemaVersion !== 1 ||
    typeof observation.attemptId !== "number" ||
    !Number.isSafeInteger(observation.attemptId) ||
    observation.attemptId < 1 ||
    observation.authoritativeAttemptId !== observation.attemptId ||
    observation.syntheticPid !== syntheticPid ||
    observation.version !== input.target.version ||
    observation.hash !== input.target.hash ||
    observation.backendAlive !== false
  )
    throw new Error("Backend exit before the exact update handoff was not proven.");
  const reply = object(trigger.mcpReply);
  if (!Array.isArray(reply.content) || reply.content.length !== 1 || reply.isError === true)
    throw new Error("Synthetic MCP result is invalid.");
  const content = object(reply.content[0]);
  const payload = object(JSON.parse(text(content.text)));
  if (
    trigger.phase !== "triggered" ||
    trigger.rendererResult !== "clicked" ||
    content.type !== "text" ||
    payload.value !== "synthetic-update-activity" ||
    payload.pid !== syntheticPid ||
    input.oldProcessExit !== 0 ||
    input.oldChildAlive ||
    !input.configByteIdentical
  )
    throw new Error("Update trigger, old-process cleanup, or configuration preservation failed.");
  return [initialStartup, targetStartup];
}
