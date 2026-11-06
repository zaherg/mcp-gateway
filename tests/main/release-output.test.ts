import { expect, test } from "bun:test";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertEmptyReleaseArtifacts,
  releaseArtifactFolder,
  releaseOutputEnvironment,
} from "../../scripts/release-output";
import { testDirectory } from "../core/helpers";

test("release output selection preserves default and configured folder names", () => {
  expect(releaseArtifactFolder({})).toBe("artifacts");
  expect(releaseArtifactFolder({ MCP_GATEWAY_ARTIFACTS_DIR: "candidate/assets" })).toBe(
    "candidate/assets",
  );
});

test("signed releases use versioned local defaults while preserving explicit overrides", () => {
  expect(releaseOutputEnvironment("0.3.1", {})).toEqual({
    MCP_GATEWAY_BUILD_ROOT: "build/v0.3.1",
    MCP_GATEWAY_ARTIFACTS_DIR: "artifacts/v0.3.1",
  });
  expect(releaseOutputEnvironment("2.5.0", { PATH: "existing" })).toEqual({
    PATH: "existing",
    MCP_GATEWAY_BUILD_ROOT: "build/v2.5.0",
    MCP_GATEWAY_ARTIFACTS_DIR: "artifacts/v2.5.0",
  });
  expect(
    releaseOutputEnvironment("0.3.1", {
      MCP_GATEWAY_BUILD_ROOT: "build/private",
      MCP_GATEWAY_ARTIFACTS_DIR: "artifacts/private",
    }),
  ).toEqual({
    MCP_GATEWAY_BUILD_ROOT: "build/private",
    MCP_GATEWAY_ARTIFACTS_DIR: "artifacts/private",
  });
  expect(releaseOutputEnvironment("0.3.1", { MCP_GATEWAY_BUILD_ROOT: "build/private" })).toEqual({
    MCP_GATEWAY_BUILD_ROOT: "build/private",
    MCP_GATEWAY_ARTIFACTS_DIR: "artifacts/v0.3.1",
  });
  expect(
    releaseOutputEnvironment("0.3.1", { MCP_GATEWAY_ARTIFACTS_DIR: "artifacts/private" }),
  ).toEqual({
    MCP_GATEWAY_BUILD_ROOT: "build/v0.3.1",
    MCP_GATEWAY_ARTIFACTS_DIR: "artifacts/private",
  });
  for (const version of ["../outside", "0.3.1-beta", "01.2.3", ""]) {
    expect(() => releaseOutputEnvironment(version, {})).toThrow("Invalid release version");
  }
});

test("release guard accepts missing or empty destinations without modifying them", async () => {
  const root = await testDirectory();
  try {
    await expect(assertEmptyReleaseArtifacts(root, {})).resolves.toBeUndefined();
    expect(await readdir(root)).toEqual([]);
    const folder = join(root, "empty");
    await mkdir(folder);
    await expect(
      assertEmptyReleaseArtifacts(root, { MCP_GATEWAY_ARTIFACTS_DIR: "empty" }),
    ).resolves.toBeUndefined();
    expect(await readdir(folder)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release guard refuses populated default and custom destinations without changing bytes", async () => {
  const root = await testDirectory();
  try {
    for (const [name, env] of [
      ["artifacts", {}],
      ["candidate", { MCP_GATEWAY_ARTIFACTS_DIR: "candidate" }],
    ] as const) {
      const folder = join(root, name);
      await mkdir(folder);
      const asset = join(folder, ".retained");
      await writeFile(asset, "signed bytes");
      await expect(assertEmptyReleaseArtifacts(root, env)).rejects.toThrow("not empty");
      expect(await readFile(asset, "utf8")).toBe("signed bytes");
      expect(await readdir(folder)).toEqual([".retained"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release guard preserves files in the versioned default directory", async () => {
  const root = await testDirectory();
  try {
    const environment = releaseOutputEnvironment("0.3.1", {});
    const folder = join(root, environment.MCP_GATEWAY_ARTIFACTS_DIR);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "retained"), "signed bytes");
    await expect(assertEmptyReleaseArtifacts(root, environment)).rejects.toThrow("not empty");
    expect(await readFile(join(folder, "retained"), "utf8")).toBe("signed bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signed build entrypoint selects versioned defaults before preparation", async () => {
  const script = `
    import { mock } from "bun:test";
    import { resolve } from "node:path";
    import packageInfo from "./package.json";
    const output = await import("./scripts/release-output.ts");
    mock.module(resolve("scripts/build-platform.ts"), () => ({
      buildPlan: () => ({ signed: true, macNative: false, arguments: [] }),
    }));
    mock.module(resolve("scripts/toolchain.ts"), () => ({
      toolchainEnvironment: {},
      prepareToolchain: () => { throw new Error("PREPARATION_EXECUTED"); },
      command: () => { throw new Error("COMMAND_EXECUTED"); },
    }));
    mock.module(resolve("scripts/release-output.ts"), () => ({
      ...output,
      assertEmptyReleaseArtifacts: async (_root, env) => {
        if (env.MCP_GATEWAY_BUILD_ROOT !== "build/v" + packageInfo.version ||
            env.MCP_GATEWAY_ARTIFACTS_DIR !== "artifacts/v" + packageInfo.version)
          throw new Error("WRONG_OUTPUT_DEFAULTS");
        throw new Error("VERSIONED_OUTPUT_CHECKED");
      },
    }));
    process.argv[2] = "stable";
    try {
      await import("./scripts/build.ts");
      throw new Error("BUILD_UNEXPECTEDLY_COMPLETED");
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "VERSIONED_OUTPUT_CHECKED") throw error;
      console.log("VERSIONED_OUTPUT_CHECKED");
    }
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: resolve("."),
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(10_000),
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(stdout.trim()).toBe("VERSIONED_OUTPUT_CHECKED");
  expect(stderr).toBe("");
}, 15_000);

test("signed build entrypoint refuses populated output before toolchain preparation", async () => {
  const root = await testDirectory();
  try {
    const folder = join(root, "assets");
    await mkdir(folder);
    await writeFile(join(folder, "retained"), "signed bytes");
    const script = `
      import { mock } from "bun:test";
      import { resolve } from "node:path";
      mock.module(resolve("scripts/build-platform.ts"), () => ({
        buildPlan: () => ({ signed: true, macNative: false, arguments: [] }),
      }));
      mock.module(resolve("scripts/toolchain.ts"), () => ({
        toolchainEnvironment: process.env,
        prepareToolchain: () => { throw new Error("PREPARATION_EXECUTED"); },
        command: () => { throw new Error("COMMAND_EXECUTED"); },
      }));
      process.argv[2] = "stable";
      try {
        await import("./scripts/build.ts");
        throw new Error("BUILD_UNEXPECTEDLY_COMPLETED");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("not empty")) throw error;
        console.log("REFUSED_BEFORE_PREPARATION");
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: resolve("."),
      env: { PATH: process.env.PATH ?? "", MCP_GATEWAY_ARTIFACTS_DIR: folder },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(10_000),
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("REFUSED_BEFORE_PREPARATION");
    expect(stderr).toBe("");
    expect(await readFile(join(folder, "retained"), "utf8")).toBe("signed bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("signed build rechecks output after preparation before spawning the SDK", async () => {
  const root = await testDirectory();
  try {
    const folder = join(root, "assets");
    await mkdir(folder);
    const script = `
      import { mock } from "bun:test";
      import { resolve, join } from "node:path";
      const realFs = { ...await import("node:fs/promises") };
      mock.module("node:fs/promises", () => ({
        ...realFs,
        mkdir: async () => {},
        copyFile: async () => {},
        writeFile: async () => {},
      }));
      mock.module(resolve("scripts/build-platform.ts"), () => ({
        buildPlan: () => ({ signed: true, macNative: false, arguments: [] }),
      }));
      mock.module(resolve("scripts/toolchain.ts"), () => ({
        toolchainEnvironment: process.env,
        prepareToolchain: () => realFs.writeFile(join(process.env.MCP_GATEWAY_ARTIFACTS_DIR, "retained"), "signed bytes"),
        command: async () => {},
      }));
      let starts = 0;
      Bun.spawn = () => {
        if (++starts !== 1) throw new Error("SIGNED_BUILD_SPAWNED");
        return {
          stdout: new Response('1) ' + 'A'.repeat(40) + ' "Developer ID Application: synthetic"').body,
          exited: Promise.resolve(0),
        };
      };
      process.argv[2] = "stable";
      try {
        await import("./scripts/build.ts");
        throw new Error("BUILD_UNEXPECTEDLY_COMPLETED");
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("not empty") || starts !== 1) throw error;
        console.log("REFUSED_BEFORE_SDK");
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: resolve("."),
      env: {
        PATH: process.env.PATH ?? "",
        MCP_GATEWAY_ARTIFACTS_DIR: folder,
        APPLE_ID: "synthetic",
        APPLE_TEAM_ID: "synthetic",
        APPLE_APP_PASSWORD: "synthetic",
      },
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(10_000),
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("REFUSED_BEFORE_SDK");
    expect(stderr).toBe("");
    expect(await readFile(join(folder, "retained"), "utf8")).toBe("signed bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("release guard refuses files and symlinks and propagates inspection errors", async () => {
  const root = await testDirectory();
  try {
    const file = join(root, "file");
    const directory = join(root, "directory");
    await writeFile(file, "untouched");
    await mkdir(directory);
    await symlink(directory, join(root, "alias"), "dir");
    await symlink(join(root, "missing"), join(root, "dangling"), "dir");
    for (const name of ["file", "alias", "dangling"]) {
      await expect(
        assertEmptyReleaseArtifacts(root, { MCP_GATEWAY_ARTIFACTS_DIR: name }),
      ).rejects.toThrow("not a plain directory");
    }
    await expect(
      assertEmptyReleaseArtifacts(root, { MCP_GATEWAY_ARTIFACTS_DIR: "file/child" }),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(await readFile(file, "utf8")).toBe("untouched");
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
