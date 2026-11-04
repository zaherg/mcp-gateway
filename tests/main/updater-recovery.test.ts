import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
import { macOSCompatibilityCommand } from "../fixtures/macos-compatibility";
import { writeBundleFixture } from "../fixtures/updater";

const TEAM = "ABCDEFGHIJ";

function success(stdout = "", stderr = ""): CommandResult {
  return { stdout, stderr, exitCode: 0 };
}

const runner: CommandRunner = async (command, args) => {
  const compatibility = macOSCompatibilityCommand(command, args);
  if (compatibility) return compatibility;
  if (command.endsWith("plutil")) {
    if (args.includes("CFBundleIdentifier")) return success("dev.srvr.mcpgateway\n");
    if (args.includes("CFBundleVersion")) {
      const bundle = dirname(dirname(args.at(-1) ?? ""));
      const document = JSON.parse(
        fs.readFileSync(join(bundle, "Contents/Resources/version.json"), "utf8"),
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

test("a durable recovery publication replaces the record before pruning the older copy", async () => {
  const fixture = await setup();
  try {
    const options = {
      appBundlePath: fixture.app,
      dataDirectory: fixture.data,
      publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
      version: "0.3.0",
      hash: "current1234",
      verifier: new ApplicationVerifier(runner),
    };
    const previous = await retainPreviousApplication(options);
    const next = await retainPreviousApplication(options);
    expect(next.retained_bundle_path).not.toBe(previous.retained_bundle_path);
    expect((await readdir(join(fixture.data, "updates/recovery"))).sort()).toEqual(
      ["latest.json", basename(next.retained_bundle_path)].sort(),
    );
    expect(await readFile(join(fixture.data, "updates/recovery/latest.json"), "utf8")).toBe(
      `${JSON.stringify(next)}\n`,
    );
    expect((await verifyRetainedRecovery(options)).record).toEqual(next);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const existing of [false, true]) {
  for (const failurePoint of ["file sync", "record rename", "directory sync"] as const) {
    test(`recovery ${failurePoint} failure preserves referenced bundles with prior record=${existing}`, async () => {
      const fixture = await setup();
      const options = {
        appBundlePath: fixture.app,
        dataDirectory: fixture.data,
        publisher: { identifier: "dev.srvr.mcpgateway", teamId: TEAM },
        version: "0.3.0",
        hash: "current1234",
        verifier: new ApplicationVerifier(runner),
      };
      try {
        const previous = existing ? await retainPreviousApplication(options) : undefined;
        const recovery = join(fixture.data, "updates/recovery");
        const recordPath = join(recovery, "latest.json");
        await mkdir(recovery, { recursive: true, mode: 0o700 });
        const directory = fs.statSync(recovery);
        const before = previous ? await readFile(recordPath) : undefined;
        const sourceBytes = await readFile(join(fixture.app, "Contents/Resources/version.json"));
        const failure = new Error(`Synthetic recovery ${failurePoint} refusal`);
        let injected = 0;
        const rename = fs.renameSync;
        const sync = fs.fsyncSync;
        const renameMock = spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (failurePoint === "record rename" && to === recordPath) {
            injected++;
            throw failure;
          }
          rename(from, to);
        });
        const syncMock = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
          const entry = fs.fstatSync(fd);
          const partial = fs
            .readdirSync(recovery)
            .find((name) => name.startsWith("latest.json.") && name.endsWith(".partial"));
          const target =
            failurePoint === "directory sync"
              ? directory
              : failurePoint === "file sync" && partial
                ? fs.statSync(join(recovery, partial))
                : undefined;
          if (target && entry.dev === target.dev && entry.ino === target.ino) {
            injected++;
            throw failure;
          }
          sync(fd);
        });
        try {
          await expect(retainPreviousApplication(options)).rejects.toBe(failure);
          expect(injected).toBe(1);
        } finally {
          renameMock.mockRestore();
          syncMock.mockRestore();
        }
        if (failurePoint === "directory sync") {
          const verified = await verifyRetainedRecovery(options);
          expect(verified.record.retained_bundle_path).not.toBe(previous?.retained_bundle_path);
          expect(
            await readFile(
              join(verified.record.retained_bundle_path, "Contents/Resources/version.json"),
            ),
          ).toEqual(sourceBytes);
          expect((await readdir(recovery)).sort()).toEqual(
            [
              "latest.json",
              basename(verified.record.retained_bundle_path),
              ...(previous ? [basename(previous.retained_bundle_path)] : []),
            ].sort(),
          );
        } else {
          expect((await readdir(recovery)).sort()).toEqual(
            previous ? ["latest.json", basename(previous.retained_bundle_path)].sort() : [],
          );
          if (before) expect(await readFile(recordPath)).toEqual(before);
        }
        if (previous)
          expect(
            await readFile(join(previous.retained_bundle_path, "Contents/Resources/version.json")),
          ).toEqual(sourceBytes);
        expect(await readFile(join(fixture.app, "Contents/Resources/version.json"))).toEqual(
          sourceBytes,
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
}

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
