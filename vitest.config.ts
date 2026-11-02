import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: ".cache/vitest",
  test: {
    environment: "jsdom",
    include: ["tests/components/**/*.component.tsx"],
    setupFiles: ["tests/components/setup.ts"],
    testTimeout: 10_000,
  },
});
