import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { UPDATER_FEED_URL } from "../../src/main/updater/constants";
import { admitSdkRoot, readUpdateSupport } from "../../src/main/updater/support";
import { versionJson } from "../fixtures/updater";

function fakeVerifier(
  eligible = true,
): Pick<import("../../src/main/updater/verify").ApplicationVerifier, "readPublisher"> {
  return {
    readPublisher: async () => {
      if (!eligible) throw new Error("unsigned");
      return { identifier: "dev.srvr.mcpgateway", teamId: "AKBFT9X3GN" };
    },
  };
}

async function appBundle(
  options: {
    identifier?: string;
    channel?: string;
    baseUrl?: string;
    version?: string;
    worker?: boolean;
  } = {},
): Promise<{ root: string; bundle: string }> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-support-"));
  const bundle = join(root, "MCP Gateway.app");
  await mkdir(join(bundle, "Contents/Resources/app/bun"), { recursive: true });
  await mkdir(join(bundle, "Contents/MacOS"), { recursive: true });
  await writeFile(
    join(bundle, "Contents/Resources/version.json"),
    JSON.stringify({
      identifier: options.identifier ?? "dev.srvr.mcpgateway",
      channel: options.channel ?? "stable",
      baseUrl: options.baseUrl ?? UPDATER_FEED_URL,
      version: options.version ?? "0.3.1",
    }),
  );
  if (options.worker !== false) {
    await writeFile(join(bundle, "Contents/MacOS/bun"), "fixture", { mode: 0o755 });
    await writeFile(join(bundle, "Contents/Resources/app/bun/index.js"), "fixture");
  }
  return { root, bundle };
}

test("supports only non-isolated macOS stable builds with the fixed feed and owned worker", async () => {
  const fixture = await appBundle();
  try {
    expect(
      await readUpdateSupport({
        platform: "macos",
        isolated: false,
        appBundlePath: fixture.bundle,
        architecture: "arm64",
        verifier: fakeVerifier(),
      }),
    ).toEqual({ supported: true, installedVersion: "0.3.1" });
    for (const input of [
      { platform: "linux" as const, isolated: false },
      { platform: "macos" as const, isolated: true },
    ]) {
      expect(await readUpdateSupport({ ...input, appBundlePath: fixture.bundle })).toEqual({
        supported: false,
        installedVersion: null,
      });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("does not enable updates for dev, prerelease, wrong identity, wrong feed, or missing worker assets", async () => {
  for (const options of [
    { channel: "dev" },
    { version: "0.3.2-beta.1" },
    { identifier: "dev.srvr.other" },
    { baseUrl: "https://example.invalid/releases" },
    { worker: false },
  ]) {
    const fixture = await appBundle(options);
    try {
      expect(
        await readUpdateSupport({
          platform: "macos",
          isolated: false,
          appBundlePath: fixture.bundle,
          architecture: "arm64",
          verifier: fakeVerifier(),
        }),
      ).toMatchObject({ supported: false });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
  expect(
    await readUpdateSupport({
      platform: "macos",
      isolated: false,
      appBundlePath: resolve(".cache/does-not-exist"),
      architecture: "arm64",
      verifier: fakeVerifier(),
    }),
  ).toEqual({ supported: false, installedVersion: null });
});

test("refuses update support on non-arm64 hosts and unsigned or ineligible bundles", async () => {
  const fixture = await appBundle();
  try {
    expect(
      await readUpdateSupport({
        platform: "macos",
        isolated: false,
        appBundlePath: fixture.bundle,
        architecture: "x64",
        verifier: fakeVerifier(),
      }),
    ).toMatchObject({ supported: false });
    expect(
      await readUpdateSupport({
        platform: "macos",
        isolated: false,
        appBundlePath: fixture.bundle,
        architecture: "arm64",
        verifier: fakeVerifier(false),
      }),
    ).toMatchObject({ supported: false });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("pure SDK admission rejects legacy roots and resolver errors without SDK side effects", async () => {
  const fixture = await appBundle();
  try {
    const base = join(fixture.root, "app-data");
    const channel = join(base, "dev.srvr.mcpgateway/stable");
    const versionPath = join(fixture.bundle, "Contents/Resources/version.json");
    await writeFile(versionPath, versionJson("0.3.0", "current1234"), { mode: 0o600 });
    const allowed = await admitSdkRoot(channel, base, () => "stable", versionPath);
    expect(allowed).toMatchObject({ version: "0.3.0", hash: "current1234", name: "MCPGateway" });
    await expect(admitSdkRoot(channel, base, () => "MCPGateway", versionPath)).rejects.toThrow(
      "Updater root changed or is unsupported",
    );
    await expect(
      admitSdkRoot(
        channel,
        base,
        () => {
          throw Object.assign(new Error("Synthetic inaccessible root"), { code: "EACCES" });
        },
        versionPath,
      ),
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(await Bun.file(join(channel, ".electrobun-observed-update-result.json")).exists()).toBe(
      false,
    );
    const entrypoint = await Bun.file(resolve("src/main/index.ts")).text();
    expect(entrypoint).not.toContain("await Updater.appDataFolder()");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("portable service and unsupported coordinator imports acquire no macOS FFI", async () => {
  const root = await mkdtemp(resolve(".cache/updater-portable-import-"));
  try {
    const mock = join(root, "refuse-native.ts");
    await writeFile(
      mock,
      'export function dlopen() { throw new Error("Portable import acquired native FFI"); }',
      { mode: 0o600 },
    );
    const bundle = await Bun.build({
      entrypoints: [resolve("tests/fixtures/updater-portable-import.ts")],
      outdir: root,
      target: "bun",
      plugins: [
        {
          name: "refuse-native-acquisition",
          setup(build) {
            build.onLoad({ filter: /updater\/kernel-guard\.ts$/ }, async (args) => {
              const source = await Bun.file(args.path).text();
              const anchor = 'import { dlopen } from "bun:ffi";';
              if (source.split(anchor).length !== 2) throw new Error("Missing native import seam");
              return {
                contents: source.replace(anchor, `import { dlopen } from ${JSON.stringify(mock)};`),
                loader: "ts",
              };
            });
          },
        },
      ],
    });
    expect(bundle.success).toBe(true);
    expect(await bundle.outputs[0]?.text()).toContain("Portable import acquired native FFI");
    const child = Bun.spawn([process.execPath, join(root, "updater-portable-import.js")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new Response(child.stdout).text();
    const err = new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(await err).toBe("");
    expect(await out).toBe("unsupported-import-native-loads=0\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
