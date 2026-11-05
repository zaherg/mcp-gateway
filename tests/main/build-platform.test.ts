import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildPlan, validateBuildHost } from "../../scripts/build-platform";
import { createToolchainEnvironment } from "../../scripts/toolchain";

test("linux and windows builds select unsigned native packaging without macOS overrides", () => {
  for (const [mode, platform] of [
    ["linux", "linux"],
    ["windows", "win32"],
  ] as const) {
    for (const architecture of ["x64", "arm64"]) {
      expect(buildPlan(mode, platform, architecture)).toEqual({
        macNative: false,
        signed: false,
        arguments: ["build", "--env=stable"],
      });
      const environment = createToolchainEnvironment(platform, architecture, {});
      expect(environment.HUTCH_ELECTROBUN_DEVKIT_ROOT).toBeUndefined();
      expect(environment.COTTONTAIL_BINARY).toBeUndefined();
      expect(environment.HUTCH_HOME).toBe(resolve(".hutch-home"));
      expect(environment.BUN_INSTALL_CACHE_DIR).toBe(resolve(".cache/bun"));
      expect(environment.TMPDIR).toBe(resolve(".cache/tmp"));
      expect(environment.TMP).toBe(environment.TMPDIR);
      expect(environment.TEMP).toBe(environment.TMPDIR);
    }
  }
});

test("macOS development and signed-release routing stays unchanged", () => {
  expect(buildPlan("dev", "darwin", "arm64")).toEqual({
    macNative: true,
    signed: false,
    arguments: ["dev"],
  });
  expect(buildPlan("dev-build", "darwin", "arm64")).toEqual({
    macNative: true,
    signed: false,
    arguments: ["build", "--env=dev"],
  });
  expect(buildPlan("stable", "darwin", "arm64")).toEqual({
    macNative: true,
    signed: true,
    arguments: ["build", "--env=stable"],
  });
  const environment = createToolchainEnvironment("darwin", "arm64", {});
  expect(environment.HUTCH_ELECTROBUN_DEVKIT_ROOT).toBe(
    resolve(".cache/toolchain/electrobun-2.0.5"),
  );
  expect(environment.COTTONTAIL_BINARY).toBe(
    resolve(".cache/toolchain/cottontail-0.7.3/cottontail-v0.7.3-macos-arm64/bin/cottontail"),
  );
});

test("explicit native commands reject cross-compilation and non-macOS signing", () => {
  expect(() => buildPlan("linux", "darwin", "arm64")).toThrow("must run on Linux");
  expect(() => buildPlan("linux", "win32", "x64")).toThrow("must run on Linux");
  expect(() => buildPlan("windows", "darwin", "arm64")).toThrow("must run on Windows");
  expect(() => buildPlan("windows", "linux", "x64")).toThrow("must run on Windows");
  for (const platform of ["linux", "win32"] as const)
    expect(() => buildPlan("stable", platform, "x64")).toThrow("signed macOS build");
});

test("unsupported hosts and invalid command modes fail before preparing tools", () => {
  for (const [platform, architecture] of [
    ["darwin", "x64"],
    ["linux", "ia32"],
    ["win32", "ia32"],
    ["freebsd", "x64"],
  ] as const)
    expect(() => validateBuildHost(platform, architecture)).toThrow("Unsupported build host");
  for (const mode of [undefined, "", "release", "--platform=linux"])
    expect(() => buildPlan(mode, "darwin", "arm64")).toThrow("Choose stable");
});

test("toolchain environment preserves explicit overrides without mutating its input", () => {
  const input = {
    PATH: "synthetic-path",
    COTTONTAIL_BINARY: "explicit-native-binary",
    HUTCH_ELECTROBUN_DEVKIT_ROOT: "explicit-native-devkit",
    TEMP: "old-temp",
  };
  const environment = createToolchainEnvironment("win32", "x64", input);
  expect(environment.PATH).toBe(input.PATH);
  expect(environment.COTTONTAIL_BINARY).toBe(input.COTTONTAIL_BINARY);
  expect(environment.HUTCH_ELECTROBUN_DEVKIT_ROOT).toBe(input.HUTCH_ELECTROBUN_DEVKIT_ROOT);
  expect(input.TEMP).toBe("old-temp");
});
