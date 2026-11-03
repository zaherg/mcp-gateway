import { dlopen } from "bun:ffi";
import { closeSync, constants as fsConstants, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { ensureParent } from "../../core/private-parent";
import { UpdaterStateError } from "./storage";

export const KERNEL_GUARD_FILE = ".mcp-gateway-update-guard";
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const F_GETFD = 1;
const FD_CLOEXEC = 1;
function loadKernelApi() {
  if (process.platform !== "darwin") throw new UpdaterStateError("guardPlatform");
  return dlopen("libSystem.B.dylib", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    fcntl: { args: ["i32", "i32"], returns: "i32" },
  });
}
let kernelApi: ReturnType<typeof loadKernelApi> | undefined;

export interface KernelGuard {
  readonly path: string;
  release(): Promise<void>;
  releaseSync(): void;
  isHeld(): boolean;
}

export async function acquireKernelGuard(channelRoot: string): Promise<KernelGuard> {
  if (!kernelApi) kernelApi = loadKernelApi();
  const libSystem = kernelApi;
  const path = join(channelRoot, KERNEL_GUARD_FILE);
  await ensureParent(path);
  const fd = openSync(
    path,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    )
      throw new UpdaterStateError("guardFile");
    const flags = libSystem.symbols.fcntl(fd, F_GETFD);
    if (flags < 0 || (flags & FD_CLOEXEC) === 0) throw new UpdaterStateError("guardCloseOnExec");
    if (libSystem.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0)
      throw new UpdaterStateError("guardBusy");
    let released = false;
    const releaseSync = (): void => {
      if (released) return;
      released = true;
      try {
        libSystem.symbols.flock(fd, LOCK_UN);
      } finally {
        closeSync(fd);
      }
    };
    return {
      path,
      async release() {
        releaseSync();
      },
      releaseSync,
      isHeld: () => !released,
    };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    throw error;
  }
}
