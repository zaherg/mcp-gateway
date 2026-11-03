import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// The native SDK is unavailable in the unit runner. Guard the actual menu wiring;
// physical Cmd+Q and native accelerator delivery require the rebuilt macOS app.
test("native Cmd+Q uses the same asynchronous QuitCoordinator path as menu Quit", async () => {
  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  expect(source).toContain('{ label: "Quit MCP Gateway", action: "quit", accelerator: "Cmd+Q" }');
  expect(source).toContain('{ label: "Check for Updates…", action: "updates" }');
  expect(source).toMatch(/case "updates":\s*showUpdatesSection\(\);/);
  expect(source).toContain('window.dispatchEvent(new Event("mcp-gateway:show-updates"))');
  expect(source).toMatch(/const updateLabel =[\s\S]*?action: "updates"/);
  expect(source).toMatch(/pendingShowUpdates/);
  expect(source).toMatch(/case "quit":\s*quit\?\.armQuit\(\);\s*Utils\.quit\(\);/);
  expect(source).toMatch(/Electrobun\.events\.on\("before-quit",[\s\S]*?quit\.handle/);
  expect(source).toMatch(/new QuitCoordinator\([\s\S]*?await controller\.close\(\)/);
  expect(source).toMatch(
    /\(error, kind, settlement\) => \{[\s\S]*?controller\.recordLocalError\(error\);[\s\S]*?updateMenu\(\);[\s\S]*?openWindow\(\);/,
  );
  expect(source).toMatch(/reserveUpdate: \(candidate\) => quit\?\.reserveUpdate\(candidate\)/);
  expect(source).toMatch(/acceptUpdateRestart\(attempt\)/);
  expect(source).toMatch(/quit\?\.armQuit\(\)/);
});

test("late or recreated renderer readiness completes updater startup once without a fixed startup wait", async () => {
  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  expect(source).toMatch(
    /function completeUpdateStartup\(\)[\s\S]*?updateStartup \?\?= \(async \(\) => \{\s*await updates\.completeInitialization\(\);/,
  );
  expect(source).toMatch(
    /snapshot: async[\s\S]*?if \(!ready\) \{[\s\S]*?void completeUpdateStartup\(\);/,
  );
  expect(source).toContain("if (!window) await completeUpdateStartup();");
  expect(source).not.toContain("if (window) await waitForNativeWindow(() => windowReady);");
});

test("Cmd+W closes only the current window and its isolated Cocoa probe queues app-local input", async () => {
  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  expect(source).toMatch(
    /label: "File",[\s\S]*?label: "Close Window",[\s\S]*?action: "close-window",[\s\S]*?accelerator: "Cmd\+W"/,
  );
  const close = source.slice(
    source.indexOf('case "close-window":'),
    source.indexOf('case "quit":'),
  );
  expect(close).toContain("window?.close();");
  expect(close).not.toMatch(/Utils\.quit|controller\.close/);
  expect(source).toContain("login.requestCloseShortcut()");
  expect(source).toContain("after.generation === beforeClose.generation");
  const probe = await readFile(new URL("../../src/native/probe.m", import.meta.url), "utf8");
  expect(probe).toContain("mcp_test_close_shortcut");
  expect(probe).toContain('characters:@"w"');
  expect(probe).toContain("[app postEvent:event atStart:NO]");
  expect(probe).not.toMatch(/CGEvent|AXIsProcessTrusted|sendEvent:/);
});
