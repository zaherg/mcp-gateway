import { mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommandRunner, runCommand } from "../src/core/process";

export interface DmgCleanup {
  ok: boolean;
  mount: string;
  detail: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DMG mount inspection returned invalid data.");
  return value as Record<string, unknown>;
}

/** Own the attach attempt, including a mount that appears after cancellation. */
export async function withDmgMount<T>(
  imagePath: string,
  scratch: string,
  verify: (mount: string) => Promise<T>,
  options: {
    run?: CommandRunner;
    signal?: AbortSignal;
    onCleanup?: (result: DmgCleanup) => void;
  } = {},
): Promise<T> {
  const run = options.run ?? runCommand;
  const image = await realpath(imagePath);
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(scratch, "dmg-verification-"));
  const mount = join(directory, "mount");
  const plist = join(directory, "mounts.plist");
  let mountCreated = false;
  let attachStarted = false;
  let attachConfirmed = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };

  async function mounted(): Promise<boolean> {
    const info = await run("/usr/bin/hdiutil", ["info", "-plist"], 15_000);
    if (info.exitCode !== 0) throw new Error("DMG mount inspection failed.");
    await writeFile(plist, info.stdout, { mode: 0o600 });
    const converted = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], 15_000);
    if (converted.exitCode !== 0) throw new Error("DMG mount inspection conversion failed.");
    const document = object(JSON.parse(converted.stdout));
    if (!Array.isArray(document.images)) throw new Error("DMG mount inspection is incomplete.");
    let matches = 0;
    for (const value of document.images) {
      const entry = object(value);
      if (typeof entry["image-path"] !== "string" || !Array.isArray(entry["system-entities"]))
        throw new Error("DMG image identity is incomplete.");
      for (const value of entry["system-entities"]) {
        const entity = object(value);
        if (entity["mount-point"] === undefined) continue;
        if (typeof entity["mount-point"] !== "string") throw new Error("Invalid DMG mount path.");
        if (entity["mount-point"] !== mount) continue;
        if (entry["image-path"] !== image) throw new Error("Owned DMG mount has a foreign image.");
        matches++;
      }
    }
    if (matches > 1) throw new Error("Owned DMG mount identity is ambiguous.");
    return matches === 1;
  }

  try {
    await mkdir(mount);
    mountCreated = true;
    options.signal?.throwIfAborted();
    attachStarted = true;
    // Do not cancel attach: killing hdiutil does not prove a late mount cannot appear.
    const attached = await run(
      "/usr/bin/hdiutil",
      ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, image],
      60_000,
    );
    attachConfirmed = attached.exitCode === 0;
    if (!attachConfirmed) throw new Error("DMG attach failed.");
    options.signal?.throwIfAborted();
    if (!(await mounted())) throw new Error("DMG attach did not establish the owned mount.");
    const value = await verify(mount);
    options.signal?.throwIfAborted();
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }

  let cleanup: DmgCleanup;
  let cleanupStep = "mount inspection";
  try {
    if (attachStarted && (await mounted())) {
      cleanupStep = "detach";
      const detached = await run("/usr/bin/hdiutil", ["detach", mount], 15_000);
      cleanupStep = "post-detach inspection";
      if (await mounted()) {
        if (detached.exitCode === 0)
          throw new Error("DMG remains mounted after successful detach.");
        // Identity was checked again before escalation; never detach a foreign mount.
        cleanupStep = "force-detach and final inspection";
        const forced = await run("/usr/bin/hdiutil", ["detach", "-force", mount], 15_000);
        if (forced.exitCode !== 0 || (await mounted()))
          throw new Error("Owned DMG detachment failed.");
      }
    }
    cleanupStep = "attach settlement";
    if (attachStarted && !attachConfirmed)
      throw new Error(
        "DMG attach settlement is unconfirmed; retained mount directory for inspection.",
      );
    // Non-recursive removal cannot traverse an unresolved or unexpectedly populated mount.
    cleanupStep = "unmounted directory removal";
    if (mountCreated) await rmdir(mount);
    await rm(plist, { force: true });
    await rmdir(directory);
    cleanup = { ok: true, mount, detail: "Owned mount absent; mount directory removed." };
  } catch (error) {
    cleanup = {
      ok: false,
      mount,
      detail: `DMG cleanup unconfirmed during ${cleanupStep} (${error instanceof Error ? error.name : "unknown error"}); retained directory for inspection.`,
    };
  }
  options.onCleanup?.(cleanup);
  if (!cleanup.ok) throw new Error(cleanup.detail);
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
