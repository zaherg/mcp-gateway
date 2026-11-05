import { expect, test } from "bun:test";
import { ok } from "node:assert/strict";
import { join, resolve } from "node:path";
import { alive, configFor, eventually, ingressCounts, mcpCall, pids, setup } from "../core/helpers";
import { type OutputOptions, outputServer } from "../fixtures/backend-output";

const LIMIT = 4 * 1024 * 1024;

for (const format of ["line", "sse", "json"] as const) {
  const scenarios = [
    "exact",
    "oversized",
    "unfinished",
    ...(format === "sse" ? (["many-events", "error-stream"] as const) : []),
  ] as const;
  for (const scenario of scenarios) {
    test(`backend output ${format} ${scenario}`, async () => {
      const options: OutputOptions = {
        format,
        bytes:
          scenario === "many-events" || scenario === "error-stream"
            ? 256
            : LIMIT + (scenario === "exact" ? 0 : 1),
        unfinished: scenario === "unfinished",
        prefixEvents: scenario === "many-events" || scenario === "error-stream" ? 3 : undefined,
        status: scenario === "error-stream" ? 500 : 200,
      };
      const upstream = format === "line" ? undefined : await outputServer(options);
      const context = await setup(await configFor({}));
      const pidFile = join(context.directory, "pids");
      try {
        const config = await configFor({
          echo: upstream
            ? {
                url: upstream.url,
                headers: { Authorization: `Bearer ${upstream.token}` },
              }
            : {
                command: process.execPath,
                args: [resolve("tests/fixtures/backend-output.ts")],
                env: { OUTPUT_OPTIONS: JSON.stringify(options), PID_FILE: pidFile },
              },
        });
        await context.controller.saveConfig(
          JSON.stringify(config),
          context.controller.snapshot().revision,
        );
        const { address } = await context.controller.start();
        if (!address) throw new Error("Missing gateway address");
        // biome-ignore lint/complexity/useLiteralKeys: Observe shared admission through the real gateway.
        const ingress = context.controller["ingress"];
        if (!ingress) throw new Error("Missing ingress");
        const { message } = await mcpCall(
          address,
          "echo",
          "tools/call",
          { name: "large", arguments: {} },
          7,
          AbortSignal.timeout(3000),
        );
        ok(message, "Expected an MCP response envelope");
        expect(message.id).toBe(7);
        const succeeds = scenario === "exact" || scenario === "many-events";
        if (succeeds) {
          expect(message.error).toBeUndefined();
          const text = message.result.content[0].text;
          expect(text.startsWith("synthetic-private-output-")).toBe(true);
          expect(Buffer.byteLength(JSON.stringify(message)) + (format === "sse" ? 6 : 0)).toBe(
            options.bytes,
          );
        } else {
          expect(message.result === undefined).toBe(true);
          expect(message.error.code).toBe(-32603);
          expect(JSON.stringify(message)).not.toContain("synthetic-private-output-");
        }
        await eventually(
          () => ingressCounts(ingress).resources === 0 && ingressCounts(ingress).calls === 0,
        );
        if (upstream) {
          await eventually(() => upstream.active() === 0);
          expect(
            upstream.authorization.every((header) => header === `Bearer ${upstream.token}`),
          ).toBe(true);
        } else {
          const children = await pids(pidFile);
          expect(children.length).toBe(1);
          await eventually(() => children.every((pid) => !alive(pid)));
        }
        expect(JSON.stringify(context.controller.snapshot())).not.toContain(
          "synthetic-private-output-",
        );
      } finally {
        await context.cleanup();
        await upstream?.close();
      }
    }, 15_000);
  }
}
