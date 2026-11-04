import { parseBuildIdentity } from "../../shared/build-identity";

declare const MCP_GATEWAY_EXECUTING_BUILD: unknown;

// A source run has no confirmation authority. Never reconstruct this value from disk or env.
export const EXECUTING_BUILD =
  typeof MCP_GATEWAY_EXECUTING_BUILD === "undefined"
    ? undefined
    : parseBuildIdentity(MCP_GATEWAY_EXECUTING_BUILD);
