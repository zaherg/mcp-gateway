import type { ConfigFormat } from "../src/shared/config-document";
import type { DesktopPlatform } from "../src/shared/rpc";

export function nativeReport(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid native report.");
  return Object.fromEntries(Object.entries(value));
}

export function validateNativeReport(
  report: Record<string, unknown>,
  options: {
    platform: DesktopPlatform;
    format: ConfigFormat;
    fresh: boolean;
    signal: boolean;
    closed: boolean;
  },
): void {
  const { platform, format, fresh, signal, closed } = options;
  const linux = platform === "linux";
  // Older signed macOS payloads retain their existing report interpretation.
  const legacy = !linux && report.platform === undefined;
  const policy = nativeReport(report.viewportPolicy);
  if (
    policy.supported !== true ||
    policy.documentOverscroll !== "none" ||
    policy.bodyOverscroll !== "none" ||
    policy.bodyBackground !== "rgb(247, 249, 251)"
  )
    throw new Error("Native renderer scroll/canvas policy verification failed.");
  if (
    report.configFormat !== format ||
    report.configError !== null ||
    (fresh && (report.running !== false || report.serverCount !== 0))
  )
    throw new Error("Native configuration/default-state verification failed.");
  if (
    !legacy &&
    (report.platform !== platform ||
      report.smokeError !== null ||
      report.renderer !== (linux ? "WebKitGTK" : "WKWebView") ||
      report.shortcuts !== (linux ? "not-tested" : "Cocoa app-local"))
  )
    throw new Error("Native platform/report verification failed.");
  if (
    report.phase !== (closed ? "closed" : "ready") ||
    report.renderedWindows !== 2 ||
    report.closePreservedState !== true ||
    (!linux && report.closeShortcutHandled !== true) ||
    (linux &&
      (report.closeRequestedHandled !== true ||
        report.minimizeObserved !== true ||
        report.restoreObserved !== true ||
        report.closeShortcutHandled !== false ||
        report.shortcutHandled !== false ||
        report.nativeLoginStatus !== null ||
        report.loginSupported !== false))
  )
    throw new Error("Native close/restore/recreation verification failed.");
  if (
    closed &&
    (report.running !== false ||
      (signal
        ? report.quitMethod !== "SIGTERM"
        : linux
          ? report.quitRequested !== true || report.quitMethod !== "renderer"
          : report.shortcutHandled !== true))
  )
    throw new Error("Native graceful shutdown verification failed.");
}
