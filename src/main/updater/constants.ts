export const UPDATER_IDENTIFIER = "dev.srvr.mcpgateway";
export const UPDATER_CHANNEL = "stable";
export const UPDATER_PLATFORM = "macos";
export const UPDATER_ARCH = "arm64";
export const UPDATER_FEED_URL = "https://github.com/zaherg/mcp-gateway/releases/latest/download";
export const UPDATER_ARTIFACT_FILE = "stable-macos-arm64-MCPGateway.app.tar.zst";
export const UPDATER_HASH_PATTERN = /^[a-z0-9]{1,13}$/;
export const UPDATER_STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
export const PREPARED_UPDATE_FILE = ".electrobun-prepared-update.json";

export function isSafeRelativeComponent(value: string): boolean {
  if (value.length === 0 || value.length > 256 || value === "." || value === "..") return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || character === "/" || character === "\\") return false;
  }
  return true;
}
export const MAX_COMPRESSED_ARTIFACT_BYTES = 512 * 1024 * 1024;
export const MAX_EXPANDED_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_WORKER_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_STAGING_BYTES = 5 * 1024 * 1024 * 1024;
export const MIN_FREE_SPACE_RESERVE_BYTES = 512 * 1024 * 1024;
