import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UpdaterSafetyBoundary } from "../../../src/main/updater/boundary";
import type { FrozenCandidate } from "../../../src/main/updater/candidate";
import {
  type ExpectedNativePlan,
  nativeHelperPath,
  nativePlanPath,
  nativeResultPath,
  readLease,
  TransactionLease,
} from "../../../src/main/updater/transaction";
import {
  ApplicationVerifier,
  type CommandRunner,
  runCommand,
} from "../../../src/main/updater/verify";
import { infoPlist, versionJson, writeBundleFixture } from "../../fixtures/updater";

const nativeTest = test.skipIf(process.platform !== "darwin");
const runner: CommandRunner = async (command, args, timeout, signal) => {
  if (command.endsWith("lipo")) return { stdout: "arm64\n", stderr: "", exitCode: 0 };
  if (command.endsWith("codesign"))
    return {
      stdout: "",
      exitCode: 0,
      stderr: args.includes("--display")
        ? "Identifier=dev.srvr.mcpgateway\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Synthetic\n"
        : "",
    };
  return runCommand(command, args, timeout, signal);
};
async function fixture() {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/audit-updater-"));
  const home = join(root, "home");
  const data = join(root, "data");
  const channel = join(home, "Library/Application Support/dev.srvr.mcpgateway/stable");
  const temporary = join(root, "tmp");
  for (const path of [data, channel, temporary])
    await mkdir(path, { recursive: true, mode: 0o700 });
  const app = writeBundleFixture(join(root, "Applications"), {
    version: "0.3.0",
    hash: "current1234",
  });
  const boundary = new UpdaterSafetyBoundary({
    appBundlePath: app,
    dataDirectory: data,
    channelRoot: channel,
    home,
    appDataDirectory: join(home, "Library/Application Support"),
    startupReconcileWaitMs: 0,
    verifier: new ApplicationVerifier(runner),
  });
  return { root, home, data, channel, temporary, app, boundary };
}

nativeTest(
  "A4: an existing boundary cannot confirm replacement metadata as executing code",
  async () => {
    const f = await fixture();
    let lease: TransactionLease | undefined;
    try {
      expect((await f.boundary.inspectInstalled()).metadata.version).toBe("0.3.0");
      const candidate: FrozenCandidate = {
        schema_version: 1,
        identifier: "dev.srvr.mcpgateway",
        channel: "stable",
        version: "0.3.1",
        hash: "target123456",
        artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
        prepared_path: join(f.root, "prepared.json"),
        prepared_sha256: "a".repeat(64),
        retained_tar_path: join(f.root, "target.tar"),
        archive_sha256: "b".repeat(64),
        archive_bytes: 1,
        frozen_at: "2026-11-03T00:00:00.000Z",
      };
      const plan: ExpectedNativePlan = {
        identifier: candidate.identifier,
        channel: "stable",
        platform: "macos",
        arch: "arm64",
        version: candidate.version,
        hash: candidate.hash,
        channelRoot: f.channel,
        appBundlePath: f.app,
        retainedTarPath: candidate.retained_tar_path,
        parentPid: process.pid,
        physicalTemporaryDirectory: f.temporary,
      };
      lease = await TransactionLease.acquire({
        channelRoot: f.channel,
        dataDirectory: f.data,
        appBundlePath: f.app,
      });
      await lease.markPrepared(candidate, join(f.root, "previous.app"));
      const prepared = await lease.prepareHandoff(
        { id: 7, candidate, signal: new AbortController().signal },
        plan,
        [],
      );
      lease.armHandoffSync(prepared.identity);
      const id = "0123456789abcdef0123456789abcdef";
      lease.bindNativeSync(prepared.identity, {
        evidence: "observed-plan",
        transactionId: id,
        planPath: nativePlanPath(f.channel, id),
        resultPath: nativeResultPath(f.channel, id),
        helperPath: nativeHelperPath(f.temporary, id),
        plan,
      });
      lease.releaseGuard();
      await writeFile(
        nativeResultPath(f.channel, id),
        JSON.stringify({
          schema_version: 1,
          transaction_id: id,
          success: true,
          phase: "complete",
          message: "Synthetic completion",
          identifier: candidate.identifier,
          channel: candidate.channel,
          version: candidate.version,
          hash: candidate.hash,
        }),
        { mode: 0o644 },
      );
      // Replace only files, not the boundary or any executing application code.
      await writeFile(
        join(f.app, "Contents/Resources/version.json"),
        versionJson(candidate.version, candidate.hash),
      );
      await writeFile(join(f.app, "Contents/Info.plist"), infoPlist(candidate.version));
      const result = await f.boundary.reconcile();
      const retained = await readLease(f.channel);
      expect({ status: result.status, journalRetained: retained !== undefined }).toEqual({
        status: "unconfirmed",
        journalRetained: true,
      });
    } finally {
      lease?.releaseGuard();
      await rm(f.root, { recursive: true });
    }
  },
);
