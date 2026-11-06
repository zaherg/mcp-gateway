import { describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { QuitCoordinator } from "../../src/main/lifecycle";
import { MacLoginManager } from "../../src/main/login";
import { AppService, type UpdateManager } from "../../src/main/service";
import type { UpdateAttempt } from "../../src/main/updater/transaction";
import {
  configFor,
  controlledResolver,
  eventually,
  failListener,
  setup,
  stdio,
  TOKEN,
  within,
} from "../core/helpers";

const desktop = {
  platform: "macos",
  requestQuit: () => ({ attempt: 1, phase: "pending", error: null }) as const,
  quitStatus: () => ({ attempt: 0, phase: "idle", error: null }) as const,
} as const;

function fakeLogin() {
  let state = 0;
  let calls = 0;
  const manager = new MacLoginManager({
    status: () => state,
    set: (enabled) => {
      calls++;
      state = enabled ? 1 : 0;
      return 0;
    },
  });
  return {
    manager,
    get calls() {
      return calls;
    },
  };
}

describe("native application boundary", () => {
  test("validates every RPC shape and never reports private request values", async () => {
    const context = await setup();
    try {
      const login = fakeLogin();
      const app = new AppService(context.controller, login.manager, () => {}, desktop);
      for (const response of await Promise.all([
        app.handlers.snapshot({ password: "SECRET" }),
        app.handlers.start("SECRET"),
        app.handlers.stop(["SECRET"]),
        app.handlers.restartServer({ name: "echo", command: "SECRET" }),
        app.handlers.restartServer({ name: "../SECRET" }),
        app.handlers.copyEndpoint({ name: 3 }),
        app.handlers.copyClientConfig({ name: "missing" }),
        app.handlers.saveConfig({ text: "SECRET", expectedRevision: "bad" }),
      ])) {
        expect(response).toMatchObject({ ok: false, error: { code: "InvalidRequest" } });
        expect(JSON.stringify(response)).not.toContain("SECRET");
      }
      expect(login.calls).toBe(0);
      expect(context.controller.snapshot().running).toBe(false);
    } finally {
      await context.cleanup();
    }
  });

  test("locked configuration exposes safe recovery guidance and permits retry after removal", async () => {
    const context = await setup();
    const lock = `${context.path}.lock`;
    try {
      const app = new AppService(context.controller, fakeLogin().manager, () => {}, desktop);
      const before = context.controller.snapshot();
      const request = { text: `${before.configText}\n`, expectedRevision: before.revision };
      await writeFile(lock, "", { mode: 0o600 });
      const result = await app.handlers.saveConfig(request);
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "ConfigLocked",
          message:
            "Configuration is locked. If mcp.json.lock beside the configuration is stale, quit every app instance and confirm no writer is active before removing it and retrying.",
        },
      });
      expect(await readFile(lock, "utf8")).toBe("");
      expect(await readFile(context.path, "utf8")).toBe(before.configText);
      await rm(lock);
      expect((await app.handlers.saveConfig(request)).ok).toBe(true);
      expect(await readFile(context.path, "utf8")).toBe(request.text);
    } finally {
      await rm(lock, { force: true });
      await context.cleanup();
    }
  });

  test("saves separately from exposure, registers login, rejects stale saves before native mutation, and copies exact route", async () => {
    const context = await setup();
    try {
      const login = fakeLogin();
      const copied: string[] = [];
      const app = new AppService(
        context.controller,
        login.manager,
        (text) => copied.push(text),
        desktop,
      );
      const before = context.controller.snapshot();
      const next = JSON.parse(before.configText);
      next.gateway.launchAtLogin = true;
      const response = await app.handlers.saveConfig({
        text: JSON.stringify(next),
        expectedRevision: before.revision,
      });
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("Save failed");
      expect(response.value.login.enabled).toBe(true);
      expect(response.value.gateway.running).toBe(false);
      next.gateway.launchAtLogin = false;
      expect(
        (
          await app.handlers.saveConfig({
            text: JSON.stringify(next),
            expectedRevision: before.revision,
          })
        ).ok,
      ).toBe(false);
      expect(login.calls).toBe(1);
      await app.handlers.copyEndpoint({ name: "echo" });
      await app.handlers.copyClientConfig({ name: "echo" });
      expect(copied[0]).toBe(`http://127.0.0.1:${context.config.gateway.port}/mcp/echo`);
      expect(JSON.parse(copied[1])).toEqual({
        mcpServers: { echo: { url: copied[0], headers: { Authorization: `Bearer ${TOKEN}` } } },
      });
      expect((await app.handlers.start()).ok).toBe(true);
      expect(context.controller.snapshot().running).toBe(true);
      expect((await app.handlers.stop()).ok).toBe(true);
      expect(context.controller.snapshot().running).toBe(false);
    } finally {
      await context.cleanup();
    }
  });

  test("both clipboard actions use current routes and token after a listener self-close", async () => {
    const context = await setup(await configFor({ kept: stdio(), removed: stdio() }));
    const copied: string[] = [];
    const app = new AppService(
      context.controller,
      fakeLogin().manager,
      (text) => copied.push(text),
      desktop,
    );
    try {
      const started = await context.controller.start();
      failListener(context.controller);
      const next = await configFor({ kept: stdio(), added: stdio() });
      next.gateway.token = "changed-synthetic-token-0123456789abcdef";
      expect(
        await app.handlers.saveConfig({
          text: JSON.stringify(next),
          expectedRevision: started.revision,
        }),
      ).toMatchObject({ ok: true });
      for (const name of ["kept", "added"]) {
        expect(await app.handlers.copyEndpoint({ name })).toEqual({ ok: true, value: null });
        expect(await app.handlers.copyClientConfig({ name })).toEqual({ ok: true, value: null });
        const endpoint = `http://127.0.0.1:${next.gateway.port}/mcp/${name}`;
        expect(copied.splice(0)).toEqual([
          endpoint,
          JSON.stringify(
            {
              mcpServers: {
                [name]: {
                  url: endpoint,
                  headers: { Authorization: `Bearer ${next.gateway.token}` },
                },
              },
            },
            null,
            2,
          ),
        ]);
      }
      expect(await app.handlers.copyEndpoint({ name: "removed" })).toMatchObject({
        ok: false,
        error: { code: "InvalidRequest" },
      });
      expect(await app.handlers.copyClientConfig({ name: "removed" })).toMatchObject({
        ok: false,
        error: { code: "InvalidRequest" },
      });
      expect(copied).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });

  test("a native refusal remains visible after config persistence, not a false enabled state", async () => {
    const context = await setup();
    try {
      const login = new MacLoginManager({ status: () => 0, set: () => 1 });
      const app = new AppService(context.controller, login, () => {}, desktop);
      const before = context.controller.snapshot();
      const next = JSON.parse(before.configText);
      next.gateway.launchAtLogin = true;
      const response = await app.handlers.saveConfig({
        text: JSON.stringify(next),
        expectedRevision: before.revision,
      });
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("Save failed");
      expect(response.value.login.enabled).toBe(false);
      expect(response.value.login.error).toContain("macOS refused");
      expect(JSON.parse(response.value.gateway.configText).gateway.launchAtLogin).toBe(true);
    } finally {
      await context.cleanup();
    }
  });

  test.each([1, 2])(
    "failed login disable retries a clean save while native status stays %i",
    async (initialState) => {
      const initial = await configFor();
      initial.gateway.launchAtLogin = true;
      const context = await setup(initial);
      let actual: number = initialState;
      let refuse = true;
      const calls: boolean[] = [];
      const login = new MacLoginManager({
        status: () => actual,
        set: (enabled) => {
          calls.push(enabled);
          if (refuse) return 1;
          actual = enabled ? 1 : 0;
          return 0;
        },
      });
      const app = new AppService(context.controller, login, () => {}, desktop);
      try {
        const before = context.controller.snapshot();
        const config = JSON.parse(before.configText);
        config.gateway.launchAtLogin = false;
        config.gateway.autoStart = true;
        const first = await app.handlers.saveConfig({
          text: JSON.stringify(config),
          expectedRevision: before.revision,
        });
        expect(first.ok).toBe(true);
        if (!first.ok) throw new Error("Expected persisted config");
        expect(first.value.login.enabled).toBe(initialState === 1);
        expect(first.value.login.error).toContain("refused");
        expect(first.value.gateway.running).toBe(false);
        expect(JSON.parse(first.value.gateway.configText).gateway.launchAtLogin).toBe(false);
        for (let poll = 0; poll < 3; poll++)
          expect(await app.handlers.snapshot()).toMatchObject({
            ok: true,
            value: { login: first.value.login },
          });
        expect(calls).toEqual([false]);
        expect(
          await app.handlers.saveConfig({
            text: '{"broken":true}',
            expectedRevision: first.value.gateway.revision,
          }),
        ).toMatchObject({ ok: false, error: { code: "InvalidConfig" } });
        expect(
          await app.handlers.saveConfig({
            text: first.value.gateway.configText,
            expectedRevision: before.revision,
          }),
        ).toMatchObject({ ok: false, error: { code: "StaleRevision" } });
        expect(calls).toEqual([false]);
        refuse = false;
        const retry = await app.handlers.saveConfig({
          text: first.value.gateway.configText,
          expectedRevision: first.value.gateway.revision,
        });
        expect(retry.ok).toBe(true);
        if (!retry.ok) throw new Error("Expected successful retry");
        expect(retry.value.login).toEqual({ enabled: false, supported: true, error: null });
        expect(calls).toEqual([false, false]);
        expect(retry.value.gateway.configText).toBe(first.value.gateway.configText);
        expect(retry.value.gateway.revision).toBe(first.value.gateway.revision);
        expect(retry.value.gateway.running).toBe(false);
        await app.handlers.saveConfig({
          text: retry.value.gateway.configText,
          expectedRevision: retry.value.gateway.revision,
        });
        expect(calls).toEqual([false, false]);
      } finally {
        await context.cleanup();
      }
    },
  );

  test("clipboard exceptions and closed-controller requests return sanitized failures", async () => {
    const context = await setup();
    try {
      const app = new AppService(
        context.controller,
        fakeLogin().manager,
        () => {
          throw new Error("SECRET clipboard payload");
        },
        desktop,
      );
      expect(await app.handlers.copyClientConfig({ name: "echo" })).toEqual({
        ok: false,
        error: {
          code: "OperationFailed",
          message: "The application operation failed. Open Logs for details.",
          occurrenceId: expect.any(String),
        },
      });
      expect(
        context.controller
          .readLogs({ after: 0 })
          .entries.some((entry) => entry.text.includes("SECRET clipboard payload")),
      ).toBe(true);
      expect(context.controller.snapshot().operationalError).toBeNull();
      expect(JSON.stringify(context.controller.snapshot().events)).not.toContain(
        "SECRET clipboard payload",
      );
      await context.controller.close();
      const response = await app.handlers.start();
      expect(response.ok).toBe(false);
      if (response.ok) throw new Error("Closed controller must refuse start");
      expect(response.error.code).toBe("Closed");
    } finally {
      await context.cleanup();
    }
  });

  test("isolated native verification cannot change login registration", () => {
    let calls = 0;
    const login = new MacLoginManager(
      {
        status: () => 0,
        set: () => {
          calls++;
          return 0;
        },
      },
      false,
    );
    expect(login.setEnabled(true).supported).toBe(false);
    expect(calls).toBe(0);
    expect(new MacLoginManager({ status: () => 2, set: () => 0 }).status().error).toContain(
      "Approve",
    );
  });
});

test("JSONC service saves/copies with explicit mode and retains source environment references", async () => {
  const config = {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Preserve a source environment reference, not an expanded secret.
    gateway: { host: "127.0.0.1", port: 8765, token: "${JSONC_SERVICE_TOKEN}" },
    mcpServers: { remote: { url: "https://synthetic.example/mcp" } },
  };
  const text = `// retained service comment\n${JSON.stringify(config)}`;
  const previous = process.env.JSONC_SERVICE_TOKEN;
  process.env.JSONC_SERVICE_TOKEN = TOKEN;
  const context = await setup(config, "jsonc", text);
  try {
    const copied: string[] = [];
    const login = fakeLogin();
    const app = new AppService(
      context.controller,
      login.manager,
      (value) => copied.push(value),
      desktop,
    );
    const before = context.controller.snapshot();
    expect(
      await app.handlers.saveConfig({ text, expectedRevision: before.revision }),
    ).toMatchObject({ ok: true, value: { gateway: { configText: text, configFormat: "jsonc" } } });
    expect(await app.handlers.copyClientConfig({ name: "remote" })).toEqual({
      ok: true,
      value: null,
    });
    expect(JSON.parse(copied[0]).mcpServers.remote.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Preserve a source environment reference, not an expanded secret.
    expect(context.controller.snapshot().configText).toContain("${JSONC_SERVICE_TOKEN}");
    expect(context.controller.snapshot().configText).not.toContain(TOKEN);
    expect(login.calls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.JSONC_SERVICE_TOKEN;
    else process.env.JSONC_SERVICE_TOKEN = previous;
    await context.cleanup();
  }
});

test("local log RPC validates strict queries, serves incremental pages and clear independently from real failures", async () => {
  const context = await setup();
  const app = new AppService(context.controller, fakeLogin().manager, () => {}, desktop);
  try {
    const invalidShapes = [undefined, null, {}, { after: 0, extra: "fake-private" }];
    const invalidValues = [
      { after: -1 },
      { after: 0.5 },
      { after: Number.MAX_SAFE_INTEGER + 1 },
      { after: 0, level: "fatal-private" },
      { after: 0, server: "../fake-private" },
      { after: 0, text: "x".repeat(513) },
    ];
    for (const [inputs, message] of [
      [invalidShapes, "The application request is invalid."],
      [invalidValues, "The log query is invalid."],
    ] as const) {
      for (const input of inputs) {
        const response = await app.handlers.readLogs(input);
        expect(response).toMatchObject({ ok: false, error: { code: "InvalidRequest", message } });
        if (!response.ok) expect(JSON.stringify(response.error)).not.toContain("fake-private");
      }
    }
    expect(await app.handlers.clearLogs({ private: "fake-private" })).toMatchObject({
      ok: false,
      error: { code: "InvalidRequest" },
    });
    const page = await app.handlers.readLogs({ after: 0, level: "info", text: "configuration" });
    if (!page.ok) throw new Error("Expected local log page");
    expect(page.value.entries[0].text).toBe("Configuration loaded.");
    const poll = await app.handlers.readLogs({ after: page.value.cursor });
    expect(poll).toMatchObject({ ok: true, value: { entries: [], hasMore: false } });
    const cleared = await app.handlers.clearLogs();
    expect(cleared).toMatchObject({ ok: true, value: { entries: [], generation: 1 } });
  } finally {
    await context.cleanup();
  }
});

test("Quit validates parameters before invoking the local callback and acknowledges only the request", async () => {
  const context = await setup();
  let requested = 0;
  const app = new AppService(context.controller, fakeLogin().manager, () => {}, {
    platform: "linux",
    requestQuit: () => {
      requested++;
      return desktop.requestQuit();
    },
    quitStatus: desktop.quitStatus,
  });
  try {
    for (const input of [{ secret: "fixture-only" }, "fixture-only", [], false])
      expect(await app.handlers.quit(input)).toMatchObject({
        ok: false,
        error: { code: "InvalidRequest" },
      });
    expect(requested).toBe(0);
    expect(await app.handlers.snapshot()).toMatchObject({ ok: true, value: { platform: "linux" } });
    expect(await app.handlers.quit()).toEqual({
      ok: true,
      value: { requested: true, status: { attempt: 1, phase: "pending", error: null } },
    });
    expect(requested).toBe(1);
    // Cleanup belongs to QuitCoordinator; RPC must not claim it has completed.
    expect((await app.handlers.start()).ok).toBe(true);
    const failing = new AppService(context.controller, fakeLogin().manager, () => {}, {
      platform: "linux",
      requestQuit: () => {
        throw new Error("synthetic-private-quit");
      },
      quitStatus: desktop.quitStatus,
    });
    expect(await failing.handlers.quit()).toMatchObject({
      ok: false,
      error: { code: "OperationFailed" },
    });
  } finally {
    await context.cleanup();
  }
});

test("local Quit feedback survives delayed partial cleanup failure and permits a fresh retry", async () => {
  const context = await setup();
  let nativeClosed = false;
  let attempts = 0;
  let rejectCleanup = (_error: Error) => {};
  let finishCleanup = () => {};
  let exits = 0;
  let vetoes = 0;
  const login = {
    status: () => {
      if (nativeClosed) throw new Error("synthetic-private-released-library");
      return { enabled: false, supported: true, error: null };
    },
    setEnabled: (_enabled: boolean) => {
      throw new Error("released login must not be mutated");
    },
  };
  const quit = new QuitCoordinator(
    async () => {
      await context.controller.close();
      nativeClosed = true;
      attempts++;
      await new Promise<void>((resolve, reject) => {
        rejectCleanup = reject;
        finishCleanup = resolve;
      });
    },
    () => {
      exits++;
    },
    (error) => context.controller.recordLocalError(error),
  );
  const app = new AppService(context.controller, login, () => {}, {
    platform: "linux",
    requestQuit: () => {
      quit.handle(() => {
        vetoes++;
      });
      return quit.status();
    },
    quitStatus: () => quit.status(),
  });
  try {
    const before = context.controller.snapshot();
    const attemptedSave = { text: `${before.configText}\n`, expectedRevision: before.revision };
    expect(await app.handlers.quitStatus({ secret: "fixture-only" })).toMatchObject({
      ok: false,
      error: { code: "InvalidRequest" },
    });
    expect(await app.handlers.quitStatus()).toEqual({
      ok: true,
      value: { attempt: 0, phase: "idle", error: null },
    });
    expect(await app.handlers.quit()).toEqual({
      ok: true,
      value: { requested: true, status: { attempt: 1, phase: "pending", error: null } },
    });
    await eventually(() => attempts === 1);
    expect(await app.handlers.saveConfig(attemptedSave)).toMatchObject({
      ok: false,
      error: { code: "InvalidRequest" },
    });
    expect(context.controller.snapshot().configText).toBe(before.configText);
    rejectCleanup(new Error("synthetic-private-partial-cleanup"));
    await eventually(() => quit.status().phase === "failed");
    const failed = await app.handlers.quitStatus();
    expect(failed).toEqual({
      ok: true,
      value: {
        attempt: 1,
        phase: "failed",
        error: "Quit cleanup failed. The app has not exited. Retry Quit.",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("synthetic-private");
    expect(await app.handlers.snapshot()).toMatchObject({
      ok: true,
      value: { gateway: { running: false }, login: { supported: true } },
    });
    expect(await app.handlers.saveConfig(attemptedSave)).toMatchObject({
      ok: false,
      error: { code: "InvalidRequest" },
    });
    expect(context.controller.snapshot().configText).toBe(before.configText);
    expect(exits).toBe(0);
    expect(await app.handlers.quit()).toEqual({
      ok: true,
      value: { requested: true, status: { attempt: 2, phase: "pending", error: null } },
    });
    await eventually(() => attempts === 2);
    expect(failed).toMatchObject({ value: { attempt: 1, phase: "failed" } });
    finishCleanup();
    await eventually(() => exits === 1);
    expect(exits).toBe(1);
    expect(vetoes).toBe(2);
    expect(await app.handlers.quitStatus()).toEqual({
      ok: true,
      value: { attempt: 2, phase: "ready", error: null },
    });
    expect(await app.handlers.saveConfig(attemptedSave)).toMatchObject({
      ok: false,
      error: { code: "InvalidRequest" },
    });
    expect(context.controller.snapshot().configText).toBe(before.configText);
  } finally {
    finishCleanup();
    await context.cleanup();
  }
});

test("service Stop cancels a stalled save instead of waiting behind its service serialization", async () => {
  const resolver = controlledResolver();
  const context = await setup(await configFor(), "json", undefined, { resolve: resolver.resolve });
  const app = new AppService(context.controller, fakeLogin().manager, () => {}, desktop);
  try {
    await context.controller.start();
    const before = context.controller.snapshot();
    const next = JSON.parse(before.configText);
    next.mcpServers.stalled = { url: `http://stall.synthetic:${context.config.gateway.port}/mcp` };
    const save = app.handlers.saveConfig({
      text: JSON.stringify(next),
      expectedRevision: before.revision,
    });
    save.catch(() => {});
    await eventually(() => resolver.pending === 1);
    const stopped = await within(app.handlers.stop());
    expect(stopped).toMatchObject({ ok: true, value: { gateway: { running: false } } });
    expect(await save).toMatchObject({ ok: false, error: { code: "Cancelled" } });
    expect(await readFile(context.path, "utf8")).toBe(before.configText);
    expect(context.controller.snapshot().revision).toBe(before.revision);
  } finally {
    resolver.release();
    await context.cleanup();
  }
}, 15_000);

test("service Quit is not blocked behind a stalled save and cancels it before native cleanup", async () => {
  const resolver = controlledResolver();
  const context = await setup(await configFor(), "json", undefined, { resolve: resolver.resolve });
  let exits = 0;
  const quit = new QuitCoordinator(
    () => context.controller.close(),
    () => {
      exits++;
    },
    () => {},
  );
  const app = new AppService(context.controller, fakeLogin().manager, () => {}, {
    platform: "macos",
    requestQuit: () => {
      quit.handle(() => {});
      return quit.status();
    },
    quitStatus: () => quit.status(),
  });
  try {
    await context.controller.start();
    const before = context.controller.snapshot();
    const next = JSON.parse(before.configText);
    next.mcpServers.stalled = { url: `http://stall.synthetic:${context.config.gateway.port}/mcp` };
    const save = app.handlers.saveConfig({
      text: JSON.stringify(next),
      expectedRevision: before.revision,
    });
    save.catch(() => {});
    await eventually(() => resolver.pending === 1);
    const requested = await within(app.handlers.quit());
    expect(requested).toMatchObject({
      ok: true,
      value: { requested: true, status: { phase: "pending" } },
    });
    await eventually(() => quit.status().phase === "ready", 6_000);
    expect(exits).toBe(1);
    expect(await save).toMatchObject({ ok: false, error: { code: "Cancelled" } });
    expect(context.controller.snapshot().running).toBe(false);
    expect(await readFile(context.path, "utf8")).toBe(before.configText);
    expect(context.controller.snapshot().revision).toBe(before.revision);
  } finally {
    resolver.release();
    await context.cleanup();
  }
}, 20_000);

test("invalid lifecycle parameters never cancel validation or request native Quit", async () => {
  const resolver = controlledResolver();
  const context = await setup(await configFor(), "json", undefined, { resolve: resolver.resolve });
  let requested = 0;
  const app = new AppService(context.controller, fakeLogin().manager, () => {}, {
    platform: "linux",
    requestQuit: () => {
      requested++;
      return desktop.requestQuit();
    },
    quitStatus: desktop.quitStatus,
  });
  try {
    await context.controller.start();
    const before = context.controller.snapshot();
    const next = JSON.parse(before.configText);
    next.mcpServers.stalled = { url: `http://stall.synthetic:${context.config.gateway.port}/mcp` };
    const save = app.handlers.saveConfig({
      text: JSON.stringify(next),
      expectedRevision: before.revision,
    });
    save.catch(() => {});
    await eventually(() => resolver.pending === 1);
    const invalid: Array<() => Promise<unknown>> = [
      () => app.handlers.stop(["SECRET"]),
      () => app.handlers.quit({ secret: "SECRET" }),
      () => app.handlers.quitStatus("SECRET"),
    ];
    for (const request of invalid) {
      const response = await within(request());
      expect(response).toMatchObject({ ok: false, error: { code: "InvalidRequest" } });
      expect(JSON.stringify(response)).not.toContain("SECRET");
    }
    expect(requested).toBe(0);
    expect(resolver.pending).toBe(1);
    expect(context.controller.snapshot().running).toBe(true);
    resolver.release();
    expect(await save).toMatchObject({ ok: true });
    expect(await readFile(context.path, "utf8")).not.toBe(before.configText);
  } finally {
    resolver.release();
    await context.cleanup();
  }
}, 15_000);

test("service work queued before Stop cannot persist or reopen through a fresh controller lifetime", async () => {
  const resolver = controlledResolver();
  const context = await setup(await configFor(), "json", undefined, { resolve: resolver.resolve });
  const app = new AppService(context.controller, fakeLogin().manager, () => {}, desktop);
  try {
    await context.controller.start();
    const before = context.controller.snapshot();
    const gateway = JSON.parse(before.configText).gateway;
    const stalled = JSON.stringify({
      gateway,
      mcpServers: {
        echo: stdio(),
        stalled: { url: `http://stall.synthetic:${context.config.gateway.port}/mcp` },
      },
    });
    const queuedText = `${JSON.stringify(
      { gateway, mcpServers: { echo: stdio({ SYNTHETIC_ENV: "queued" }) } },
      null,
      2,
    )}\n`;
    const first = app.handlers.saveConfig({ text: stalled, expectedRevision: before.revision });
    first.catch(() => {});
    await eventually(() => resolver.pending === 1);
    const second = app.handlers.saveConfig({ text: queuedText, expectedRevision: before.revision });
    second.catch(() => {});
    const queuedStart = app.handlers.start();
    queuedStart.catch(() => {});
    const stopped = await within(app.handlers.stop());
    expect(stopped).toMatchObject({ ok: true, value: { gateway: { running: false } } });
    expect(await first).toMatchObject({ ok: false, error: { code: "Cancelled" } });
    // These were requested before Stop and must not capture a fresh lifetime
    // when their service queue turn arrives.
    expect(await second).toMatchObject({ ok: false, error: { code: "Cancelled" } });
    expect(await queuedStart).toMatchObject({ ok: false, error: { code: "Cancelled" } });
    expect(context.controller.snapshot().running).toBe(false);
    expect(await readFile(context.path, "utf8")).toBe(before.configText);
    expect(context.controller.snapshot().revision).toBe(before.revision);
    resolver.release();
    // New requests admitted after Stop do use a fresh lifetime.
    const started = await app.handlers.start();
    expect(started).toMatchObject({ ok: true, value: { gateway: { running: true } } });
    const saved = await app.handlers.saveConfig({
      text: queuedText,
      expectedRevision: context.controller.snapshot().revision,
    });
    expect(saved).toMatchObject({ ok: true });
    expect(await readFile(context.path, "utf8")).toBe(queuedText);
  } finally {
    resolver.release();
    await context.cleanup();
  }
}, 20_000);

function updateManager(
  options: {
    status?: Partial<import("../../src/shared/rpc").UpdateStatus>;
    check?: () => Promise<import("../../src/shared/rpc").UpdateStatus>;
    restart?: Promise<import("../../src/shared/rpc").QuitStatus>;
  } = {},
) {
  let status: import("../../src/shared/rpc").UpdateStatus = {
    supported: true,
    installationEnabled: true,
    automaticUpdates: true,
    installedVersion: "0.3.1",
    availableVersion: null,
    availableHash: null,
    readyVersion: null,
    phase: "idle",
    error: null,
    preferenceError: null,
    recoveryRequired: false,
    recoveryPath: null,
    checkedAt: null,
    ...options.status,
  };
  const calls: string[] = [];
  let reserved: UpdateAttempt | undefined;
  return {
    calls,
    manager: {
      statusValue: () => status,
      check: async () => {
        calls.push("check");
        if (options.check) return options.check();
        status = {
          ...status,
          phase: "available",
          availableVersion: "0.3.2",
          availableHash: "next123456",
        };
        return status;
      },
      download: async () => {
        calls.push("download");
        status = { ...status, phase: "ready", readyVersion: "0.3.2" };
        return status;
      },
      setAutomatic: async (automatic: boolean) => {
        calls.push(`automatic:${automatic}`);
        status = { ...status, automaticUpdates: automatic };
        return status;
      },
      beginRestart: (version, hash) => {
        reserved ??= {
          id: 1,
          signal: new AbortController().signal,
          candidate: {
            schema_version: 1,
            identifier: "dev.srvr.mcpgateway",
            channel: "stable",
            version,
            hash,
            artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
            prepared_path: "/synthetic/prepared.json",
            prepared_sha256: "a".repeat(64),
            retained_tar_path: "/synthetic/target.tar",
            archive_sha256: "b".repeat(64),
            archive_bytes: 1,
            frozen_at: "2026-11-03T00:00:00.000Z",
          },
        };
        status = { ...status, phase: "restarting", attemptId: reserved.id };
        return reserved;
      },
      restartToUpdate: async (version, hash, admittedAttempt) => {
        expect(admittedAttempt).toBe(reserved);
        calls.push(`restart:${version}:${hash}`);
        if (version !== "0.3.2" || hash !== "next123456") throw new Error("unexpected");
        if (options.restart) return options.restart;
        return { attempt: 1, phase: "pending", error: null } as const;
      },
    } satisfies UpdateManager,
  };
}

test("update status is included in snapshots and every update RPC validates its own shape", async () => {
  const context = await setup();
  try {
    const updates = updateManager();
    const app = new AppService(
      context.controller,
      fakeLogin().manager,
      () => {},
      desktop,
      updates.manager,
    );
    expect(await app.handlers.snapshot()).toMatchObject({
      ok: true,
      value: { update: { supported: true, phase: "idle", installedVersion: "0.3.1" } },
    });
    for (const response of await Promise.all([
      app.handlers.updatesStatus({ secret: "SECRET" }),
      app.handlers.updatesCheck("SECRET"),
      app.handlers.updatesDownload(["SECRET"]),
      app.handlers.updatesSetAutomatic({ automatic: "yes" }),
      app.handlers.updatesSetAutomatic({ automatic: true, secret: "SECRET" }),
      app.handlers.updatesRestart({ version: "0.3.2", hash: "../../SECRET" }),
      app.handlers.updatesRestart({ version: 3, hash: "next123456" }),
    ])) {
      expect(response).toMatchObject({ ok: false, error: { code: "InvalidRequest" } });
      expect(JSON.stringify(response)).not.toContain("SECRET");
    }
    expect(updates.calls).toEqual([]);
    expect(await app.handlers.updatesCheck()).toMatchObject({
      ok: true,
      value: { phase: "available", availableVersion: "0.3.2" },
    });
    expect(await app.handlers.updatesDownload()).toMatchObject({
      ok: true,
      value: { phase: "ready", readyVersion: "0.3.2" },
    });
    expect(await app.handlers.updatesSetAutomatic({ automatic: false })).toMatchObject({
      ok: true,
      value: { automaticUpdates: false },
    });
    expect(
      await app.handlers.updatesRestart({ version: "0.3.2", hash: "next123456" }),
    ).toMatchObject({
      ok: true,
      value: { requested: true, status: { phase: "pending" } },
    });
    expect(updates.calls).toEqual([
      "check",
      "download",
      "automatic:false",
      "restart:0.3.2:next123456",
    ]);
  } finally {
    await context.cleanup();
  }
});

test("update check does not block Stop and update policy errors are sanitized", async () => {
  const context = await setup();
  try {
    let release: (status: import("../../src/shared/rpc").UpdateStatus) => void = () => {};
    const pending = new Promise<import("../../src/shared/rpc").UpdateStatus>((resolve) => {
      release = resolve;
    });
    const updates = updateManager({ check: () => pending });
    const app = new AppService(
      context.controller,
      fakeLogin().manager,
      () => {},
      desktop,
      updates.manager,
    );
    const checking = app.handlers.updatesCheck();
    expect(await app.handlers.stop()).toMatchObject({ ok: true });
    release({
      supported: true,
      installationEnabled: true,
      automaticUpdates: true,
      installedVersion: "0.3.1",
      availableVersion: null,
      availableHash: null,
      readyVersion: null,
      phase: "error",
      error: "The update operation failed.",
      preferenceError: null,
      recoveryRequired: false,
      recoveryPath: null,
      checkedAt: null,
    });
    expect(await checking).toMatchObject({
      ok: true,
      value: { phase: "error", error: "The update operation failed." },
    });
    const failing = updateManager({
      check: async () => {
        const { UpdatePolicyError } = await import("../../src/main/updater/coordinator");
        throw new UpdatePolicyError("UpdateNotReady");
      },
    });
    const failingApp = new AppService(
      context.controller,
      fakeLogin().manager,
      () => {},
      desktop,
      failing.manager,
    );
    const response = await failingApp.handlers.updatesCheck();
    expect(response).toMatchObject({ ok: false, error: { code: "UpdateNotReady" } });
    expect(JSON.stringify(response)).not.toContain("SECRET");
  } finally {
    await context.cleanup();
  }
});

test("configuration saves are refused once update restart handoff has started", async () => {
  const context = await setup();
  try {
    const updates = updateManager({ status: { phase: "restarting", readyVersion: "0.3.2" } });
    const app = new AppService(
      context.controller,
      fakeLogin().manager,
      () => {},
      desktop,
      updates.manager,
    );
    const before = context.controller.snapshot();
    const response = await app.handlers.saveConfig({
      text: before.configText,
      expectedRevision: before.revision,
    });
    expect(response).toMatchObject({ ok: false, error: { code: "InvalidRequest" } });
    expect(context.controller.snapshot().revision).toBe(before.revision);
  } finally {
    await context.cleanup();
  }
});

test("update restart refusal keeps a pending native quit visible", async () => {
  const context = await setup();
  try {
    const updates = updateManager({ status: { phase: "ready", readyVersion: "0.3.2" } });
    const app = new AppService(
      context.controller,
      fakeLogin().manager,
      () => {},
      {
        ...desktop,
        quitStatus: () => ({ attempt: 2, phase: "pending", error: null }) as const,
      },
      updates.manager,
    );
    expect(
      await app.handlers.updatesRestart({ version: "0.3.2", hash: "next123456" }),
    ).toMatchObject({ ok: false, error: { code: "InvalidRequest" } });
    expect(updates.calls).toEqual([]);
  } finally {
    await context.cleanup();
  }
});

test("a failed Quit state still permits an explicit Retry Update with the ready candidate", async () => {
  const context = await setup();
  try {
    const updates = updateManager({ status: { phase: "ready", readyVersion: "0.3.2" } });
    const app = new AppService(
      context.controller,
      fakeLogin().manager,
      () => {},
      {
        ...desktop,
        quitStatus: () =>
          ({ attempt: 2, phase: "failed", error: "Update handoff failed." }) as const,
      },
      updates.manager,
    );
    expect(
      await app.handlers.updatesRestart({ version: "0.3.2", hash: "next123456" }),
    ).toMatchObject({ ok: true, value: { requested: true, status: { phase: "pending" } } });
    expect(updates.calls).toEqual(["restart:0.3.2:next123456"]);
  } finally {
    await context.cleanup();
  }
});

test("restart reservation remains visible while restart preflight acknowledgement is pending", async () => {
  const context = await setup();
  let release: (status: import("../../src/shared/rpc").QuitStatus) => void = () => {};
  const pending = new Promise<import("../../src/shared/rpc").QuitStatus>((resolve) => {
    release = resolve;
  });
  try {
    const updates = updateManager({
      status: { phase: "ready", readyVersion: "0.3.2", availableHash: "next123456" },
      restart: pending,
    });
    const app = new AppService(
      context.controller,
      fakeLogin().manager,
      () => {},
      desktop,
      updates.manager,
    );
    const request = app.handlers.updatesRestart({ version: "0.3.2", hash: "next123456" });
    expect(await app.handlers.updatesStatus()).toMatchObject({
      ok: true,
      value: { phase: "restarting" },
    });
    release({ attempt: 1, phase: "pending", error: null });
    await expect(request).resolves.toMatchObject({ ok: true });
  } finally {
    await context.cleanup();
  }
});
