import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  UPDATER_CHANNEL,
  UPDATER_FEED_URL,
  UPDATER_IDENTIFIER,
  UPDATER_STABLE_VERSION_PATTERN,
} from "./constants";
import { assertManagedDirectory } from "./storage";
import { ApplicationVerifier, type PublisherIdentity, readVersionMetadata } from "./verify";

type SdkMetadata = Awaited<ReturnType<typeof readVersionMetadata>>;

export type SdkRootNameResolver = (
  info: SdkMetadata,
  platform: "macos",
  executablePath: string,
  appDataDirectory: string,
) => string;

/** Updater getters schedule writes; use the SDK's pure resolver before calling them. */
export async function admitSdkRoot(
  channelRoot: string,
  appDataDirectory: string,
  resolveRootName: SdkRootNameResolver,
  versionPath = resolve("../Resources/version.json"),
): Promise<SdkMetadata> {
  if (
    !isAbsolute(channelRoot) ||
    !isAbsolute(appDataDirectory) ||
    channelRoot !== resolve(channelRoot) ||
    appDataDirectory !== resolve(appDataDirectory) ||
    channelRoot !== join(appDataDirectory, UPDATER_IDENTIFIER, UPDATER_CHANNEL)
  )
    throw new Error("Updater root is not the admitted stable directory");
  await assertManagedDirectory(channelRoot);
  await assertManagedDirectory(join(channelRoot, "self-extraction"));
  const info = await readVersionMetadata(versionPath);
  const rootName = resolveRootName(info, "macos", process.execPath, appDataDirectory);
  if (join(appDataDirectory, info.identifier, rootName) !== channelRoot)
    throw new Error("Updater root changed or is unsupported");
  return info;
}

export interface UpdateSupport {
  supported: boolean;
  installedVersion: string | null;
}

export interface UpdateSupportOptions {
  platform: "macos" | "linux";
  appBundlePath: string;
  architecture?: string;
  verifier?: Pick<ApplicationVerifier, "readPublisher">;
}

function unsupported(installedVersion: string | null = null): UpdateSupport {
  return { supported: false, installedVersion };
}

export async function readUpdateSupport(options: UpdateSupportOptions): Promise<UpdateSupport> {
  if (options.platform !== "macos" || (options.architecture ?? process.arch) !== "arm64")
    return unsupported();
  try {
    const document = JSON.parse(
      (await readFile(join(options.appBundlePath, "Contents/Resources/version.json"))).toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
    const version =
      typeof document.version === "string" && UPDATER_STABLE_VERSION_PATTERN.test(document.version)
        ? document.version
        : null;
    if (
      document.identifier !== UPDATER_IDENTIFIER ||
      document.channel !== UPDATER_CHANNEL ||
      document.baseUrl !== UPDATER_FEED_URL ||
      version === null
    )
      return unsupported(version);
    const [worker, script] = await Promise.all([
      lstat(join(options.appBundlePath, "Contents/MacOS/bun")),
      lstat(join(options.appBundlePath, "Contents/Resources/app/bun/index.js")),
    ]);
    if (worker.isSymbolicLink() || !worker.isFile() || script.isSymbolicLink() || !script.isFile())
      return unsupported(version);
    const verifier = options.verifier ?? new ApplicationVerifier();
    const publisher: PublisherIdentity = await verifier.readPublisher(options.appBundlePath);
    if (publisher.identifier !== UPDATER_IDENTIFIER) return unsupported(version);
    return { supported: true, installedVersion: version };
  } catch {
    return unsupported();
  }
}
