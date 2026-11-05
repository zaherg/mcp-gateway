import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { inspectExactHelper } from "../../../src/main/updater/process-inspector";
import { inspectRegisteredGroup } from "../../../src/main/updater/registered-group";
import { readNativeJsonSync } from "../../../src/main/updater/storage";
import { readLease } from "../../../src/main/updater/transaction";

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export async function waitForFixtureHelper(
  helper: string,
  plan: string,
  launchSettled: () => Promise<boolean>,
  timeout = 45_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const inspection = await inspectExactHelper(helper, plan);
    if (inspection.status === "unknown")
      throw new Error("Native helper identity is uncertain; retained fixture state.");
    if (inspection.status === "absent" && (await absent(plan)) && (await launchSettled())) return;
    await Bun.sleep(100);
  }
  throw new Error("Native helper or launch did not settle; retained fixture state.");
}

/** Called after the initial parent group stops, before inspecting/stopping its replacement. */
export async function settleProductHandoff(
  roots: {
    home: string;
    tmp: string;
    appBundlePath: string;
  },
  launchSettled: () => Promise<boolean>,
): Promise<string> {
  const channel = join(roots.home, "Library/Application Support/dev.srvr.mcpgateway/stable");
  const journal = await readLease(channel);
  if (!journal) return "no-active-journal";
  if (journal.app_bundle_path !== roots.appBundlePath) throw new Error("Foreign fixture journal.");
  if (
    journal.registered_group &&
    (await inspectRegisteredGroup(journal.registered_group)).status !== "absent"
  )
    throw new Error("Fixture preparation worker remains active or uncertain.");
  if (!journal.binding) {
    if (journal.phase === "arming" || journal.phase === "handed-off")
      throw new Error("Unbound native handoff requires retained-state inspection.");
    return "unarmed-parent-stopped";
  }
  const binding = journal.binding;
  const helper = join(await realpath(roots.tmp), `electrobun-update-${binding.transactionId}`);
  const plan = join(channel, `.electrobun-update-${binding.transactionId}.json`);
  const result = join(channel, `.electrobun-update-${binding.transactionId}.result.json`);
  if (
    binding.helperPath !== helper ||
    binding.resultPath !== result ||
    (binding.evidence === "observed-plan" &&
      (binding.planPath !== plan || binding.plan.appBundlePath !== roots.appBundlePath))
  )
    throw new Error("Native binding escaped the private fixture.");
  await waitForFixtureHelper(helper, plan, async () => {
    if (await absent(result)) return false;
    const value = readNativeJsonSync(result);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("transaction_id" in value) ||
      value.transaction_id !== binding.transactionId ||
      !("success" in value) ||
      typeof value.success !== "boolean"
    )
      throw new Error("Native fixture result does not match its binding.");
    return launchSettled();
  });
  return "bound-helper-and-launch-settled";
}
