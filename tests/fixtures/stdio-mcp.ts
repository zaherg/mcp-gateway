import { spawn } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

if (process.env.PID_FILE) appendFileSync(process.env.PID_FILE, `${process.pid}\n`);
if (process.env.DESCENDANT_PID_FILE) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  appendFileSync(process.env.DESCENDANT_PID_FILE, `${child.pid}\n`);
}
if (process.env.PRIVATE_DIAGNOSTIC) process.stderr.write(process.env.PRIVATE_DIAGNOSTIC);
if (process.env.SYNTHETIC_EXIT_CODE) process.exit(Number(process.env.SYNTHETIC_EXIT_CODE));
const pending = new Map<string | number, ReturnType<typeof setTimeout>>();
let count = 0;
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
// Tests can hold real process-group cleanup until admission has been checked.
if (process.env.CLEANUP_GATE_FILE) {
  process.on("SIGTERM", () => {
    if (process.env.CLEANUP_SIGNAL_FILE)
      appendFileSync(process.env.CLEANUP_SIGNAL_FILE, `${process.pid}\n`);
    const gate = process.env.CLEANUP_GATE_FILE;
    const timer = setInterval(() => {
      if (gate && existsSync(gate)) {
        clearInterval(timer);
        process.exit(0);
      }
    }, 10);
  });
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message: JSONRPCMessage = JSON.parse(line);
  if (!("method" in message)) return;
  if (message.method === "notifications/cancelled") {
    const id = message.params?.requestId;
    if (typeof id === "string" || typeof id === "number") {
      clearTimeout(pending.get(id));
      pending.delete(id);
    }
    return;
  }
  if (!("id" in message)) return;
  const respond = (result: unknown) => send({ jsonrpc: "2.0", id: message.id, result });
  if (message.method === "initialize") {
    const clientInfo = message.params?.clientInfo;
    if (
      process.env.HANG_INITIALIZE ||
      (typeof clientInfo === "object" &&
        clientInfo !== null &&
        "name" in clientInfo &&
        clientInfo.name === process.env.HANG_INITIALIZE_CLIENT)
    )
      return;
    respond({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "synthetic-stdio", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    respond({
      tools: ["echo", "write", "delay", "ask"].map((name) => ({
        name,
        inputSchema: { type: "object", additionalProperties: true },
      })),
    });
  } else if (message.method === "tools/call") {
    const params = message.params;
    const args = params?.arguments as { value?: string; delay?: number } | undefined;
    if (params?.name === "ask" && !params.requestState) {
      respond({
        resultType: "input_required",
        requestState: "synthetic-backend-state",
        content: [],
      });
      return;
    }
    if (params?.name === "write" && process.env.SYNTHETIC_OUTPUT)
      writeFileSync(process.env.SYNTHETIC_OUTPUT, args?.value ?? "");
    const result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            value: args?.value,
            count: ++count,
            pid: process.pid,
            argv: process.argv.slice(2),
            env: process.env.SYNTHETIC_ENV,
          }),
        },
      ],
    };
    if (params?.name === "delay") {
      const id = message.id;
      pending.set(
        id,
        setTimeout(() => {
          pending.delete(id);
          respond(result);
        }, args?.delay ?? 1000),
      );
    } else respond(result);
  } else if (message.method === "ping") respond({});
  else
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
input.on("close", () => {
  for (const timer of pending.values()) clearTimeout(timer);
  process.exit(0);
});
