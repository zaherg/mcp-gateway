import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  assertUpdateAcceptance,
  parseStartupMarkers,
  recordCompletedStartup,
  recordPreHandoff,
  replaceOnce,
  type StartupMarker,
} from "../../scripts/update-acceptance";

const rpc = {
  supported: true,
  documentOverscroll: "none",
  bodyOverscroll: "none",
  bodyBackground: "rgb(10, 10, 10)",
};
const roots = {
  home: "/fixture/home",
  tmp: "/fixture/tmp",
  dataDirectory: "/fixture/data",
  configPath: "/fixture/data/mcp.json",
  appBundlePath: "/fixture/home/Applications/MCP Gateway.app",
};
const initial = { version: "0.3.1", hash: "a".repeat(64) };
const target = { version: "0.3.2", hash: "b".repeat(64) };
const startup = (identity = initial, pid = 100): StartupMarker => ({
  schemaVersion: 1,
  phase: "initialized",
  ...roots,
  ...identity,
  pid,
  rpc,
  transaction: identity === target ? { status: "confirmed", ...target } : null,
});
const lines = (entries: unknown[]) =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
const flow = () => ({
  startupText: lines([startup(), startup(target, 200)]),
  preHandoffText: lines([
    {
      schemaVersion: 1,
      attemptId: 7,
      authoritativeAttemptId: 7,
      ...target,
      syntheticPid: 300,
      backendAlive: false,
    },
  ]),
  initial,
  target,
  roots,
  trigger: {
    phase: "triggered",
    rendererResult: "clicked",
    syntheticPid: 300,
    mcpReply: {
      content: [
        { type: "text", text: JSON.stringify({ value: "synthetic-update-activity", pid: 300 }) },
      ],
    },
  },
  oldProcessExit: 0,
  oldChildAlive: false,
  configByteIdentical: true,
});

test("requires one completed startup of each exact identity and a working renderer RPC", () => {
  expect(assertUpdateAcceptance(flow()).map((entry) => entry.pid)).toEqual([100, 200]);
});

for (const [name, entries] of [
  ["duplicate", [startup(), startup(target, 200), startup(target, 201)]],
  [
    "wrong-hash extra",
    [startup(), startup(target, 200), startup({ ...target, hash: "c".repeat(64) }, 201)],
  ],
  ["missing", [startup()]],
  ["wrong roots", [startup(), { ...startup(target, 200), home: "/real/home" }]],
  ["unconfirmed", [startup(), { ...startup(target, 200), transaction: null }]],
  ["missing RPC", [startup(), { ...startup(target, 200), rpc: null }]],
  ["incomplete", [startup(), { ...startup(target, 200), phase: "spawned" }]],
] as const) {
  test(`refuses ${name} startup evidence`, () => {
    expect(() => assertUpdateAcceptance({ ...flow(), startupText: lines([...entries]) })).toThrow();
  });
}

for (const text of [
  "",
  "garbage\n",
  `${lines([startup()])}garbage\n`,
  JSON.stringify(startup()),
  `${lines([startup()])}\n`,
]) {
  test("never silently discards malformed or truncated startup records", () => {
    expect(() => parseStartupMarkers(text)).toThrow();
  });
}

for (const change of [
  { oldProcessExit: 1 },
  { oldChildAlive: true },
  { configByteIdentical: false },
  { trigger: { ...flow().trigger, rendererResult: "no-confirm" } },
  { trigger: { ...flow().trigger, syntheticPid: null } },
  {
    trigger: {
      ...flow().trigger,
      mcpReply: { content: [{ type: "text", text: "synthetic-update-activity" }] },
    },
  },
]) {
  test("rejects incomplete trigger, cleanup, or configuration evidence", () => {
    expect(() => assertUpdateAcceptance({ ...flow(), ...change })).toThrow();
  });
}

test("startup recording awaits a validated renderer response and fails closed", async () => {
  await mkdir(resolve(".cache"), { recursive: true });
  const root = await mkdtemp(resolve(".cache/update-acceptance-test-"));
  const path = join(root, "startups.jsonl");
  try {
    await expect(
      recordCompletedStartup(path, startup(), async () => {
        throw new Error("RPC unavailable");
      }),
    ).rejects.toThrow("RPC unavailable");
    expect(await Bun.file(path).exists()).toBe(false);
    await expect(
      recordCompletedStartup(path, startup(), async () => ({ ...rpc, bodyOverscroll: "auto" })),
    ).rejects.toThrow();
    expect(await Bun.file(path).exists()).toBe(false);
    await recordCompletedStartup(path, startup(), async () => rpc);
    expect(parseStartupMarkers(await readFile(path, "utf8"))).toEqual([startup()]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private source hooks refuse missing and ambiguous patch anchors", () => {
  expect(replaceOnce("before hook after", "hook", "new")).toBe("before new after");
  expect(() => replaceOnce("before after", "hook", "new")).toThrow();
  expect(() => replaceOnce("hook hook", "hook", "new")).toThrow();
});

test("a live backend before handoff fails even when it exits before final collection", async () => {
  const root = await mkdtemp(resolve(".cache/update-order-test-"));
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const path = join(root, "pre-handoff.jsonl");
    await expect(
      recordPreHandoff(path, {
        attemptId: 7,
        authoritativeAttemptId: 7,
        ...target,
        syntheticPid: child.pid,
      }),
    ).rejects.toThrow("still alive");
    child.kill("SIGTERM");
    await child.exited;
    const input = flow();
    input.trigger.syntheticPid = child.pid;
    input.trigger.mcpReply.content[0] = {
      type: "text",
      text: JSON.stringify({ value: "synthetic-update-activity", pid: child.pid }),
    };
    const observed = await readFile(path, "utf8");
    expect(JSON.parse(observed).backendAlive).toBe(true);
    expect(() =>
      assertUpdateAcceptance({ ...input, preHandoffText: observed, oldChildAlive: false }),
    ).toThrow("before the exact update handoff");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
});
