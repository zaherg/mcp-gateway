import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UpstreamDiscovery } from "../../../src/core/discovery";
import { inspectUpdateArchive } from "../../../src/main/updater/archive";
import { reconcileTransaction, TransactionLease } from "../../../src/main/updater/transaction";
import {
  ApplicationVerifier,
  type CommandRunner,
  runCommand,
} from "../../../src/main/updater/verify";
import { macOSCompatibilityCommand } from "../../fixtures/macos-compatibility";
import { appEntries, tarBytes, writeBundleFixture } from "../../fixtures/updater";

const nativeTest = test.skipIf(process.platform !== "darwin");
async function directory() {
  await mkdir(resolve(".cache"), { recursive: true });
  return mkdtemp(resolve(".cache/audit-pending-"));
}

nativeTest(
  "A6: a proven empty transaction directory does not permanently block acquisition",
  async () => {
    const root = await directory();
    const channel = join(root, "channel");
    const data = join(root, "data");
    let lease: TransactionLease | undefined;
    try {
      await mkdir(join(channel, ".mcp-gateway-update-transaction"), {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(data, { mode: 0o700 });
      const reconciled = await reconcileTransaction({ channelRoot: channel, dataDirectory: data });
      expect(reconciled.status).toBe("none");
      lease = await TransactionLease.acquire({
        channelRoot: channel,
        dataDirectory: data,
        appBundlePath: join(root, "App.app"),
      });
      expect(lease.snapshot().phase).toBe("operation");
    } finally {
      await lease?.releaseUncommitted();
      await rm(root, { recursive: true });
    }
  },
);

nativeTest("A7: real plist minimum macOS 99.0 prevents candidate admission", async () => {
  const root = await directory();
  try {
    const bundle = writeBundleFixture(root, { version: "0.3.1", hash: "target123456" });
    const plist = join(bundle, "Contents/Info.plist");
    await writeFile(
      plist,
      (await readFile(plist, "utf8")).replace(
        "</dict>",
        "<key>LSMinimumSystemVersion</key><string>99.0</string></dict>",
      ),
    );
    const runner: CommandRunner = async (command, args, timeout, signal) => {
      if (command.endsWith("vtool")) {
        const result = macOSCompatibilityCommand(command, args);
        if (!result) throw new Error("Missing executable metadata fixture");
        return result;
      }
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
    const verifier = new ApplicationVerifier(runner);
    expect((await verifier.inspect(bundle)).version).toBe("0.3.1");
    await expect(
      verifier.verifyCandidate(bundle, {
        publisher: { identifier: "dev.srvr.mcpgateway", teamId: "ABCDEFGHIJ" },
        version: "0.3.1",
        hash: "target123456",
      }),
    ).rejects.toMatchObject({ code: "candidate_macos_incompatible" });
    await writeFile(plist, (await readFile(plist, "utf8")).replace("99.0", "14.0"));
    await expect(
      verifier.verifyCandidate(bundle, {
        publisher: { identifier: "dev.srvr.mcpgateway", teamId: "ABCDEFGHIJ" },
        version: "0.3.1",
        hash: "target123456",
      }),
    ).resolves.toMatchObject({ version: "0.3.1" });
  } finally {
    await rm(root, { recursive: true });
  }
});

for (const notificationFirst of [false, true]) {
  test(`A10: matching discovery SSE response with preceding notification=${notificationFirst}`, async () => {
    const response = {
      jsonrpc: "2.0",
      id: "supergateway-discover",
      result: { supportedVersions: ["2026-07-28"] },
    };
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "synthetic" },
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          [...(notificationFirst ? [notification] : []), response]
            .map((message) => `data: ${JSON.stringify(message)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    const discovery = new UpstreamDiscovery({
      type: "streamableHttp",
      url: new URL(`http://127.0.0.1:${server.port}/mcp`),
      headers: {},
    });
    try {
      expect(await discovery.speaks()).toBe(true);
    } finally {
      await discovery.close();
      await server.stop(true);
    }
  });
}

for (const malformed of [false, true]) {
  test(`A11: original high-bit TAR size bytes are rejected (malformed=${malformed})`, async () => {
    const root = await directory();
    try {
      const bytes = tarBytes(appEntries());
      if (malformed) {
        // The first root-directory size digit remains ASCII '0' after lossy ascii decoding.
        bytes[124] |= 0x80;
        bytes.fill(32, 148, 156);
        const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
        bytes.set(Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `), 148);
      }
      const path = join(root, "candidate.tar");
      await writeFile(path, bytes);
      if (malformed) await expect(inspectUpdateArchive(path)).rejects.toThrow();
      else expect((await inspectUpdateArchive(path)).entries.length).toBe(11);
    } finally {
      await rm(root, { recursive: true });
    }
  });
}
