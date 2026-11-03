import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FrozenCandidate } from "../../src/main/updater/candidate";
import { captureRegisteredGroup } from "../../src/main/updater/registered-group";
import {
  type ExpectedNativePlan,
  nativeHelperPath,
  nativePlanPath,
  nativeResultPath,
  TransactionLease,
} from "../../src/main/updater/transaction";

const [root, mode] = process.argv.slice(2);
if (!root || !mode || !resolve(root).startsWith(`${resolve(".cache")}/`))
  throw new Error("Invalid journal fixture root");
const channelRoot = join(root, "home/Library/Application Support/dev.srvr.mcpgateway/stable");
const dataDirectory = join(root, "data");
const appBundlePath = join(root, "MCP Gateway.app");
const temporary = join(root, "tmp");
for (const path of [dataDirectory, appBundlePath, temporary])
  await mkdir(path, { recursive: true, mode: 0o700 });
const lease = await TransactionLease.acquire({ channelRoot, dataDirectory, appBundlePath });
if (["before-grant", "after-grant"].includes(mode)) {
  const worker = Bun.spawn(
    [process.execPath, resolve("tests/fixtures/registered-group-worker.ts")],
    {
      detached: true,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      env: { PATH: "/usr/bin:/bin", GROUP_READY: join(root, "group-ready") },
    },
  );
  lease.registerWorkerGroupSync(
    await captureRegisteredGroup({
      leaderPid: worker.pid,
      helperPath: process.execPath,
      planPath: join(root, "result.json"),
    }),
  );
  if (mode === "after-grant") {
    lease.markWorkerGrantedSync();
    worker.stdin.write("grant\n");
    await worker.stdin.end();
    while (!(await Bun.file(join(root, "group-ready")).exists())) await Bun.sleep(10);
  }
  // Before grant, abrupt owner exit itself closes the private stdin capability.
} else if (mode !== "operation") {
  const candidate: FrozenCandidate = {
    schema_version: 1,
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    version: "0.3.1",
    hash: "target123456",
    artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
    prepared_path: join(dataDirectory, "prepared.json"),
    prepared_sha256: "a".repeat(64),
    retained_tar_path: join(channelRoot, "self-extraction/target123456.tar"),
    archive_sha256: "b".repeat(64),
    archive_bytes: 1,
    frozen_at: "2026-11-03T00:00:00.000Z",
  };
  await lease.markPrepared(candidate, join(root, "previous.app"));
  if (mode !== "prepared") {
    const expected: ExpectedNativePlan = {
      identifier: "dev.srvr.mcpgateway",
      channel: "stable",
      platform: "macos",
      arch: "arm64",
      version: candidate.version,
      hash: candidate.hash,
      channelRoot,
      appBundlePath,
      retainedTarPath: candidate.retained_tar_path,
      parentPid: process.pid,
      physicalTemporaryDirectory: temporary,
    };
    const { identity } = await lease.prepareHandoff(
      { id: 7, candidate, signal: new AbortController().signal },
      expected,
      [],
    );
    lease.armHandoffSync(identity);
    const id = "0123456789abcdef0123456789abcdef";
    lease.bindNativeSync(identity, {
      evidence: "observed-plan",
      transactionId: id,
      planPath: nativePlanPath(channelRoot, id),
      resultPath: nativeResultPath(channelRoot, id),
      helperPath: nativeHelperPath(temporary, id),
      plan: expected,
    });
    await writeFile(
      nativeResultPath(channelRoot, id),
      JSON.stringify({
        schema_version: 1,
        transaction_id: id,
        success: mode === "success",
        phase: mode === "success" ? "complete" : "swapping",
        message: "synthetic",
        identifier: "dev.srvr.mcpgateway",
        channel: "stable",
        version: candidate.version,
        hash: candidate.hash,
      }),
      { mode: 0o600 },
    );
  }
}
// Simulate abrupt owner loss without calling any lease-retirement operation.
process.exit(0);
