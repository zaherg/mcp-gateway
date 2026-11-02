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
const clientResponses = new Map<string | number, string | number>();
let count = 0;
let serverRequestCount = 0;
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
  if (!("method" in message)) {
    // A client response to a server-originated request completes its tool call.
    if ("id" in message && (typeof message.id === "string" || typeof message.id === "number")) {
      const callId = clientResponses.get(message.id);
      if (callId !== undefined) {
        clientResponses.delete(message.id);
        const payload = "result" in message ? message.result : message.error;
        send({
          jsonrpc: "2.0",
          id: callId,
          result: {
            content: [{ type: "text", text: JSON.stringify({ clientResponse: payload }) }],
          },
        });
      }
    }
    return;
  }
  if (!("id" in message)) {
    if (process.env.NOTIFICATION_LOG)
      appendFileSync(process.env.NOTIFICATION_LOG, `${message.method}\n`);
    if (message.method === "notifications/cancelled") {
      const id = message.params?.requestId;
      // Tests can keep a cancelled call running so its late reply races newer work.
      if (process.env.LATE_REPLY_ON_CANCEL) return;
      if (typeof id === "string" || typeof id === "number") {
        clearTimeout(pending.get(id));
        pending.delete(id);
      }
    }
    return;
  }
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
    const args = params?.arguments as
      | { value?: string; delay?: number; marker?: string }
      | undefined;
    // Record the backend-facing id separately from the test's marker so
    // legacy wire-id remapping is asserted rather than hidden.
    if (process.env.CALL_LOG)
      appendFileSync(process.env.CALL_LOG, `${message.id}\t${args?.marker ?? ""}\n`);
    if (params?.name === "server-request") {
      // A backend server-originated request plus progress/log traffic, sent
      // while this call is pending so session routing is exercised.
      const requestId = ++serverRequestCount;
      clientResponses.set(requestId, message.id);
      const meta = (message.params as { _meta?: { progressToken?: unknown } } | undefined)?._meta;
      if (typeof meta?.progressToken === "string" || typeof meta?.progressToken === "number")
        send({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: meta.progressToken, progress: 1, total: 2 },
        });
      send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", data: "synthetic-backend-notification" },
      });
      send({ jsonrpc: "2.0", id: requestId, method: "roots/list" });
      return;
    }
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
    if (
      process.env.MALFORMED_RESPONSE_MARKER &&
      args?.marker === process.env.MALFORMED_RESPONSE_MARKER
    ) {
      // Emit a malformed terminal envelope first, then a valid reply later.
      const shape = process.env.MALFORMED_RESPONSE_SHAPE ?? "no-result";
      if (shape === "no-result") send({ jsonrpc: "2.0", id: message.id });
      else if (shape === "both")
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {},
          error: { code: -32603, message: "synthetic both" },
        });
      else if (shape === "null") send(null);
      else send(7);
      if (process.env.MALFORMED_SIGNAL_FILE)
        appendFileSync(process.env.MALFORMED_SIGNAL_FILE, "malformed\n");
      const id = message.id;
      pending.set(
        id,
        setTimeout(() => {
          pending.delete(id);
          respond(result);
        }, 200),
      );
      return;
    }
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
