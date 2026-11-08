import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createCommandRunner } from "@mcp-gateway/core/process";
import { TEST_IDENTIFIER, validateFeedUrl } from "./build-config";
import { hashFile, readUpdateArtifacts, UPDATE_FILES } from "./update-artifacts";

// Names the child processes need. Everything else, notably notarization credentials, stays out.
const CHILD_ENVIRONMENT_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "XDG_CONFIG_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

const childEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (name.startsWith("RCLONE_") || CHILD_ENVIRONMENT_NAMES.has(name)) environment[name] = value;
  }
  return environment;
};

const parseS3Path = (value: string | undefined): string => {
  const segments = value?.split("/") ?? [];
  if (segments.length < 2 || !segments.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)))
    throw new Error(
      "Set MCP_GATEWAY_TEST_FEED_S3_PATH to <bucket>/<prefix>, for example mcp-gateway/test/stable.",
    );
  return segments.join("/");
};

const contentType = (name: string) =>
  name.endsWith(".json") ? "application/json" : "application/zstd";
const cancellation = new AbortController();
const interrupt = () => cancellation.abort(new Error("Test feed publication cancelled."));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

const publish = async () => {
  const options = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { cleanup: { type: "boolean" } },
  });
  const cleanup = options.values.cleanup === true;
  if (options.positionals.length !== (cleanup ? 0 : 1))
    throw new Error("Usage: bun scripts/publish-test-feed.ts <artifacts-dir> | --cleanup");
  const directory = resolve(options.positionals[0] ?? "");
  if (
    !cleanup &&
    ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
  )
    throw new Error("Artifact directory must be a plain, nonsymlinked directory.");
  const remote = process.env.MCP_GATEWAY_TEST_FEED_REMOTE;
  if (!remote || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(remote))
    throw new Error(
      "Set MCP_GATEWAY_TEST_FEED_REMOTE to an existing S3 remote name, without a colon.",
    );
  const feed = validateFeedUrl(process.env.MCP_GATEWAY_TEST_FEED);
  const destination = parseS3Path(process.env.MCP_GATEWAY_TEST_FEED_S3_PATH);
  const run = createCommandRunner({
    defaultTimeoutMs: 300_000,
    start: (command, args) =>
      spawn(command, [...args], {
        env: childEnvironment(process.env),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      }),
  });
  const rclone = async (args: string[], accepted = [0]) => {
    const result = await run(
      "rclone",
      [
        ...args,
        "--contimeout",
        "10s",
        "--timeout",
        "30s",
        "--retries",
        "1",
        "--low-level-retries",
        "1",
      ],
      300_000,
      cancellation.signal,
    );
    if (!accepted.includes(result.exitCode))
      throw new Error(
        `Rclone ${args[0]} failed (exit ${result.exitCode}); private diagnostics withheld.`,
      );
    return result.stdout;
  };
  const remotes = await rclone(["listremotes", "--long"]);
  if (!remotes.split(/\r?\n/).some((line) => new RegExp(`^${remote}:\\s+s3\\s*$`).test(line)))
    throw new Error("Selected remote does not exist or is not S3.");
  const config = await rclone(["config", "redacted", remote]);
  const endpoint = /^endpoint\s*=\s*(.+)$/m.exec(config)?.[1]?.trim();
  if (!endpoint) throw new Error("The selected S3 remote needs an explicit HTTPS endpoint.");
  let origin: URL;
  try {
    origin = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
  } catch {
    throw new Error("The selected remote endpoint is invalid.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error(
      "The selected remote needs an HTTPS origin without credentials, query or path.",
    );
  // validateFeedUrl already parsed this value, so parse() cannot return null here.
  const feedUrl = URL.parse(feed);
  if (feedUrl?.origin === origin.origin && feedUrl.pathname !== `/${destination}`)
    throw new Error(
      "MCP_GATEWAY_TEST_FEED does not match the publish location MCP_GATEWAY_TEST_FEED_S3_PATH.",
    );
  const publicBase = `${origin.origin}/${destination}`;
  if (cleanup) {
    // Exit code 4 means the key is already absent, which is the desired end state.
    for (const name of Object.values(UPDATE_FILES)) {
      await rclone(["deletefile", `${remote}:${destination}/${name}`], [0, 4]);
      const response = await fetch(`${publicBase}/${name}`, {
        redirect: "error",
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)]),
      });
      await response.body?.cancel();
      if (response.status !== 404)
        throw new Error(`${name} is still readable anonymously (HTTP ${response.status}).`);
      console.log(`Removed ${name}`);
    }
    console.log(`Removed the updater files under ${publicBase}`);
    return;
  }
  const { manifest } = await readUpdateArtifacts(
    directory,
    { identifier: TEST_IDENTIFIER },
    cancellation.signal,
  );
  const archive = join(directory, UPDATE_FILES.archive);
  const extracted = await run(
    "/usr/bin/tar",
    ["-xOf", archive, "MCP Gateway.app/Contents/Resources/version.json"],
    60_000,
    cancellation.signal,
  );
  if (extracted.exitCode !== 0) throw new Error("Could not read candidate version metadata.");
  let embedded: Record<string, unknown>;
  try {
    const value = JSON.parse(extracted.stdout);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid object.");
    embedded = value;
  } catch {
    throw new Error("Candidate version metadata is invalid.");
  }
  if (
    embedded.identifier !== TEST_IDENTIFIER ||
    embedded.channel !== "stable" ||
    embedded.version !== manifest.version ||
    embedded.hash !== manifest.hash ||
    embedded.baseUrl !== feed
  )
    throw new Error("Candidate identity or embedded feed does not match the selected test build.");

  const files = [UPDATE_FILES.archive, UPDATE_FILES.integrity, UPDATE_FILES.manifest];
  const hashes = new Map<string, string>();
  for (const name of files)
    hashes.set(name, await hashFile(join(directory, name), cancellation.signal));
  // Republishing an older candidate must include the archive: both manifests name the same mutable archive key.
  for (const name of files) {
    const type = contentType(name);
    const args = [
      "copyto",
      join(directory, name),
      `${remote}:${destination}/${name}`,
      "--ignore-times",
      "--s3-no-check-bucket",
      "--metadata",
      "--metadata-set",
      `content-type=${type}`,
    ];
    if (name.endsWith(".json")) args.push("--metadata-set", "cache-control=no-cache");
    await rclone(args);
    console.log(`Uploaded ${name}`);
  }
  for (const name of files) {
    const expectedSize = (await lstat(join(directory, name))).size;
    const type = contentType(name);
    const head = await fetch(`${publicBase}/${name}`, {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)]),
    });
    await head.body?.cancel();
    if (
      head.status !== 200 ||
      Number(head.headers.get("content-length")) !== expectedSize ||
      head.headers.get("content-type")?.split(";", 1)[0] !== type
    )
      throw new Error(`Anonymous metadata does not match ${name}.`);
    if (name.endsWith(".json") && !head.headers.get("cache-control")?.includes("no-cache"))
      throw new Error("Published manifests must store Cache-Control: no-cache metadata.");
    const response = await fetch(`${publicBase}/${name}`, {
      redirect: "error",
      signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(120_000)]),
      headers: { "Cache-Control": "no-cache" },
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Anonymous readback failed for ${name} (HTTP ${response.status}).`);
    }
    const reader = response.body.getReader();
    const digest = createHash("sha256");
    let size = 0;
    try {
      if (
        Number(response.headers.get("content-length")) !== expectedSize ||
        response.headers.get("content-type")?.split(";", 1)[0] !== type
      )
        throw new Error(`Anonymous response headers do not match ${name}.`);
      if (name.endsWith(".json") && !response.headers.get("cache-control")?.includes("no-cache"))
        console.warn(
          `Warning: ${name} stores no-cache metadata, but GET omits that directive; intermediary caching is not prevented by the response.`,
        );
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > expectedSize) throw new Error("Anonymous readback exceeds the expected size.");
        digest.update(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (size !== expectedSize || digest.digest("hex") !== hashes.get(name))
      throw new Error(`Anonymous readback differs from ${name}.`);
    if ((await hashFile(join(directory, name), cancellation.signal)) !== hashes.get(name))
      throw new Error("Local candidate changed during publication.");
    console.log(`Verified anonymous readback: ${name}`);
  }
  console.log(`Published test version ${manifest.version} at ${publicBase}`);
};

try {
  await publish();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Test feed publication failed.");
  if (!process.argv.includes("--cleanup"))
    console.error(
      "Publication is not atomic; if any upload completed, republish a verified candidate directory.",
    );
  process.exitCode = cancellation.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
