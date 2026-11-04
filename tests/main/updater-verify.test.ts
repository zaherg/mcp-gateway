import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import {
  type MacOSCompatibilityFixture,
  macOSCompatibilityCommand,
} from "../fixtures/macos-compatibility";
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
    compatibility?: MacOSCompatibilityFixture;
  } = {},
): CommandRunner {
  return async (command, args) => {
    const compatibility = macOSCompatibilityCommand(command, args, options.compatibility);
    if (compatibility) return compatibility;
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

const candidateSelection = {
  publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
  version: "0.3.1",
  hash: "target123456",
};

for (const relative of [
  "Contents/MacOS/launcher",
  "Contents/MacOS/bun",
  "Contents/MacOS/bspatch",
  "Contents/MacOS/zig-zstd",
  "Contents/Resources/uninstall",
]) {
  test(`rejects non-executable required candidate file ${relative}`, async () => {
    const root = await directory();
    try {
      const bundle = writeBundleFixture(root, candidateSelection);
      const path = join(bundle, relative);
      await writeFile(path, "synthetic executable", { mode: 0o755 });
      const verifier = new ApplicationVerifier(fakeRunner());
      await expect(verifier.verifyCandidate(bundle, candidateSelection)).resolves.toMatchObject({
        version: "0.3.1",
      });
      await chmod(path, 0o600);
      await expect(verifier.verifyCandidate(bundle, candidateSelection)).rejects.toMatchObject({
        code: "candidate_executable_unavailable",
      });
      await expect(verifier.verifyRetained(bundle, candidateSelection)).rejects.toMatchObject({
        code: "candidate_executable_unavailable",
      });
      await chmod(path, 0o500);
      await expect(verifier.verifyCandidate(bundle, candidateSelection)).resolves.toMatchObject({
        version: "0.3.1",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [name, compatibility, code] of [
  [
    "newer generic minimum",
    { plist: { LSMinimumSystemVersion: "99.0" } },
    "candidate_macos_incompatible",
  ],
  [
    "newer arm64 minimum",
    {
      plist: {
        LSMinimumSystemVersion: "12",
        LSMinimumSystemVersionByArchitecture: { arm64: "14.1" },
      },
    },
    "candidate_macos_incompatible",
  ],
  [
    "generic still applies with lower arm64 override",
    {
      plist: {
        LSMinimumSystemVersion: "15",
        LSMinimumSystemVersionByArchitecture: { arm64: "12" },
      },
    },
    "candidate_macos_incompatible",
  ],
  [
    "newer executable minimum",
    {
      plist: { LSMinimumSystemVersion: "12" },
      buildVersion: "Load command 1\n cmd LC_BUILD_VERSION\n platform MACOS\n minos 15.0\n",
    },
    "candidate_macos_incompatible",
  ],
  [
    "malformed generic minimum",
    { plist: { LSMinimumSystemVersion: "14.x" } },
    "candidate_macos_invalid",
  ],
  ["non-string minimum", { plist: { LSMinimumSystemVersion: 14 } }, "candidate_macos_invalid"],
  [
    "malformed architecture dictionary",
    { plist: { LSMinimumSystemVersionByArchitecture: [] } },
    "candidate_macos_invalid",
  ],
  [
    "malformed arm64 minimum",
    { plist: { LSMinimumSystemVersionByArchitecture: { arm64: "14.0junk" } } },
    "candidate_macos_invalid",
  ],
  ["unavailable executable requirement", { buildVersion: "fixture:\n" }, "candidate_macos_invalid"],
  [
    "wrong executable platform",
    { buildVersion: "Load command 1\n cmd LC_BUILD_VERSION\n platform IOS\n minos 14.0\n" },
    "candidate_macos_invalid",
  ],
  [
    "conflicting executable records",
    {
      buildVersion:
        "Load command 1\n cmd LC_BUILD_VERSION\n platform MACOS\n minos 14.0\nLoad command 2\n cmd LC_BUILD_VERSION\n platform MACOS\n minos 15.0\n",
    },
    "candidate_macos_invalid",
  ],
  ["malformed host version", { hostVersion: "Darwin 27" }, "candidate_macos_invalid"],
  [
    "host patch below requirement",
    { hostVersion: "14.2.1", plist: { LSMinimumSystemVersion: "14.2.2" } },
    "candidate_macos_incompatible",
  ],
] satisfies [string, MacOSCompatibilityFixture, string][]) {
  test(`rejects candidate macOS compatibility: ${name}`, async () => {
    const root = await directory();
    try {
      const bundle = writeBundleFixture(root, candidateSelection);
      await expect(
        new ApplicationVerifier(fakeRunner({ compatibility })).verifyCandidate(
          bundle,
          candidateSelection,
        ),
      ).rejects.toMatchObject({ code });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const compatibility of [
  {},
  { plist: { LSMinimumSystemVersion: "13.9" } },
  { plist: { LSMinimumSystemVersion: "14.0.0" } },
  { hostVersion: "14.10", plist: { LSMinimumSystemVersion: "14.9" } },
  { plist: { LSMinimumSystemVersionByArchitecture: { x86_64: "99", arm64: "14" } } },
  {
    buildVersion:
      "Load command 1\n cmd LC_VERSION_MIN_MACOSX\n cmdsize 16\n version 10.15\n sdk 12.0\n",
  },
] satisfies MacOSCompatibilityFixture[]) {
  test(`accepts compatible candidate metadata ${JSON.stringify(compatibility)}`, async () => {
    const root = await directory();
    try {
      const bundle = writeBundleFixture(root, candidateSelection);
      await expect(
        new ApplicationVerifier(fakeRunner({ compatibility })).verifyCandidate(
          bundle,
          candidateSelection,
        ),
      ).resolves.toMatchObject({ version: "0.3.1" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const tool of ["plutil", "vtool", "sw_vers"]) {
  test(`refuses unavailable compatibility ${tool} and propagates cancellation`, async () => {
    const root = await directory();
    try {
      const bundle = writeBundleFixture(root, candidateSelection);
      const runner = fakeRunner();
      const failing: CommandRunner = async (command, args, timeout, signal) =>
        command.endsWith(tool) && (tool !== "plutil" || args.includes("-convert"))
          ? { stdout: "", stderr: "synthetic unavailable", exitCode: 1 }
          : runner(command, args, timeout, signal);
      await expect(
        new ApplicationVerifier(failing).verifyCandidate(bundle, candidateSelection),
      ).rejects.toMatchObject({ code: "candidate_macos_unavailable" });
      const controller = new AbortController();
      const cancelling: CommandRunner = async (command, args, timeout, signal) => {
        if (command.endsWith(tool) && (tool !== "plutil" || args.includes("-convert"))) {
          expect(signal).toBe(controller.signal);
          controller.abort();
        }
        return runner(command, args, timeout, signal);
      };
      await expect(
        new ApplicationVerifier(cancelling).verifyCandidate(
          bundle,
          candidateSelection,
          controller.signal,
        ),
      ).rejects.toMatchObject({ code: "candidate_cancelled" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const [relative, magic] of [
  ["Contents/MacOS/bun", 0xcffaedfe],
  ["Contents/MacOS/libRequired.dylib", 0xcafebabe],
  ["Contents/Resources/app/native/login.dylib", 0xcafebabf],
  ["Contents/Resources/uninstall", 0xfeedfacf],
] as const) {
  test(`candidate compatibility includes the required Mach-O at ${relative}`, async () => {
    const root = await directory();
    try {
      const bundle = writeBundleFixture(root, candidateSelection);
      const path = join(bundle, relative);
      await mkdir(dirname(path), { recursive: true });
      const bytes = Buffer.alloc(4);
      bytes.writeUInt32BE(magic);
      await writeFile(path, bytes);
      let inspected = 0;
      let minimum = "99.0";
      const base = fakeRunner();
      const runner: CommandRunner = async (command, args, timeout, signal) => {
        if (command.endsWith("vtool") && args.at(-1) === path) {
          inspected++;
          expect(args.slice(0, 3)).toEqual(["-arch", "arm64", "-show-build"]);
          return success(
            `Load command 1\n cmd LC_BUILD_VERSION\n platform MACOS\n minos ${minimum}\n`,
          );
        }
        return base(command, args, timeout, signal);
      };
      const verifier = new ApplicationVerifier(runner);
      await expect(verifier.verifyCandidate(bundle, candidateSelection)).rejects.toMatchObject({
        code: "candidate_macos_incompatible",
      });
      expect(inspected).toBe(1);
      minimum = "13.0";
      await expect(verifier.verifyCandidate(bundle, candidateSelection)).resolves.toMatchObject({
        version: "0.3.1",
      });
      expect(inspected).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("retained recovery verification does not acquire new-candidate compatibility policy", async () => {
  const root = await directory();
  try {
    const bundle = writeBundleFixture(root, candidateSelection);
    const verifier = new ApplicationVerifier(
      fakeRunner({ compatibility: { plist: { LSMinimumSystemVersion: "99" } } }),
    );
    await expect(verifier.verifyRetained(bundle, candidateSelection)).resolves.toMatchObject({
      version: "0.3.1",
    });
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
