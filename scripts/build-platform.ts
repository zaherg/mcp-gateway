export function validateBuildHost(platform: NodeJS.Platform, architecture: string): void {
  const supported =
    (platform === "darwin" && architecture === "arm64") ||
    ((platform === "linux" || platform === "win32") &&
      (architecture === "x64" || architecture === "arm64"));
  if (!supported) throw new Error(`Unsupported build host: ${platform}/${architecture}.`);
}

export function buildPlan(
  mode: string | undefined,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): { macNative: boolean; signed: boolean; arguments: string[] } {
  validateBuildHost(platform, architecture);
  if (!["stable", "dev", "dev-build", "linux", "windows"].includes(mode ?? ""))
    throw new Error("Choose stable, dev, dev-build, linux, or windows.");
  if (mode === "linux" && platform !== "linux")
    throw new Error("build:linux must run on Linux; cross-compilation is not supported.");
  if (mode === "windows" && platform !== "win32")
    throw new Error("build:windows must run on Windows; cross-compilation is not supported.");
  if (mode === "stable" && platform !== "darwin")
    throw new Error("release is the signed macOS build. Use build:linux or build:windows instead.");
  return {
    macNative: platform === "darwin",
    signed: mode === "stable",
    arguments:
      mode === "dev" ? ["dev"] : ["build", `--env=${mode === "dev-build" ? "dev" : "stable"}`],
  };
}
