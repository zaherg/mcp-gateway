import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PREPARED_UPDATE_FILE, UPDATER_FEED_URL } from "../../src/main/updater/constants";
import { runUpdaterWorker, waitForGrant } from "../../src/main/updater/worker";

const root = process.env.SDK_CONTRACT_ROOT;
const endpoint = process.env.SDK_CONTRACT_ORIGIN;
const mode = process.env.SDK_CONTRACT_MODE;
if (!root || !endpoint || !mode) throw new Error("Missing SDK contract fixture inputs");
if (!["prepare", "veto"].includes(mode)) throw new Error("Invalid SDK contract fixture mode");
const project = await realpath(resolve(import.meta.dir, "../.."));
if (!(await realpath(root)).startsWith(`${project}/.cache/`))
  throw new Error("SDK contract fixture must remain project-local");
if (process.env.HOME !== join(root, "home") || process.env.TMPDIR !== join(root, "tmp"))
  throw new Error("SDK contract fixture roots do not match");
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
  throw new Error("SDK contract feed must be ephemeral loopback HTTP");
const feed = new URL(UPDATER_FEED_URL);
const allowedNames = new Set([
  "stable-macos-arm64-update.json",
  "stable-macos-arm64-MCPGateway.app.tar.zst",
]);
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (
    url.origin !== feed.origin ||
    !allowedNames.has(url.pathname.slice(feed.pathname.length + 1)) ||
    !url.pathname.startsWith(`${feed.pathname}/`)
  )
    throw new Error("SDK contract fixture refused unexpected network access");
  return nativeFetch(new URL(url.pathname + url.search, origin), { ...init, redirect: "error" });
}, nativeFetch);

// Admission and process-group ownership are supplied by the production parent.
assert.equal(await waitForGrant(process.env), true);
delete process.env.MCP_GATEWAY_UPDATE_GRANT;
const { default: Electrobun, Updater } = await import("electrobun/main");
const events: unknown[] = [];
Updater.onStatusChange((entry) => {
  if (events.length >= 200) throw new Error("SDK contract status bound exceeded");
  events.push(entry);
  appendFileSync(join(root, "statuses.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
});
const record: Record<string, unknown> = { mode };
if (mode === "veto") {
  const local = await Updater.getLocalInfo();
  assert.deepEqual(local, JSON.parse(await readFile(join(root, "Resources/version.json"), "utf8")));
  const channel = await Updater.appDataFolder();
  assert.equal(channel, process.env.MCP_GATEWAY_UPDATE_CHANNEL_ROOT);
  const available = await Updater.checkForUpdate();
  assert.equal(available.updateAvailable, true);
  assert.equal(available.updateReady, false);
  assert.equal(available.error, "");
  await Updater.downloadUpdate();
  assert.equal(Updater.updateInfo().updateReady, true);
  assert.equal(Updater.updateInfo().error, "");
  const preparedPath = join(channel, "self-extraction", PREPARED_UPDATE_FILE);
  const preparedBefore = await readFile(preparedPath);
  let vetoes = 0;
  const veto = (event: { response: { allow: boolean } | undefined }) => {
    vetoes++;
    event.response = { allow: false };
  };
  Electrobun.events.on("before-quit", veto);
  try {
    await Updater.applyUpdate();
    assert.equal(vetoes, 1);
    assert.equal(Updater.updateInfo().updateReady, true);
    assert.equal(Updater.getStatusHistory().at(-1)?.status, "idle");
    assert.deepEqual(await readFile(preparedPath), preparedBefore);
  } finally {
    Electrobun.events.off("before-quit", veto);
  }
  record.vetoes = vetoes;
  record.info = Updater.updateInfo();
  await writeFile(
    process.env.MCP_GATEWAY_UPDATE_RESULT ?? "",
    JSON.stringify({ status: "no-update" }),
    { mode: 0o600 },
  );
} else {
  record.exitCode = await runUpdaterWorker("prepare");
  record.info = Updater.updateInfo();
}
record.statusCount = events.length;
await writeFile(join(root, "contract.json"), JSON.stringify(record), { mode: 0o600 });
Updater.onStatusChange(null);
process.exit(typeof record.exitCode === "number" ? record.exitCode : 0);
