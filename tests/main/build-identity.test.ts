import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { prepareBuildIdentity } from "../../scripts/build-identity";
import { runCommand } from "../../src/core/command";
import { EXECUTING_BUILD } from "../../src/main/updater/executing-build";
import { ApplicationVerifier, type CommandRunner } from "../../src/main/updater/verify";
import { BUILD_IDENTITY_FILE, parseBuildIdentity } from "../../src/shared/build-identity";
import { infoPlist, versionJson, writeBundleFixture } from "../fixtures/updater";

async function directory() {
  await mkdir(resolve(".cache"), { recursive: true });
  return mkdtemp(resolve(".cache/build-identity-test-"));
}
const publisher = { identifier: "dev.srvr.mcpgateway", teamId: "ABCDEFGHIJ" };
const runner: CommandRunner = async (command, args) => {
  let stdout = "";
  if (command.endsWith("plutil")) {
    if (args.includes("CFBundleIdentifier")) stdout = publisher.identifier;
    else if (args.includes("CFBundleVersion"))
      stdout = JSON.parse(
        await readFile(join(dirname(args.at(-1) ?? ""), "Resources/version.json"), "utf8"),
      ).version;
    else stdout = "launcher";
  } else if (command.endsWith("lipo")) stdout = "arm64";
  else if (command.endsWith("codesign") && args.includes("--display"))
    stdout =
      "Identifier=dev.srvr.mcpgateway\nTeamIdentifier=ABCDEFGHIJ\nAuthority=Developer ID Application: Synthetic\n";
  return { stdout, stderr: "", exitCode: 0 };
};

test("each build has a fresh compiled identity matching its generated resource", async () => {
  const root = await directory();
  try {
    expect(EXECUTING_BUILD).toBeUndefined();
    const a = prepareBuildIdentity(root, "0.3.1");
    const b = prepareBuildIdentity(root, "0.3.1");
    expect(a.identity.build_id).not.toBe(b.identity.build_id);
    expect(JSON.parse(await readFile(a.resource, "utf8"))).toEqual(a.identity);
    expect(Object.values(a.copy)).toEqual([BUILD_IDENTITY_FILE]);
    const source = join(root, "main.ts");
    await writeFile(
      source,
      `import { EXECUTING_BUILD } from ${JSON.stringify(resolve("src/main/updater/executing-build.ts"))}; console.log(JSON.stringify(EXECUTING_BUILD));\n`,
    );
    for (const selected of [a, b]) {
      const output = join(root, selected.identity.build_id);
      const built = await Bun.build({
        entrypoints: [source],
        outdir: output,
        target: "bun",
        define: selected.define,
      });
      expect(built.success).toBe(true);
      const script = join(output, "main.js");
      // Replacing resources cannot change the identity of already-bundled code.
      await writeFile(selected.resource, JSON.stringify(selected === a ? b.identity : a.identity));
      const result = await runCommand(process.execPath, [script]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(selected.identity);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executing identity rejects replacement files, including a same-version different build", async () => {
  const root = await directory();
  try {
    const a = prepareBuildIdentity(root, "0.3.1").identity;
    const b = prepareBuildIdentity(root, "0.3.1").identity;
    const c = prepareBuildIdentity(root, "0.3.2").identity;
    const app = writeBundleFixture(root, { version: a.version, hash: "initial1234" });
    const resource = join(app, "Contents/Resources/app", BUILD_IDENTITY_FILE);
    await mkdir(dirname(resource));
    await writeFile(resource, JSON.stringify(a));
    const verifier = new ApplicationVerifier(runner);
    expect((await verifier.inspectExecutingBuild(app, a)).hash).toBe("initial1234");
    for (const replacement of [b, c]) {
      await writeFile(resource, JSON.stringify(replacement));
      await writeFile(
        join(app, "Contents/Resources/version.json"),
        versionJson(replacement.version, "replaced1234"),
      );
      await writeFile(join(app, "Contents/Info.plist"), infoPlist(replacement.version));
      await expect(verifier.inspectExecutingBuild(app, a)).rejects.toMatchObject({
        code: "executing_identity_mismatch",
      });
      expect((await verifier.inspectExecutingBuild(app, replacement)).hash).toBe("replaced1234");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replacement metadata cannot survive a same-version rollback during identity verification", async () => {
  const root = await directory();
  try {
    const executing = prepareBuildIdentity(root, "0.3.1").identity;
    const replacement = prepareBuildIdentity(root, "0.3.1").identity;
    const app = writeBundleFixture(root, { version: "0.3.1", hash: "replaced1234" });
    const resource = join(app, "Contents/Resources/app", BUILD_IDENTITY_FILE);
    await mkdir(dirname(resource));
    await writeFile(resource, JSON.stringify(replacement));
    let swapped = false;
    class RollbackVerifier extends ApplicationVerifier {
      override async inspect(path: string, signal?: AbortSignal) {
        const observed = await super.inspect(path, signal);
        if (!swapped) {
          swapped = true;
          await writeFile(
            join(app, "Contents/Resources/version.json"),
            versionJson("0.3.1", "initial1234"),
          );
          await writeFile(resource, JSON.stringify(executing));
        }
        return observed;
      }
    }
    const verifier = new RollbackVerifier(runner);
    await expect(verifier.inspectExecutingBuild(app, executing)).rejects.toMatchObject({
      code: "executing_identity_changed",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy recovery verification remains available without confirmation authority", async () => {
  const root = await directory();
  try {
    const app = writeBundleFixture(root, { version: "0.3.1", hash: "legacy1234" });
    const verifier = new ApplicationVerifier(runner);
    expect(
      (await verifier.verifyRetained(app, { publisher, version: "0.3.1", hash: "legacy1234" }))
        .hash,
    ).toBe("legacy1234");
    await expect(verifier.inspectExecutingBuild(app, undefined)).rejects.toMatchObject({
      code: "executing_identity_unavailable",
    });
    await expect(
      verifier.inspectExecutingBuild(app, prepareBuildIdentity(root, "0.3.1").identity),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed or unsigned identity resources cannot confirm the executing build", async () => {
  const root = await directory();
  try {
    const identity = prepareBuildIdentity(root, "0.3.1").identity;
    const app = writeBundleFixture(root, { version: "0.3.1", hash: "current1234" });
    const resource = join(app, "Contents/Resources/app", BUILD_IDENTITY_FILE);
    await mkdir(dirname(resource));
    const verifier = new ApplicationVerifier(runner);
    for (const invalid of [
      {},
      { ...identity, build_id: "invalid" },
      { ...identity, extra: true },
      { ...identity, identifier: "untrusted" },
    ]) {
      await writeFile(resource, JSON.stringify(invalid));
      await expect(verifier.inspectExecutingBuild(app, identity)).rejects.toThrow();
    }
    await writeFile(resource, JSON.stringify(identity));
    const unsigned = new ApplicationVerifier(async (command, args, timeout, signal) =>
      command.endsWith("codesign")
        ? { stdout: "", stderr: "", exitCode: 1 }
        : runner(command, args, timeout, signal),
    );
    await expect(unsigned.inspectExecutingBuild(app, identity)).rejects.toThrow();
    expect(() => parseBuildIdentity({ ...identity, version: 123 })).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
