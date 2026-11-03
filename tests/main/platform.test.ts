import { expect, test } from "bun:test";
import { openLoginManager } from "../../src/main/login";
import {
  configurationDirectory,
  desktopPlatform,
  handleWindowClose,
  restoreWindow,
  startsInBackground,
} from "../../src/main/platform";

test("desktop selection refuses Windows before native login loading", () => {
  expect(desktopPlatform("darwin")).toBe("macos");
  expect(desktopPlatform("linux")).toBe("linux");
  for (const platform of ["win32", "freebsd", ""])
    expect(() => desktopPlatform(platform)).toThrow("only on macOS and Linux");
});

test("configuration directories retain macOS and select checked Linux XDG paths", () => {
  expect(configurationDirectory("macos", "/home/synthetic", { XDG_CONFIG_HOME: "ignored" })).toBe(
    "/home/synthetic/Library/Application Support/MCP Gateway",
  );
  expect(configurationDirectory("linux", "/home/synthetic", {})).toBe(
    "/home/synthetic/.config/MCP Gateway",
  );
  expect(configurationDirectory("linux", "/home/synthetic", { XDG_CONFIG_HOME: "/xdg" })).toBe(
    "/xdg/MCP Gateway",
  );
  for (const platform of ["linux", "macos"] as const) {
    expect(
      configurationDirectory(platform, "unused", {
        MCP_GATEWAY_DATA_DIR: "/isolated",
        MCP_GATEWAY_ISOLATED: "1",
      }),
    ).toBe("/isolated");
    expect(() => configurationDirectory(platform, "/home", { MCP_GATEWAY_ISOLATED: "1" })).toThrow(
      "explicit data directory",
    );
    for (const path of ["", "relative", "~/config", "/bad\0path"])
      expect(() =>
        configurationDirectory(platform, "/home", { MCP_GATEWAY_DATA_DIR: path }),
      ).toThrow("absolute path");
  }
  for (const path of ["", "relative", "~/config", "/bad\0path"])
    expect(() => configurationDirectory("linux", "/home", { XDG_CONFIG_HOME: path })).toThrow(
      "absolute path",
    );
  expect(() => configurationDirectory("linux", "relative", {})).toThrow("Home directory");
});

test("SDK config bases preserve the existing suffix and explicit isolated data location", () => {
  expect(
    configurationDirectory("macos", "/unused", {}, "/home/synthetic/Library/Application Support"),
  ).toBe("/home/synthetic/Library/Application Support/MCP Gateway");
  expect(configurationDirectory("linux", "/unused", {}, "/xdg/config")).toBe(
    "/xdg/config/MCP Gateway",
  );
  expect(
    configurationDirectory(
      "macos",
      "/unused",
      { MCP_GATEWAY_ISOLATED: "1", MCP_GATEWAY_DATA_DIR: "/isolated/data" },
      "/framework/config",
    ),
  ).toBe("/isolated/data");
  expect(() => configurationDirectory("macos", "/unused", {}, "relative")).toThrow("absolute path");
});

test("Linux login and Cocoa probes are explicitly unavailable without dlopen", () => {
  const login = openLoginManager("linux", "/nonexistent/login.dylib", true);
  expect(login.manager.status()).toEqual({
    enabled: false,
    supported: false,
    error: "Automatic login registration is unavailable on Linux.",
  });
  expect(login.manager.setEnabled(true)).toEqual(login.manager.status());
  expect(login.manager.setEnabled(false)).toEqual(login.manager.status());
  expect(login.statusCode()).toBeNull();
  expect(() => login.requestCloseShortcut()).toThrow("unavailable on Linux");
  expect(() => login.requestQuitShortcut()).toThrow("unavailable on Linux");
  login.close();
});

test("Linux starts visibly even with saved login/background preferences; macOS stays unchanged", () => {
  const login = { enabled: true, supported: false };
  expect(startsInBackground("linux", true, login, true)).toBe(false);
  expect(startsInBackground("macos", true, login, true)).toBe(true);
  expect(startsInBackground("macos", false, { enabled: false, supported: true }, false)).toBe(
    false,
  );
});

test("Linux native close vetoes before minimize, restoration presents the same window; macOS closes normally", () => {
  const event = { response: { allow: true } };
  const calls: string[] = [];
  const window = {
    minimize: () => {
      expect(event.response.allow).toBe(false);
      calls.push("minimize");
    },
    unminimize: () => {
      calls.push("unminimize");
    },
    show: () => {
      calls.push("show");
    },
    activate: () => {
      calls.push("activate");
    },
  };
  handleWindowClose("macos", event, window);
  expect(event.response.allow).toBe(true);
  expect(calls).toEqual([]);
  handleWindowClose("linux", event, window);
  restoreWindow(window);
  expect(calls).toEqual(["minimize", "unminimize", "show", "activate"]);
  expect(() => handleWindowClose("linux", null, window)).toThrow("Invalid native close event");
});
