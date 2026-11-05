import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ApplicationVerifier,
  type CommandRunner,
  runCommand,
} from "../../../src/main/updater/verify";
import { macOSCompatibilityCommand } from "../../fixtures/macos-compatibility";
import { writeBundleFixture } from "../../fixtures/updater";

const nativeTest = test.skipIf(process.platform !== "darwin");

nativeTest("A7: real plist minimum macOS 99.0 prevents candidate admission", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/audit-pending-"));
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
