import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type ConfigFormat, configFormat } from "../shared/config-document";
import { MAX_CONFIG_BYTES, newConfigText, parseConfig } from "./config";
import { failure, GatewayError } from "./errors";
import { ensureParent, safeParent } from "./private-parent";

export interface ConfigDocument {
  text: string;
  revision: string;
}
export const revisionOf = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

async function guarded<A>(work: () => Promise<A>): Promise<A> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw failure("ConfigIO", "Configuration file access failed.");
  }
}

function safeFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw failure(
      "UnsafeFile",
      "The configuration must be an owner-only regular file with no hard links.",
    );
}

export class ConfigStore {
  private selectedPath: string;
  private readonly jsonPath: string;
  private readonly jsoncPath: string;
  private selectionRefused = false;
  private initialized = false;
  constructor(path: string) {
    this.selectedPath = resolve(path);
    this.jsonPath = this.selectedPath.endsWith(".jsonc")
      ? this.selectedPath.slice(0, -1)
      : this.selectedPath;
    this.jsoncPath = `${this.jsonPath}c`;
  }

  get path(): string {
    return this.selectedPath;
  }
  get format(): ConfigFormat {
    return configFormat(this.path);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await fs.lstat(path);
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private async checkSelection(): Promise<void> {
    if (this.selectionRefused)
      throw failure(
        "AmbiguousConfig",
        "Both configuration files exist; keep only one and reopen the app.",
      );
    const alternate = this.path === this.jsonPath ? this.jsoncPath : this.jsonPath;
    if (await this.exists(alternate)) {
      if (await this.exists(this.path))
        throw failure(
          "AmbiguousConfig",
          "Both configuration files exist; keep only one and reopen the app.",
        );
      throw failure("ConfigIO", "The configuration filename changed; reopen the app to select it.");
    }
  }

  read(): Promise<ConfigDocument> {
    return guarded(async () => {
      await safeParent(this.path);
      await this.checkSelection();
      const entry = await fs.lstat(this.path);
      if (entry.isSymbolicLink())
        throw failure("UnsafeFile", "Symlinked configuration files are refused.");
      const handle = await fs.open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const before = await handle.stat();
        safeFile(before);
        if (before.ino !== entry.ino || before.dev !== entry.dev)
          throw failure("UnsafeFile", "The configuration file changed during access.");
        if (before.size > MAX_CONFIG_BYTES)
          throw failure("InvalidConfig", "Configuration exceeds the size limit.");
        const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await handle.stat();
        if (length > MAX_CONFIG_BYTES)
          throw failure("InvalidConfig", "Configuration exceeds the size limit.");
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw failure("ConfigIO", "The configuration changed during access.");
        const bytes = buffer.subarray(0, length);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw failure("InvalidConfig", "Configuration must contain valid UTF-8.");
        }
        await this.checkSelection();
        return { text, revision: revisionOf(bytes) };
      } finally {
        await handle.close();
      }
    });
  }

  private async locked<A>(work: () => Promise<A>): Promise<A> {
    await safeParent(this.path);
    const lockPath = `${this.jsonPath}.lock`;
    let lock: fs.FileHandle;
    try {
      lock = await fs.open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw failure("ConfigLocked", "Another writer holds the configuration lock.");
      throw error;
    }
    try {
      return await work();
    } finally {
      try {
        await lock.close();
      } finally {
        await fs.unlink(lockPath);
      }
    }
  }

  private async replace(text: string, create: boolean): Promise<void> {
    const temp = join(dirname(this.path), `.${basename(this.path)}.${randomUUID()}.tmp`);
    const file = await fs.open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    let failed: { error: unknown } | undefined;
    try {
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      if (create) {
        await fs.link(temp, this.path);
        await fs.unlink(temp);
      } else {
        await fs.rename(temp, this.path);
      }
      const directory = await fs.open(
        dirname(this.path),
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      failed = { error };
    } finally {
      try {
        await fs.unlink(temp);
      } catch (error) {
        if (!missing(error) && !failed) failed = { error };
      }
    }
    if (failed) throw failed.error;
  }

  initialize(): Promise<ConfigDocument> {
    if (this.initialized || this.selectionRefused) return this.read();
    return guarded(async () => {
      // Inspect each ancestor before creating owner-only directories; recursive
      // mkdir would follow a symlink before the policy check could reject it.
      await ensureParent(this.path);
      await this.locked(async () => {
        const json = await this.exists(this.jsonPath);
        const jsonc = await this.exists(this.jsoncPath);
        if (json && jsonc) {
          this.selectionRefused = true;
          throw failure(
            "AmbiguousConfig",
            "Both configuration files exist; keep only one and reopen the app.",
          );
        }
        this.selectedPath = jsonc ? this.jsoncPath : this.jsonPath;
        if (!json && !jsonc) await this.replace(newConfigText(), true);
        this.initialized = true;
      });
      return this.read();
    });
  }

  save(text: string, expectedRevision: string): Promise<ConfigDocument> {
    return guarded(() =>
      this.locked(async () => {
        await this.checkSelection();
        parseConfig(text, process.env, this.format);
        const current = await this.read();
        if (current.revision !== expectedRevision)
          throw failure("StaleRevision", "Configuration changed on disk; reload before saving.");
        if (current.text === text) return current;
        await this.checkSelection();
        await this.replace(text, false);
        return { text, revision: revisionOf(text) };
      }),
    );
  }
}
