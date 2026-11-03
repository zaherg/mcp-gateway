import { appendFileSync } from "node:fs";

const marker = process.env.GRANT_MARKER;
if (!marker) process.exit(2);
let granted = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (granted || !chunk.includes("grant\n")) return;
  granted = true;
  appendFileSync(marker, `${process.pid}\n`, { mode: 0o600 });
});
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
setInterval(() => {}, 1_000);
