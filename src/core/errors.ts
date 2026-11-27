import type { GatewayErrorCode, VisibleError } from '@mcp-gateway/shared/types';

// Only policy text or allowlisted structured summaries belong here, never raw diagnostics.
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly occurrenceId: string;
  constructor({ code, message, occurrenceId }: VisibleError) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.occurrenceId = occurrenceId;
  }
}

/** An expected refusal at the local RPC boundary; never recorded as a local error. */
export class RequestError extends Error {
  readonly code = 'InvalidRequest';
}

let issueSequence = 0;

export const failure = (code: GatewayErrorCode, message: string) => {
  return new GatewayError({ code, message, occurrenceId: `issue-${++issueSequence}` });
};

export const visible = (error: unknown): VisibleError => {
  return error instanceof GatewayError
    ? { code: error.code, message: error.message, occurrenceId: error.occurrenceId }
    : {
        code: 'BackendFailure',
        message: 'The operation failed. Open Logs for details.',
        occurrenceId: `issue-${++issueSequence}`,
      };
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional stripping of ASCII control characters from upstream error strings
const CONTROL_CHARS_PATTERN = /[\x00-\x1f\x7f]+/g;
const URL_USERINFO_PATTERN = /:\/\/[^/\s@]+@/g;
const QUERY_SECRET_PATTERN =
  /([?&](?:token|api_key|apikey|key|secret|password|access_token)=)[^&#\s]+/gi;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[^\s,;]+/gi;

export const sanitizeErrorText = (raw: unknown, fallback: string, maxLength = 240) => {
  const source = typeof raw === 'string' ? raw : raw instanceof Error ? raw.message : '';
  const cleaned = source
    .replace(CONTROL_CHARS_PATTERN, ' ')
    .replace(URL_USERINFO_PATTERN, '://[REDACTED]@')
    .replace(QUERY_SECRET_PATTERN, '$1[REDACTED]')
    .replace(AUTH_SCHEME_PATTERN, '$1 [REDACTED]')
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 3))}...`;
};
