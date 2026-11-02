import { writeFileSync } from "node:fs";

// A unique project-local command marker proves ownership after its parent exits.
writeFileSync(process.argv[3], String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
