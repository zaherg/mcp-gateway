import type { CommandResult } from "../../src/main/updater/verify";

export interface MacOSCompatibilityFixture {
  plist?: Record<string, unknown>;
  hostVersion?: string;
  buildVersion?: string;
}

export function macOSCompatibilityCommand(
  command: string,
  args: readonly string[],
  fixture: MacOSCompatibilityFixture = {},
): CommandResult | undefined {
  let stdout: string;
  if (command.endsWith("plutil") && args.includes("-convert"))
    stdout = JSON.stringify(fixture.plist ?? {});
  else if (command.endsWith("sw_vers")) stdout = fixture.hostVersion ?? "14.0";
  else if (command.endsWith("vtool"))
    stdout =
      fixture.buildVersion ??
      "fixture (architecture arm64):\nLoad command 13\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform MACOS\n    minos 14.0\n      sdk 27.0\n   ntools 1\n     tool 5\n  version 0.0\n";
  else return undefined;
  return { stdout, stderr: "", exitCode: 0 };
}
