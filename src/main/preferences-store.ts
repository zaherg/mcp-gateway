import { readPrivateText, writePrivateTextAtomic } from '@mcp-gateway/core/config';
import { isRecord } from '@mcp-gateway/shared/config-document';

const MAX_PREFERENCE_BYTES = 64 * 1024;

export type PreferenceReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  | { status: 'invalid' };

export const readPrivateJson = async <T>(
  path: string,
  parse: (record: Record<string, unknown>) => T | undefined,
): Promise<PreferenceReadResult<T>> => {
  let text: string;
  try {
    text = (await readPrivateText(path, MAX_PREFERENCE_BYTES)).text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { status: 'missing' };
    return { status: 'invalid' };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { status: 'invalid' };
  }
  if (!isRecord(document) || document.schema_version !== 1) return { status: 'invalid' };
  const value = parse(document);
  return value === undefined ? { status: 'invalid' } : { status: 'ok', value };
};

export const writePrivateJsonAtomic = async (path: string, payload: Record<string, unknown>) => {
  await writePrivateTextAtomic(path, JSON.stringify({ schema_version: 1, ...payload }));
};
