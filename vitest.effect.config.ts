import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@mcp-gateway\//,
        replacement: `${resolve(import.meta.dirname, 'src')}/`,
      },
    ],
  },
  test: {
    include: [
      'tests/effect-logs/**/*.test.ts',
      'tests/effect-settings/**/*.test.ts',
      'tests/effect-overview/**/*.test.ts',
    ],
  },
});
