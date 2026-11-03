import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inventoryBundle } from "../../scripts/release-inventory";
import { loadApplySdk } from "../../src/main/updater/apply";
import type { VerifiedCandidate } from "../../src/main/updater/boundary";
import { PREPARED_UPDATE_FILE, UPDATER_ARTIFACT_FILE } from "../../src/main/updater/constants";
import { atomicWritePrivateJson } from "../../src/main/updater/storage";
import { nativeResultPath, readLease, TransactionLease } from "../../src/main/updater/transaction";
import { readVersionMetadata } from "../../src/main/updater/verify";
import { waitForGrant } from "../../src/main/updater/worker";

const root = process.env.SDK_ADMISSION_ROOT;
const mode = process.env.SDK_ADMISSION_MODE;
if (
  !root ||
  !resolve(root).startsWith(`${resolve(import.meta.dir, "../../.cache")}/`) ||
  !mode ||
  ![
    "observed",
    "no-result",
    "cancelled",
    "metadata-error",
    "same-version",
    "resolver-error",
  ].includes(mode) ||
  process.env.HOME !== join(root, "home") ||
  process.env.TMPDIR !== join(root, "tmp") ||
  process.cwd() !== join(root, "MacOS") ||
  process.env.MCP_GATEWAY_UPDATE_RESULT !== join(root, "worker-result.json")
)
  throw new Error("Invalid isolated SDK admission fixture");
if (!(await waitForGrant(process.env))) process.exit(2);

const current = await readVersionMetadata(join(root, "Resources/version.json"));
const channel = join(root, "home/Library/Application Support", current.identifier, current.channel);
const staging = join(channel, "self-extraction");
const data = join(root, "data");
const app = join(root, "Current.app");
for (const directory of [channel, staging, data, app])
  await mkdir(directory, { recursive: true, mode: 0o700 });
const lease = await TransactionLease.acquire({
  channelRoot: channel,
  dataDirectory: data,
  appBundlePath: app,
});
const targetVersion = mode === "same-version" ? current.version : "0.3.1";
const targetHash = mode === "same-version" ? current.hash : "target123456";
const tarPath = join(staging, `${targetHash}.tar`);
const preparedPath = join(staging, PREPARED_UPDATE_FILE);
const marker = join(channel, ".electrobun-observed-update-result.json");
const transactionId = "11111111111111111111111111111111";
let sdk: Awaited<ReturnType<typeof loadApplySdk>> | undefined;
try {
  const tar = Buffer.from("synthetic prepared bytes; never installed");
  await writeFile(tarPath, tar, { mode: 0o600 });
  const prepared = JSON.stringify({
    schema_version: 1,
    identifier: current.identifier,
    channel: current.channel,
    platform: "macos",
    arch: "arm64",
    version: targetVersion,
    hash: targetHash,
    retained_tar_path: tarPath,
    artifact_file: UPDATER_ARTIFACT_FILE,
  });
  await writeFile(preparedPath, prepared, { mode: 0o600 });
  const verified: VerifiedCandidate = {
    candidate: {
      schema_version: 1,
      identifier: current.identifier,
      channel: current.channel,
      version: targetVersion,
      hash: targetHash,
      artifact_file: UPDATER_ARTIFACT_FILE,
      prepared_path: preparedPath,
      prepared_sha256: createHash("sha256").update(prepared).digest("hex"),
      retained_tar_path: tarPath,
      archive_sha256: createHash("sha256").update(tar).digest("hex"),
      archive_bytes: tar.length,
      frozen_at: "2026-11-03T00:00:00.000Z",
    },
    metadata: { ...current, executable: "launcher", architectures: ["arm64"], bundlePath: app },
  };
  await lease.markPrepared(verified.candidate, null);
  if (mode !== "no-result")
    await writeFile(
      nativeResultPath(channel, transactionId),
      JSON.stringify({
        schema_version: 1,
        transaction_id: transactionId,
        success: true,
        phase: "complete",
        identifier: current.identifier,
        channel: current.channel,
        version: current.version,
        hash: current.hash,
        message: "Synthetic completed transaction",
      }),
      { mode: 0o600 },
    );
  if (mode === "metadata-error") verified.metadata.hash = "wrong1234";
  if (mode === "resolver-error") await chmod(staging, 0o000);
  sdk = await loadApplySdk();
  assert.throws(() => sdk?.onStatusChange(() => {}), /not been admitted/);
  const controller = new AbortController();
  const operation = sdk.getLocalInfo(verified, channel).then((info) => {
    controller.signal.throwIfAborted();
    return info;
  });
  if (mode === "cancelled") queueMicrotask(() => controller.abort());
  let refused = false;
  try {
    const info = await operation;
    assert.equal(info.version, current.version);
    assert.equal(info.hash, current.hash);
    assert.equal(await sdk.appDataFolder(), channel);
  } catch (error) {
    if (mode === "cancelled") assert.equal(error, controller.signal.reason);
    else if (mode === "resolver-error")
      assert.ok(error instanceof Error && "code" in error && error.code === "EACCES");
    else if (mode === "metadata-error" || mode === "same-version")
      assert.ok(
        error instanceof Error &&
          error.message === "SDK metadata does not match the verified update attempt",
      );
    else throw error;
    refused = true;
  } finally {
    if (mode === "resolver-error") await chmod(staging, 0o700);
  }
  const expectedRefusal = !["observed", "no-result"].includes(mode);
  assert.equal(refused, expectedRefusal);
  const expectedMarker = mode === "observed" || mode === "cancelled";
  assert.equal(await Bun.file(marker).exists(), expectedMarker);
  if (expectedMarker)
    assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
      schema_version: 1,
      transaction_id: transactionId,
    });
  assert.ok(await readLease(channel));
  await assert.rejects(
    TransactionLease.acquire({ channelRoot: channel, dataDirectory: data, appBundlePath: app }),
  );
  if (mode !== "cancelled" && expectedRefusal)
    assert.throws(() => sdk?.onStatusChange(() => {}), /not been admitted/);
  sdk.onStatusChange(null);
  await lease.releaseUncommitted();
  const before = await inventoryBundle(channel);
  await new Promise<void>((done) => setTimeout(done, 0));
  await new Promise<void>((done) => setTimeout(done, 0));
  assert.deepEqual(await inventoryBundle(channel), before);
  await atomicWritePrivateJson(join(root, "admission-evidence.json"), {
    mode,
    refused,
    markerBeforeRelease: expectedMarker,
    leaseHeldThroughSettlement: true,
    secondWriterRefused: true,
    unchangedAfterRelease: true,
    scope:
      "Unchanged SDK metadata/reconciliation only, real lease, synthetic prepared record; no apply or app launch",
  });
  await atomicWritePrivateJson(join(root, "worker-result.json"), {
    status: "no-update",
    reason: "check",
  });
} finally {
  await chmod(staging, 0o700);
  sdk?.onStatusChange(null);
  lease.releaseGuard();
}
process.exit(0);
