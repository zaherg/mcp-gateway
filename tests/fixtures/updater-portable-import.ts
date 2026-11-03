export {};

const { UpdaterSafetyBoundary } = await import("../../src/main/updater/boundary");
Object.assign(globalThis, { portableRuntimeBoundary: UpdaterSafetyBoundary });
const { UpdaterCoordinator } = await import("../../src/main/updater/coordinator");
await import("../../src/main/service");
const { readUpdateSupport } = await import("../../src/main/updater/support");
const support = await readUpdateSupport({
  platform: "linux",
  architecture: "x64",
  appBundlePath: "/synthetic/MCP Gateway.app",
  isolated: false,
});
const coordinator = new UpdaterCoordinator({
  dataDirectory: "/synthetic/no-io",
  supported: support.supported,
  installedVersion: support.installedVersion,
});
const status = await coordinator.start();
if (status.supported || status.phase !== "unsupported")
  throw new Error("Unsupported updater import acquired native runtime");
console.log("unsupported-import-native-loads=0");
