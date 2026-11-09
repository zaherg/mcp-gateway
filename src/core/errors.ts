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

export const failure = (code: GatewayErrorCode, message: string): GatewayError => {
  return new GatewayError({ code, message, occurrenceId: `issue-${++issueSequence}` });
};

let issueSequence = 0;
export const visible = (error: unknown): VisibleError => {
  return error instanceof GatewayError
    ? { code: error.code, message: error.message, occurrenceId: error.occurrenceId }
    : {
        code: 'BackendFailure',
        message: 'The operation failed. Open Logs for details.',
        occurrenceId: `issue-${++issueSequence}`,
      };
};
