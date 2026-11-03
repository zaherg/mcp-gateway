import { appendFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inventoryBundle } from "../../scripts/release-inventory";
import { UPDATER_ARTIFACT_FILE, UPDATER_FEED_URL } from "../../src/main/updater/constants";
import { readVersionMetadata } from "../../src/main/updater/verify";
import { runUpdaterWorker } from "../../src/main/updater/worker";

// Test-only network routing; SDK methods, streaming writes and native execution are unchanged.
const root = process.env.SDK_LIMIT_CASE_ROOT;
const endpoint = process.env.SDK_LIMIT_ORIGIN;
if (!root || !endpoint || !resolve(root).startsWith(`${resolve(import.meta.dir, "../../.cache")}/`))
  throw new Error("Expected an isolated project-local SDK limit fixture");
if (process.env.HOME !== join(root, "home") || process.env.TMPDIR !== join(root, "tmp"))
  throw new Error("SDK limit fixture roots do not match");
const origin = new URL(endpoint);
if (
  origin.protocol !== "http:" ||
  origin.hostname !== "127.0.0.1" ||
  !origin.port ||
  origin.username ||
  origin.password ||
  origin.pathname !== "/" ||
  origin.search ||
  origin.hash
)
  throw new Error("Expected an ephemeral loopback feed");
const nativeFetch = globalThis.fetch;
const allowedPaths = new Set([
  `${new URL(UPDATER_FEED_URL).pathname}/stable-macos-arm64-update.json`,
  `${new URL(UPDATER_FEED_URL).pathname}/${UPDATER_ARTIFACT_FILE}`,
]);
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== "https://github.com" || !allowedPaths.has(url.pathname))
      throw new Error("SDK fixture refused an unexpected network request");
    return nativeFetch(new URL(`${url.pathname}${url.search}`, origin), {
      ...init,
      redirect: "error",
    }).then((response) => {
      appendFileSync(
        join(root, "http-responses.jsonl"),
        `${JSON.stringify({
          path: url.pathname,
          contentLength: response.headers.get("content-length"),
          transferEncoding: response.headers.get("transfer-encoding"),
        })}\n`,
        { mode: 0o600 },
      );
      return response;
    });
  },
  nativeFetch,
);

const { Updater, Utils } = await import("electrobun/main");
if (process.env.SDK_LIMIT_ROOT_PROBE === "1") {
  const modern = join(root, "home/Library/Application Support/dev.srvr.mcpgateway/stable");
  const legacy = join(root, "home/Library/Application Support/dev.srvr.mcpgateway/MCPGateway");
  for (const channel of [modern, legacy]) {
    await mkdir(join(channel, "self-extraction"), { recursive: true, mode: 0o700 });
    await writeFile(join(channel, "self-extraction/current1234.tar"), "current-base", {
      mode: 0o600,
    });
  }
  await writeFile(join(modern, ".electrobun-uninstall.json"), "{}", { mode: 0o600 });
  const info = await readVersionMetadata(join(root, "Resources/version.json"));
  const resolveRoot = () =>
    join(
      Utils.paths.appData,
      info.identifier,
      Utils.resolveInstalledRootNameForPaths(info, "macos", process.execPath, Utils.paths.appData),
    );
  const before = resolveRoot();
  await rm(join(modern, "self-extraction/current1234.tar"));
  const after = resolveRoot();
  const transactionId = "0123456789abcdef0123456789abcdef";
  await writeFile(
    join(legacy, `.electrobun-update-${transactionId}.result.json`),
    JSON.stringify({
      schema_version: 1,
      transaction_id: transactionId,
      success: true,
      phase: "complete",
      message: "Synthetic prior update",
      identifier: info.identifier,
      channel: info.channel,
      version: info.version,
      hash: info.hash,
    }),
    { mode: 0o600 },
  );
  const inventory = await inventoryBundle(legacy);
  await writeFile(
    join(root, "root-resolution.json"),
    JSON.stringify({ before, after, modern, legacy, inventory, transactionId }),
    { mode: 0o600 },
  );
  // Negative control demonstrates the write caused by the formerly unguarded getter.
  if (process.env.SDK_LIMIT_ROOT_CONTROL === "1") await Updater.getLocalInfo();
}
const statusPath = join(root, "sdk-status.jsonl");
let entries = 0;
if (process.env.SDK_LIMIT_ROOT_PROBE !== "1")
  Updater.onStatusChange((entry) => {
    if (++entries > 200) throw new Error("SDK fixture status limit exceeded");
    appendFileSync(
      statusPath,
      `${JSON.stringify({
        status: entry.status,
        ...(entry.details?.zstdPath ? { zstdPath: entry.details.zstdPath } : {}),
        ...(entry.details?.bytesDownloaded !== undefined
          ? { bytesDownloaded: entry.details.bytesDownloaded }
          : {}),
      })}\n`,
      { mode: 0o600 },
    );
  });
process.env.MCP_GATEWAY_UPDATE_CHANNEL_ROOT = join(
  root,
  "home/Library/Application Support/dev.srvr.mcpgateway/stable",
);
// No injected UpdaterSdk: exercise the production loader and budget checks.
const code = await runUpdaterWorker("prepare");
if (process.env.SDK_LIMIT_ROOT_PROBE === "1") {
  await new Promise<void>((done) => setTimeout(done, 0));
  await Promise.resolve();
}
process.exit(code);
