import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import packageInfo from "../package.json";
import { assertEmptyReleaseArtifacts, releaseOutputEnvironment } from "./build-config";
import { buildPlan, command, prepareToolchain, toolchainEnvironment } from "./toolchain";

const root = resolve(import.meta.dir, "..");
const plan = buildPlan(process.argv[2]);
const environment = {
  ...(plan.signed
    ? releaseOutputEnvironment(packageInfo.version, toolchainEnvironment)
    : toolchainEnvironment),
  CLANG_MODULE_CACHE_PATH: resolve(root, ".cache/clang"),
  SWIFT_MODULECACHE_PATH: resolve(root, ".cache/swift"),
};
if (plan.signed) await assertEmptyReleaseArtifacts(root, environment);
await prepareToolchain();
await mkdir(resolve(root, ".cache/native"), { recursive: true });
await command(
  [
    "/usr/bin/xcrun",
    "clang",
    "-dynamiclib",
    "-fobjc-arc",
    "-mmacosx-version-min=13.0",
    "-framework",
    "Foundation",
    "-framework",
    "ServiceManagement",
    "-framework",
    "AppKit",
    "src/native/login.m",
    "src/native/signals.m",
    "-o",
    ".cache/native/login.dylib",
  ],
  environment,
);
await command(
  [
    "/usr/bin/xcrun",
    "swiftc",
    "-module-cache-path",
    environment.SWIFT_MODULECACHE_PATH,
    "scripts/icons.swift",
    "-o",
    ".cache/native/icons",
  ],
  environment,
);
await command([resolve(root, ".cache/native/icons"), resolve(root, "assets")], environment);

// Preserve the pinned adapter's module/package boundaries and runtime metadata.
const runtime = resolve(root, ".cache/runtime-deps");
await mkdir(runtime, { recursive: true });
for (const file of ["package.json", "bun.lock"])
  await copyFile(resolve(root, file), resolve(runtime, file));
await command(
  [
    process.execPath,
    "install",
    "--cwd",
    runtime,
    "--production",
    "--ignore-scripts",
    "--frozen-lockfile",
    "--cache-dir",
    environment.BUN_INSTALL_CACHE_DIR,
  ],
  environment,
);
await command([process.execPath, "run", "ui:build"], environment);

async function signedBuild() {
  const required = ["APPLE_ID", "APPLE_TEAM_ID", "APPLE_APP_PASSWORD"] as const;
  for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}.`);
  const identityProcess = Bun.spawn(
    ["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const identities = await new Response(identityProcess.stdout).text();
  if ((await identityProcess.exited) !== 0) throw new Error("Signing identity inspection failed.");
  const candidates = [
    ...identities.matchAll(/\b([A-Fa-f0-9]{40}) "(Developer ID Application: [^"]+)"/g),
  ];
  if (candidates.length !== 1)
    throw new Error("Exactly one Developer ID Application identity is required.");
  const identity = candidates[0][2];
  const env = {
    ...environment,
    ELECTROBUN_DEVELOPER_ID: identity,
    ELECTROBUN_APPLEID: process.env.APPLE_ID,
    ELECTROBUN_APPLEIDPASS: process.env.APPLE_APP_PASSWORD,
    ELECTROBUN_TEAMID: process.env.APPLE_TEAM_ID,
  };
  await assertEmptyReleaseArtifacts(root, environment);
  const child = Bun.spawn(
    ["node", "node_modules/electrobun/bin/electrobun.cjs", "build", "--env=stable"],
    {
      cwd: root,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // Buffer before redaction so a credential split across process chunks cannot leak.
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let log = `${stdout}\n${stderr}`;
  for (const secret of [...required.map((name) => process.env[name]), identity, candidates[0][1]]) {
    if (secret) log = log.split(secret).join("[redacted]");
  }
  await writeFile(resolve(root, ".cache/build-stable.log"), log, { mode: 0o600 });
  console.log(log);
  if (exit !== 0) throw new Error(`Signed release build failed with exit code ${exit}.`);
}

if (plan.signed) await signedBuild();
else
  await command(
    ["node", "node_modules/electrobun/bin/electrobun.cjs", ...plan.arguments],
    environment,
  );
