// src/native/login.m repeats PRODUCTION_IDENTIFIER; change both together.
export const PRODUCTION_IDENTIFIER = 'dev.srvr.mcpgateway';
export const TEST_IDENTIFIER = 'dev.srvr.mcpgateway.test';

export const appNameFor = (identifier: string) =>
  identifier === TEST_IDENTIFIER ? 'MCP Gateway Dev' : 'MCP Gateway';
