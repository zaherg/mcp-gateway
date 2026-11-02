import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// The native SDK is unavailable in the unit runner. Guard the actual menu wiring;
// physical Cmd+Q and native accelerator delivery require the rebuilt macOS app.
test("native Cmd+Q uses the same asynchronous QuitCoordinator path as menu Quit", async () => {
  const source = await readFile(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  expect(source).toContain('{ label: "Quit MCP Gateway", action: "quit", accelerator: "Cmd+Q" }');
  expect(source).toMatch(/case "quit":\s*Utils\.quit\(\);/);
  expect(source).toMatch(/Electrobun\.events\.on\("before-quit",[\s\S]*?quit\.handle/);
  expect(source).toMatch(/new QuitCoordinator\([\s\S]*?await controller\.close\(\)/);
  expect(source).toMatch(
    /controller\.recordLocalError\(error\);\s*console\.error\([^\n]+\);\s*updateMenu\(\);\s*\/\/[^\n]+\s*openWindow\(\);/,
  );
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
