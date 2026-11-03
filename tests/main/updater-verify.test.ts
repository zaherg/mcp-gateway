import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ApplicationVerificationError,
  ApplicationVerifier,
  type CommandResult,
  type CommandRunner,
  parseCodesignDisplay,
  runCommand,
} from "../../src/main/updater/verify";
import { alive, eventually } from "../core/helpers";
import { writeBundleFixture } from "../fixtures/updater";

const TEAM = "ABCDEFGHIJ";

function success(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr, exitCode: 0 };
}

function fakeRunner(
  options: {
    team?: string;
    identifier?: string;
    authority?: boolean;
    requirementFailure?: boolean;
  } = {},
): CommandRunner {
  return async (command, args) => {
    if (command.endsWith("plutil")) {
      if (args.includes("CFBundleIdentifier")) return success("dev.srvr.mcpgateway\n");
      if (args.includes("CFBundleVersion")) {
        const bundle = dirname(dirname(args.at(-1) ?? ""));
        const document = JSON.parse(
          readFileSync(join(bundle, "Contents/Resources/version.json"), "utf8"),
        );
        return success(`${document.version}\n`);
      }
      return success("launcher\n");
    }
    if (command.endsWith("lipo")) return success("arm64\n");
    if (command.endsWith("codesign")) {
      if (args.includes("--display")) {
        const team = options.team ?? TEAM;
        const identifier = options.identifier ?? "dev.srvr.mcpgateway";
        const authority =
          options.authority === false ? "" : "Authority=Developer ID Application: Example\n";
        return success("", `Identifier=${identifier}\nTeamIdentifier=${team}\n${authority}`);
      }
      if (args.includes("-R") && options.requirementFailure) return { ...success(), exitCode: 1 };
      return success();
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };
}

async function directory(): Promise<string> {
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(resolve(".cache"), { recursive: true }),
  );
  return mkdtemp(resolve(".cache/updater-verify-"));
}

test("reads the installed publisher only from a Developer ID signature and expected bundle", async () => {
  const root = await directory();
  try {
    const bundle = writeBundleFixture(root, { version: "0.3.0", hash: "current1234" });
    const verifier = new ApplicationVerifier(fakeRunner());
    expect(await verifier.readPublisher(bundle)).toEqual({
      identifier: "dev.srvr.mcpgateway",
      teamId: TEAM,
    });
    expect((await verifier.inspect(bundle)).architectures).toEqual(["arm64"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts a candidate only when its selected version, hash, publisher, and arm64 executable match", async () => {
  const root = await directory();
  try {
    const bundle = writeBundleFixture(root, { version: "0.3.1", hash: "target123456" });
    const verifier = new ApplicationVerifier(fakeRunner());
    const metadata = await verifier.verifyCandidate(bundle, {
      publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
      version: "0.3.1",
      hash: "target123456",
    });
    expect(metadata.version).toBe("0.3.1");
    expect(metadata.hash).toBe("target123456");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects wrong selected version or hash before signature acceptance", async () => {
  const root = await directory();
  try {
    const bundle = writeBundleFixture(root, { version: "0.3.1", hash: "target123456" });
    const verifier = new ApplicationVerifier(fakeRunner());
    for (const expected of [
      { version: "0.3.2", hash: "target123456" },
      { version: "0.3.1", hash: "other1234567" },
    ]) {
      try {
        await verifier.verifyCandidate(bundle, {
          publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
          ...expected,
        });
        throw new Error("Expected candidate rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationVerificationError);
        expect((error as ApplicationVerificationError).code).toBe("candidate_selection_mismatch");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects wrong publisher, missing Developer ID authority, and requirement failures", async () => {
  const root = await directory();
  try {
    const bundle = writeBundleFixture(root, { version: "0.3.1", hash: "target123456" });
    const expected = {
      publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
      version: "0.3.1",
      hash: "target123456",
    };
    for (const [runner, expectedCode] of [
      [fakeRunner({ team: "OTHER12345" }), "candidate_publisher_mismatch"],
      [fakeRunner({ authority: false }), "candidate_publisher_mismatch"],
      [fakeRunner({ requirementFailure: true }), "candidate_signature_requirement_failed"],
    ] as const) {
      try {
        await new ApplicationVerifier(runner).verifyCandidate(bundle, expected);
        throw new Error("Expected signature rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationVerificationError);
        expect((error as ApplicationVerificationError).code).toBe(expectedCode);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a non-arm64 architecture, symlinked content, and a wrong bundle identifier", async () => {
  const root = await directory();
  try {
    const bundle = writeBundleFixture(root, { version: "0.3.1", hash: "target123456" });
    const expected = {
      publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
      version: "0.3.1",
      hash: "target123456",
    };
    const x86: CommandRunner = async (command, args) =>
      command.endsWith("lipo") ? success("x86_64\n") : fakeRunner()(command, args);
    try {
      await new ApplicationVerifier(x86).verifyCandidate(bundle, expected);
      throw new Error("Expected architecture rejection");
    } catch (error) {
      expect((error as ApplicationVerificationError).code).toBe("candidate_architecture_mismatch");
    }
    await symlink("/tmp", join(bundle, "Contents/Resources/link"));
    try {
      await new ApplicationVerifier(fakeRunner()).verifyCandidate(bundle, expected);
      throw new Error("Expected symlink rejection");
    } catch (error) {
      expect((error as ApplicationVerificationError).code).toBe("candidate_bundle_symlink");
    }
    await rm(join(bundle, "Contents/Resources/link"), { force: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a metadata document that is not the approved stable feed or identity", async () => {
  const root = await directory();
  try {
    const bundle = writeBundleFixture(root, { version: "0.3.1", hash: "target123456" });
    const document = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        join(bundle, "Contents/Resources/version.json"),
        "utf8",
      ),
    );
    for (const change of [
      { baseUrl: "https://example.invalid/releases" },
      { identifier: "dev.srvr.other" },
      { version: "0.3.1-beta.1" },
      { hash: "../target" },
    ]) {
      await writeFile(
        join(bundle, "Contents/Resources/version.json"),
        JSON.stringify({ ...document, ...change }),
      );
      try {
        await new ApplicationVerifier(fakeRunner()).inspect(bundle);
        throw new Error("Expected metadata rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(ApplicationVerificationError);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses only explicit codesign publisher fields", () => {
  expect(
    parseCodesignDisplay(
      "Identifier=dev.srvr.mcpgateway\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Example\n",
    ),
  ).toEqual({ identifier: "dev.srvr.mcpgateway", teamId: "ABCDEFGHIJ", developerId: true });
  expect(parseCodesignDisplay("Identifier=dev.srvr.mcpgateway\nTeamIdentifier=not set\n")).toEqual({
    identifier: "dev.srvr.mcpgateway",
    teamId: "not set",
    developerId: false,
  });
});

test("cancels an owned verification command and kills its child process", async () => {
  const root = await directory();
  const previous = process.env.TEST_VERIFY_PID_FILE;
  const pidFile = join(root, "verifier.pid");
  process.env.TEST_VERIFY_PID_FILE = pidFile;
  try {
    const controller = new AbortController();
    const pending = runCommand(
      process.execPath,
      [
        "-e",
        'require("node:fs").writeFileSync(process.env.TEST_VERIFY_PID_FILE, String(process.pid)); setInterval(() => {}, 1000)',
      ],
      60_000,
      controller.signal,
    );
    await eventually(async () => {
      try {
        return Number(await readFile(pidFile, "utf8")) > 0;
      } catch {
        return false;
      }
    });
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    await eventually(() => !alive(pid));
    expect(alive(pid)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.TEST_VERIFY_PID_FILE;
    else process.env.TEST_VERIFY_PID_FILE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("propagates the abort signal to every verification command", async () => {
  const root = await directory();
  try {
    const bundle = writeBundleFixture(root, { version: "0.3.1", hash: "target123456" });
    const seen: boolean[] = [];
    const observing: CommandRunner = async (command, args, timeout, signal) => {
      seen.push(Boolean(signal));
      return fakeRunner()(command, args, timeout, signal);
    };
    const controller = new AbortController();
    await new ApplicationVerifier(observing).inspect(bundle, controller.signal);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
