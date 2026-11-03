import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface TarFixtureEntry {
  name: string;
  type?: "0" | "5" | "1" | "2" | "x" | "g" | "6";
  contents?: string | Uint8Array;
  mode?: number;
  linkname?: string;
}

function text(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function writeField(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

export function tarHeader(entry: TarFixtureEntry): Uint8Array {
  const contents = text(entry.contents ?? "");
  const header = new Uint8Array(512);
  writeField(header, 0, 100, entry.name);
  writeField(header, 100, 8, `${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
  writeField(header, 108, 8, "0000000\0");
  writeField(header, 116, 8, "0000000\0");
  writeField(header, 124, 12, `${contents.byteLength.toString(8).padStart(11, "0")}\0`);
  writeField(header, 136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  writeField(header, 156, 1, entry.type ?? "0");
  writeField(header, 157, 100, entry.linkname ?? "");
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export function tarBytes(entries: readonly TarFixtureEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const header = tarHeader(entry);
    const contents = text(entry.contents ?? "");
    const padding = new Uint8Array((512 - (contents.byteLength % 512)) % 512);
    parts.push(header, contents, padding);
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

const FEED = "https://github.com/zaherg/mcp-gateway/releases/latest/download";

export function versionJson(version = "0.3.1", hash = "target123456"): string {
  return JSON.stringify({
    version,
    hash,
    channel: "stable",
    baseUrl: FEED,
    name: "MCPGateway",
    displayName: "MCP Gateway",
    identifier: "dev.srvr.mcpgateway",
  });
}

export function infoPlist(version = "0.3.1", executable = "launcher"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.srvr.mcpgateway</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>
`;
}

export function appEntries(
  options: { version?: string; hash?: string; executable?: string; extra?: TarFixtureEntry[] } = {},
): TarFixtureEntry[] {
  const entries: TarFixtureEntry[] = [
    { name: "MCP Gateway.app/", type: "5", mode: 0o755 },
    { name: "MCP Gateway.app/Contents/", type: "5", mode: 0o755 },
    { name: "MCP Gateway.app/Contents/MacOS/", type: "5", mode: 0o755 },
    { name: "MCP Gateway.app/Contents/Resources/", type: "5", mode: 0o755 },
    {
      name: "MCP Gateway.app/Contents/Info.plist",
      contents: infoPlist(options.version, options.executable),
    },
    {
      name: "MCP Gateway.app/Contents/MacOS/launcher",
      contents: "fixture launcher",
      mode: 0o755,
    },
    {
      name: "MCP Gateway.app/Contents/Resources/version.json",
      contents: versionJson(options.version, options.hash),
    },
    {
      name: "MCP Gateway.app/Contents/Resources/uninstall",
      contents: "fixture update manager",
      mode: 0o755,
    },
  ];
  if (options.extra) entries.push(...options.extra);
  return entries;
}

export function writeTarFixture(path: string, entries: readonly TarFixtureEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, tarBytes(entries), { mode: 0o600 });
}

export function writeBundleFixture(
  root: string,
  options: { version?: string; hash?: string; executable?: string } = {},
): string {
  const bundle = `${root}/MCP Gateway.app`;
  const executable = options.executable ?? "launcher";
  mkdirSync(`${bundle}/Contents/MacOS`, { recursive: true });
  mkdirSync(`${bundle}/Contents/Resources`, { recursive: true });
  writeFileSync(`${bundle}/Contents/Info.plist`, infoPlist(options.version, executable));
  writeFileSync(`${bundle}/Contents/MacOS/${executable}`, "fixture launcher", { mode: 0o755 });
  writeFileSync(
    `${bundle}/Contents/Resources/version.json`,
    versionJson(options.version, options.hash),
  );
  writeFileSync(`${bundle}/Contents/Resources/uninstall`, "fixture update manager", {
    mode: 0o755,
  });
  return bundle;
}
