import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { extractAdmittedArchive, inspectUpdateArchive } from "../../src/main/updater/archive";
import { requiredBundleExecutables } from "../../src/main/updater/constants";
import {
  ApplicationVerifier,
  type ExpectedCandidate,
  runCommand,
} from "../../src/main/updater/verify";

const input = process.env.MCP_GATEWAY_SIGNED_PAYLOAD;
const native = test;
const verifier = new ApplicationVerifier();
let root = "";
let bundle = "";
let expected: ExpectedCandidate;

beforeAll(async () => {
  if (process.platform !== "darwin" || !input)
    throw new Error("Executable acceptance requires macOS and MCP_GATEWAY_SIGNED_PAYLOAD.");
  const source = await realpath(input);
  if (!source.endsWith(".app") || relative(resolve(), source).startsWith(".."))
    throw new Error("An explicit project-local signed payload is required.");
  await mkdir(resolve(".cache"), { recursive: true });
  root = await mkdtemp(resolve(".cache/updater-executability-"));
  bundle = join(root, "MCP Gateway.app");
  await cp(source, bundle, { recursive: true });
  const metadata = await verifier.inspect(bundle);
  expected = {
    version: metadata.version,
    hash: metadata.hash,
    publisher: await verifier.readPublisher(bundle),
  };
  await verifier.verifyCandidate(bundle, expected);
}, 30_000);

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

for (const executable of requiredBundleExecutables()) {
  native(
    `signed candidate rejects only the changed executable permission: ${executable}`,
    async () => {
      const path = join(bundle, executable);
      const mode = (await lstat(path)).mode & 0o777;
      const digest = () =>
        readFile(path).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
      const before = await digest();
      try {
        await chmod(path, 0o600);
        const signature = await runCommand("/usr/bin/codesign", [
          "--verify",
          "--strict",
          "--deep",
          bundle,
        ]);
        expect(signature.exitCode).toBe(0);
        expect(await digest()).toBe(before);
        await expect(access(path, constants.X_OK)).rejects.toMatchObject({ code: "EACCES" });
        await expect(verifier.verifyCandidate(bundle, expected)).rejects.toMatchObject({
          code: "candidate_executable_unavailable",
        });
        await expect(verifier.verifyRetained(bundle, expected)).rejects.toMatchObject({
          code: "candidate_executable_unavailable",
        });
      } finally {
        await chmod(path, mode);
      }
      await expect(verifier.verifyCandidate(bundle, expected)).resolves.toMatchObject({
        version: expected.version,
        hash: expected.hash,
      });
    },
    30_000,
  );
}

native(
  "signed archive keeps executable modes through admission/extraction and refuses a 0600 launcher",
  async () => {
    const archive = join(root, "candidate.tar");
    const launcher = join(bundle, "Contents/MacOS/launcher");
    const mode = (await lstat(launcher)).mode & 0o777;
    const pack = async () => {
      const result = await runCommand(
        "python3",
        [
          "-c",
          [
            "import sys,tarfile",
            "with tarfile.open(sys.argv[1], 'w', format=tarfile.USTAR_FORMAT) as output:",
            " output.add(sys.argv[2], arcname='MCP Gateway.app')",
          ].join("\n"),
          archive,
          bundle,
        ],
        30_000,
      );
      expect(result.exitCode).toBe(0);
    };
    try {
      await chmod(launcher, 0o600);
      await pack();
      await expect(inspectUpdateArchive(archive)).rejects.toMatchObject({ code: "unsafeMode" });
    } finally {
      await chmod(launcher, mode);
    }
    await pack();
    const inspection = await inspectUpdateArchive(archive);
    const extracted = await extractAdmittedArchive(inspection, join(root, "extracted"));
    for (const executable of requiredBundleExecutables()) {
      expect((await lstat(join(extracted, executable))).mode & 0o777).toBe(
        (await lstat(join(bundle, executable))).mode & 0o777,
      );
      await access(join(extracted, executable), constants.R_OK | constants.X_OK);
    }
    await expect(verifier.verifyCandidate(extracted, expected)).resolves.toMatchObject({
      version: expected.version,
      hash: expected.hash,
    });
  },
  60_000,
);
