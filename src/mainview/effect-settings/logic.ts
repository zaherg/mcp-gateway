export interface SavedGatewaySnapshot {
  readonly host: string;
  readonly port: number;
  readonly allowedPeers: readonly string[] | null;
  readonly token: string | null;
  readonly tokenRef: string | null;
  readonly launchAtLogin: boolean;
  readonly autoStart: boolean;
  readonly keepAwake: boolean;
}

export interface SettingsDrafts {
  readonly hostInput: string;
  readonly portInput: string;
  readonly peersText: string;
  readonly tokenInput: string;
}

/**
 * Comma-separated field text as a list of ranges. A blank field removes the property; text
 * with no ranges, such as ", ,", stays an empty list so saving reports it instead of
 * silently dropping the restriction.
 */
export const parsePeerList = (text: string): string[] | undefined => {
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return text.trim() ? entries : undefined;
};

export const formatPortDraft = (port: number): string => (port === 0 ? '' : String(port));

export const formatPeersDraft = (allowedPeers: readonly string[] | null | undefined): string =>
  allowedPeers ? allowedPeers.join(', ') : '';

export const draftsFromSavedConfig = (saved: SavedGatewaySnapshot | null): SettingsDrafts => ({
  hostInput: saved?.host ?? '',
  portInput: saved ? formatPortDraft(saved.port) : '',
  peersText: formatPeersDraft(saved?.allowedPeers),
  tokenInput: saved?.token ?? '',
});

export const computeHostPatch = (
  hostInput: string,
  saved: SavedGatewaySnapshot | null,
  locked: boolean,
): string | null => {
  if (!saved || locked || hostInput === saved.host) return null;
  return hostInput;
};

export const computePortPatch = (
  portInput: string,
  saved: SavedGatewaySnapshot | null,
  locked: boolean,
): number | null => {
  if (!saved || locked) return null;
  const nextPort = portInput.trim() === '' ? 0 : Number(portInput);
  if (Number.isNaN(nextPort) || nextPort === saved.port) return null;
  return nextPort;
};

export const computePeersPatch = (
  peersText: string,
  saved: SavedGatewaySnapshot | null,
  locked: boolean,
): { readonly allowedPeers: readonly string[] | null } | null => {
  if (!saved || locked) return null;
  const nextPeers = parsePeerList(peersText);
  const currentPeers = saved.allowedPeers ?? undefined;
  if (JSON.stringify(nextPeers) === JSON.stringify(currentPeers)) return null;
  return { allowedPeers: nextPeers ?? null };
};

export const computeTokenPatch = (
  tokenInput: string,
  saved: SavedGatewaySnapshot | null,
  locked: boolean,
): string | null => {
  if (!saved || locked || tokenInput === (saved.token ?? '')) return null;
  return tokenInput;
};

export const formatImportStatus = (count: number): string =>
  count > 0
    ? `Imported ${count} server${count === 1 ? '' : 's'} from Claude Desktop / Cursor.`
    : 'No new servers found in Claude Desktop or Cursor.';
