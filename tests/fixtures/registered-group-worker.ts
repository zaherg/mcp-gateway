import { appendFileSync } from "node:fs";

const ready = process.env.GROUP_READY;
if (!ready) process.exit(2);
let granted = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (granted || !chunk.includes("grant\n")) return;
  granted = true;
  const child = Bun.spawn(["/bin/sleep", "120"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  appendFileSync(ready, `${process.pid} ${child.pid}\n`, { mode: 0o600 });
});
process.stdin.on("end", () => {
  if (!granted) process.exit(0);
});
process.stdin.on("close", () => {
  if (!granted) process.exit(0);
});
setInterval(() => {}, 1_000);
