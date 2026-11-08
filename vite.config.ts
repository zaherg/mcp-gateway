import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { electrobunViteAliases } from "./.hutch/devkit/api/config/electrobun-vite.ts";

export default defineConfig({
  root: "src/mainview",
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      ...electrobunViteAliases(".hutch/devkit"),
      {
        find: /^@mcp-gateway\//,
        replacement: `${resolve(import.meta.dirname, "src")}/`,
      },
    ],
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
  },
  server: { host: "127.0.0.1" },
});
