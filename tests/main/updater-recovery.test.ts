import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  manualRecoveryDescription,
  retainPreviousApplication,
  verifyRetainedRecovery,
} from "../../src/main/updater/recovery";
import {
  ApplicationVerifier,
  type CommandResult,
  type CommandRunner,
  runCommand,
} from "../../src/main/updater/verify";
import { writeBundleFixture } from "../fixtures/updater";

const TEAM = "ABCDEFGHIJ";

function success(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr, exitCode: 0 };
}

const runner: CommandRunner = async (command, args) => {
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
    if (args.includes("--display"))
      return success(
        "",
        "Identifier=dev.srvr.mcpgateway\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Example\n",
      );
    return success();
  }
  return { stdout: "", stderr: "", exitCode: 1 };
};

async function setup(): Promise<{ root: string; data: string; app: string }> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-recovery-"));
  const data = join(root, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  const app = writeBundleFixture(join(root, "Applications"), {
    version: "0.3.0",
    hash: "current1234",
  });
  return { root, data, app };
}

test("retains and independently verifies the previous signed application for manual recovery", async () => {
  const fixture = await setup();
  try {
    const verifier = new ApplicationVerifier(runner);
    const record = await retainPreviousApplication({
      appBundlePath: fixture.app,
      dataDirectory: fixture.data,
      publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
      version: "0.3.0",
      hash: "current1234",
      verifier,
    });
    expect(record.manual_only).toBe(true);
    expect(record.retained_bundle_path.startsWith(join(fixture.data, "updates/recovery"))).toBe(
      true,
    );
    expect(manualRecoveryDescription(record)).toContain("manual recovery copy");
    const verified = await verifyRetainedRecovery({
      dataDirectory: fixture.data,
      publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
      verifier,
    });
    expect(verified.record.version).toBe("0.3.0");
    expect(verified.metadata.hash).toBe("current1234");
    await rm(fixture.app, { recursive: true, force: true });
    await expect(
      verifyRetainedRecovery({
        dataDirectory: fixture.data,
        publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
        verifier,
      }),
    ).resolves.toMatchObject({ record: { version: "0.3.0" } });
    const restored = join(fixture.root, "restored/MCP Gateway.app");
    await mkdir(join(fixture.root, "restored"), { recursive: true, mode: 0o700 });
    await cp(record.retained_bundle_path, restored, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
    const restoredMetadata = await verifier.verifyCandidate(restored, {
      publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
      version: "0.3.0",
      hash: "current1234",
    });
    expect(restoredMetadata.version).toBe("0.3.0");
    expect(await readdir(join(fixture.data, "updates/recovery"))).toContain("latest.json");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("does not publish a recovery record when the copied application fails verification", async () => {
  const fixture = await setup();
  try {
    const rejecting: CommandRunner = async (command, args) => {
      if (command.endsWith("codesign") && args.includes("--verify") && args.includes("-R"))
        return { stdout: "", stderr: "", exitCode: 1 };
      return runner(command, args);
    };
    await expect(
      retainPreviousApplication({
        appBundlePath: fixture.app,
        dataDirectory: fixture.data,
        publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
        version: "0.3.0",
        hash: "current1234",
        verifier: new ApplicationVerifier(rejecting),
      }),
    ).rejects.toThrow();
    const entries = await readdir(join(fixture.data, "updates/recovery")).catch(() => []);
    expect(entries).toEqual([]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a recovery record that points outside the owner-only vault", async () => {
  const fixture = await setup();
  try {
    const recordDirectory = join(fixture.data, "updates/recovery");
    await mkdir(recordDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(recordDirectory, "latest.json"),
      JSON.stringify({
        schema_version: 1,
        identifier: "dev.srvr.mcpgateway",
        version: "0.3.0",
        hash: "current1234",
        retained_bundle_path: "/tmp/MCP Gateway.app",
        created_at: new Date().toISOString(),
        manual_only: true,
      }),
      { mode: 0o600 },
    );
    await expect(
      verifyRetainedRecovery({
        dataDirectory: fixture.data,
        publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
        verifier: new ApplicationVerifier(runner),
      }),
    ).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancellation before recovery publication leaves no latest record", async () => {
  const fixture = await setup();
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(
      retainPreviousApplication({
        appBundlePath: fixture.app,
        dataDirectory: fixture.data,
        publisher: { identifier: "dev.srvr.mcpgateway", teamId: "AKBFT9X3GN" },
        version: "0.3.0",
        hash: "current1234",
        verifier: new ApplicationVerifier(runCommand),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await readdir(join(fileRoot(fixture.data), "updates/recovery")).catch(() => [])).toEqual(
      [],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function fileRoot(dataDirectory: string): string {
  return dataDirectory;
}

test("cancels a bounded recovery copy before publishing a record", async () => {
  const fixture = await setup();
  try {
    for (let index = 0; index < 200; index++) {
      await writeFile(join(fixture.app, "Contents/Resources", `large-${index}`), "x".repeat(1024), {
        mode: 0o600,
      });
    }
    const controller = new AbortController();
    const verifier = new ApplicationVerifier(runner);
    const pending = retainPreviousApplication({
      appBundlePath: fixture.app,
      dataDirectory: fixture.data,
      publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
      version: "0.3.0",
      hash: "current1234",
      verifier,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 1);
    await expect(pending).rejects.toThrow();
    await expect(
      import("node:fs/promises").then(({ readFile }) =>
        readFile(join(fixture.data, "updates/recovery/latest.json")),
      ),
    ).rejects.toThrow();
    const names = await import("node:fs/promises").then(({ readdir }) =>
      readdir(join(fixture.data, "updates/recovery")),
    );
    expect(names).toEqual([]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
