import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  freezePreparedCandidate,
  isHigherStableVersion,
  readPreparedUpdate,
  revalidateFrozenCandidate,
} from "../../src/main/updater/candidate";
import { appEntries, writeTarFixture } from "../fixtures/updater";

const HASH = "target123456";
const VERSION = "0.3.1";

async function setup(): Promise<{
  root: string;
  data: string;
  channel: string;
  archive: string;
  prepared: string;
}> {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/updater-candidate-"));
  const data = join(root, "data");
  const channel = join(root, "home/Library/Application Support/dev.srvr.mcpgateway/stable");
  const archives = join(channel, "self-extraction");
  await mkdir(data, { recursive: true, mode: 0o700 });
  await mkdir(archives, { recursive: true, mode: 0o700 });
  const archive = join(archives, `${HASH}.tar`);
  writeTarFixture(archive, appEntries({ version: VERSION, hash: HASH }));
  const prepared = join(archives, ".electrobun-prepared-update.json");
  await writeFile(
    prepared,
    `${JSON.stringify({
      schema_version: 1,
      identifier: "dev.srvr.mcpgateway",
      channel: "stable",
      version: VERSION,
      hash: HASH,
      platform: "macos",
      arch: "arm64",
      retained_tar_path: archive,
      artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
    })}\n`,
    { mode: 0o600 },
  );
  return { root, data, channel, archive, prepared };
}

test("compares only strict stable versions and rejects downgrades, equal versions, and prereleases", () => {
  expect(isHigherStableVersion("0.3.0", "0.3.1")).toBe(true);
  expect(isHigherStableVersion("0.3.1", "0.3.1")).toBe(false);
  expect(isHigherStableVersion("0.3.2", "0.3.1")).toBe(false);
  expect(isHigherStableVersion("0.3.0", "0.3.1-beta.1")).toBe(false);
  expect(isHigherStableVersion("v0.3.0", "0.3.1")).toBe(false);
  expect(isHigherStableVersion("0.3.0", "0.4")).toBe(false);
});

test("freezes a prepared archive and revalidates exact retained bytes and record", async () => {
  const fixture = await setup();
  try {
    const prepared = await readPreparedUpdate(fixture.channel);
    expect(prepared.hash).toBe(HASH);
    const frozen = await freezePreparedCandidate({
      channelRoot: fixture.channel,
      dataDirectory: fixture.data,
      selected: { version: VERSION, hash: HASH },
    });
    expect(frozen.candidate.archive_bytes).toBe((await readFile(fixture.archive)).byteLength);
    expect(frozen.candidate.archive_sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      revalidateFrozenCandidate(fixture.channel, fixture.data, {
        version: VERSION,
        hash: HASH,
      }),
    ).resolves.toMatchObject({ hash: HASH, archive_sha256: frozen.candidate.archive_sha256 });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a prepared record whose version or hash differs from the selected release", async () => {
  const fixture = await setup();
  try {
    for (const selected of [
      { version: "0.3.2", hash: HASH },
      { version: VERSION, hash: "other123456" },
    ]) {
      await expect(
        freezePreparedCandidate({
          channelRoot: fixture.channel,
          dataDirectory: fixture.data,
          selected,
        }),
      ).rejects.toThrow();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("detects retained archive tampering after freeze", async () => {
  const fixture = await setup();
  try {
    await freezePreparedCandidate({
      channelRoot: fixture.channel,
      dataDirectory: fixture.data,
      selected: { version: VERSION, hash: HASH },
    });
    await writeFile(
      fixture.archive,
      Buffer.concat([await readFile(fixture.archive), Buffer.from("x")]),
    );
    await expect(
      revalidateFrozenCandidate(fixture.channel, fixture.data, {
        version: VERSION,
        hash: HASH,
      }),
    ).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("detects a prepared record rewrite after freeze", async () => {
  const fixture = await setup();
  try {
    await freezePreparedCandidate({
      channelRoot: fixture.channel,
      dataDirectory: fixture.data,
      selected: { version: VERSION, hash: HASH },
    });
    const document = JSON.parse(await readFile(fixture.prepared, "utf8"));
    await writeFile(fixture.prepared, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await expect(
      revalidateFrozenCandidate(fixture.channel, fixture.data, {
        version: VERSION,
        hash: HASH,
      }),
    ).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects prepared records with extra fields, unsafe artifact names, or non-canonical paths", async () => {
  const fixture = await setup();
  try {
    const base = JSON.parse(await readFile(fixture.prepared, "utf8"));
    for (const change of [
      { extra: true },
      { artifact_file: "other.tar.zst" },
      { retained_tar_path: `${fixture.archive}/../target` },
      { arch: "x64" },
      { version: "0.3.1-beta.1" },
    ]) {
      await writeFile(fixture.prepared, `${JSON.stringify({ ...base, ...change })}\n`, {
        mode: 0o600,
      });
      await expect(readPreparedUpdate(fixture.channel)).rejects.toThrow();
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses an oversized prepared archive before copying or publishing frozen state", async () => {
  const fixture = await setup();
  try {
    await expect(
      freezePreparedCandidate({
        channelRoot: fixture.channel,
        dataDirectory: fixture.data,
        selected: { version: "0.3.1", hash: HASH },
        limits: {
          maxArchiveBytes: 1024,
          maxEntries: 100,
          maxEntryBytes: 1024,
          maxTotalBytes: 4096,
          maxPathBytes: 255,
        },
      }),
    ).rejects.toThrow();
    await expect(
      import("node:fs/promises").then(({ readdir }) =>
        readdir(join(fixture.data, "updates/candidates")),
      ),
    ).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cancels freezing and revalidation without publishing a candidate record", async () => {
  const fixture = await setup();
  try {
    const controller = new AbortController();
    const freezing = freezePreparedCandidate({
      channelRoot: fixture.channel,
      dataDirectory: fixture.data,
      selected: { version: VERSION, hash: HASH },
      signal: controller.signal,
    });
    controller.abort();
    await expect(freezing).rejects.toThrow();
    await expect(
      import("node:fs/promises").then(({ lstat }) =>
        lstat(join(fixture.data, "updates/candidates", `${HASH}.json`)),
      ),
    ).rejects.toThrow();
    const revalidate = new AbortController();
    const revalidating = revalidateFrozenCandidate(
      fixture.channel,
      fixture.data,
      { version: VERSION, hash: HASH },
      undefined,
      revalidate.signal,
    );
    revalidate.abort();
    await expect(revalidating).rejects.toThrow();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
