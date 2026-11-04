import { dlopen, FFIType } from "bun:ffi";
import type { DesktopPlatform } from "../shared/rpc";

export function observeNativeQuitSignals(platform: DesktopPlatform, path: string): () => boolean {
  if (platform !== "macos") return () => false;
  const library = dlopen(path, {
    mcp_quit_signal_install: { args: [], returns: FFIType.i32 },
    mcp_quit_signal_requested: { args: [], returns: FFIType.i32 },
  });
  // This separate reference lives until process exit: signal handlers must remain
  // mapped even after the login owner closes its own reference during cleanup.
  if (library.symbols.mcp_quit_signal_install() !== 0)
    throw new Error("Native Quit signal observation could not be installed.");
  return () => library.symbols.mcp_quit_signal_requested() !== 0;
}
