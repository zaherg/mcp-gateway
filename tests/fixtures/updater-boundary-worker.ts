import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appEntries, writeTarFixture } from "./updater";

const home = process.env.HOME;
const result = process.env.MCP_GATEWAY_UPDATE_RESULT;
const scenario = process.env.WORKER_SCENARIO ?? "success";
if (!home || !result) throw new Error("missing fixture environment");
if (process.env.MCP_GATEWAY_UPDATE_GRANT === "1") {
  process.stdin.setEncoding("utf8");
  const granted = await new Promise<boolean>((resolve) => {
    let buffer = "";
    process.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.includes("grant\n")) resolve(true);
    });
    process.stdin.on("end", () => resolve(false));
    process.stdin.on("close", () => resolve(false));
  });
  if (!granted) process.exit(0);
}

const channelRoot = join(home, "Library", "Application Support", "dev.srvr.mcpgateway", "stable");
const extraction = join(channelRoot, "self-extraction");
mkdirSync(extraction, { recursive: true, mode: 0o700 });
if (scenario === "timeout") await new Promise(() => {});
const hash = "target123456";
const version = scenario === "moving-latest" ? "0.3.2" : "0.3.1";
if (scenario === "check" || scenario === "no-update") {
  writeFileSync(
    result,
    JSON.stringify(
      scenario === "check"
        ? {
            status: "available",
            selected: { version, hash },
            channelRoot,
          }
        : { status: "no-update", reason: "check" },
    ),
    { mode: 0o600 },
  );
  process.exit(0);
}
const archive = join(extraction, `${hash}.tar`);
writeTarFixture(archive, appEntries({ version, hash }));
writeFileSync(
  join(extraction, ".electrobun-prepared-update.json"),
  `${JSON.stringify({
    schema_version: 1,
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    version,
    hash,
    platform: "macos",
    arch: "arm64",
    retained_tar_path: archive,
    artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
  })}\n`,
  { mode: 0o600 },
);
writeFileSync(
  result,
  JSON.stringify({
    status: "ready",
    selected: {
      version,
      hash: scenario === "bad-selection" ? "other123456" : hash,
    },
    channelRoot,
  }),
  { mode: 0o600 },
);
