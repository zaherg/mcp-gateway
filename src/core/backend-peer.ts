import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type {
  ChildrenOwner,
  GatewayLogger,
  PeerFactory,
  Source,
} from "supergateway/dist/gateways/stdioToStatefulStreamableHttp.js";
import { spawnCommand } from "supergateway/dist/lib/childCommand.js";
import { readWhile } from "supergateway/dist/lib/outputBackpressure.js";
import { boundedBackendResponse, readBackendLines } from "./backend-output";

/** Supergateway 4.2.1 peer seams, with limits before its unbounded readers. */
export function startBackend(
  source: Source,
  children: ChildrenOwner,
  logger: GatewayLogger,
): PeerFactory {
  if (source.stdioCmd) {
    const child = spawnCommand(spawn, source.stdioCmd, { ...children.spawnOptions, stdio: "pipe" });
    const stop = children.own(child);
    return (owner) => {
      child.on("error", (error) => owner.failure("process", error));
      child.stdin.on("error", (error) => owner.failure("stdin", error));
      child.stdout.on("error", (error) => owner.failure("stdout", error));
      child.on("exit", (code, signal) => owner.exit(code, signal));
      readBackendLines(
        child.stdout,
        (line) => {
          if (!line.trim()) return;
          try {
            owner.message(JSON.parse(line), line);
          } catch {
            owner.nonJson(line);
          }
        },
        (error) => owner.failure("stdout", error),
        () => owner.output(),
      );
      child.stderr.on("data", (chunk) => owner.stderr(chunk.toString("utf8")));
      return {
        write: (message) => {
          child.stdin.write(`${JSON.stringify(message)}\n`);
        },
        end: () => {
          child.stdin.end();
        },
        stop,
        get gone() {
          return child.exitCode !== null || child.signalCode !== null;
        },
      };
    };
  }
  const remote = source.upstream;
  return (owner) => {
    let gone = false;
    let initializeId: string | number | undefined;
    let answered: (() => void) | undefined;
    const fail = (error: Error) => owner.failure("upstream", error);
    const transport = new StreamableHTTPClientTransport(remote.url, {
      requestInit: { headers: remote.headers },
      fetch: async (...args) =>
        readWhile(boundedBackendResponse(await fetch(...args), fail), () => owner.output()),
    });
    const stop = children.track(async () => {
      await Promise.race([
        transport
          .terminateSession()
          .catch((error) => logger.error("Session: failed to end the upstream session:", error)),
        delay(2000, undefined, { ref: false }),
      ]);
      await transport.close();
    });
    transport.onmessage = (message) => {
      if ("id" in message && message.id === initializeId) {
        initializeId = undefined;
        if ("result" in message) {
          if (typeof message.result.protocolVersion !== "string") {
            fail(new Error("Upstream initialization has no protocol version."));
            return;
          }
          transport.setProtocolVersion(message.result.protocolVersion);
        }
        answered?.();
      }
      owner.message(message, JSON.stringify(message));
    };
    transport.onerror = (error) => logger.error("Session: upstream error:", error);
    transport.onclose = () => {
      gone = true;
      owner.exit(null, null);
    };
    let ready = transport.start().catch(fail);
    return {
      write: (message) => {
        const sent = ready.then(() => transport.send(message));
        void sent.catch(fail);
        if (!isInitializeRequest(message) || !("id" in message)) return;
        initializeId = message.id;
        ready = Promise.all([
          sent,
          new Promise<void>((resolve) => {
            answered = resolve;
          }),
        ]).then(() => undefined, fail);
      },
      end: () => {
        void ready.then(stop).catch(fail);
      },
      stop,
      get gone() {
        return gone;
      },
    };
  };
}
