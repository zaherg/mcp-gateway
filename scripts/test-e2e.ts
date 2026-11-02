import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const tmp = resolve(".cache/tmp");
await mkdir(tmp, { recursive: true, mode: 0o700 });
const child = Bun.spawn(
  ["node", "node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)],
  {
    env: {
      ...process.env,
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
      PLAYWRIGHT_BROWSERS_PATH: resolve(".cache/playwright"),
    },
    stdout: "inherit",
    stderr: "inherit",
  },
);
process.exitCode = await child.exited;
