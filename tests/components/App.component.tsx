import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { App } from "../../src/mainview/App";
import type { AppResult } from "../../src/shared/rpc";
import { config, failure, fixture, ok, snapshot } from "./client";

async function mount() {
  const context = fixture();
  render(<App client={context.client} />);
  await screen.findByRole("heading", { name: "No servers configured" });
  return { ...context, user: userEvent.setup() };
}

describe("App structured editor", () => {
  test.each([
    ["Arguments (JSON array)", "{}", "Arguments must be a JSON array of strings."],
    ["Arguments (JSON array)", "[1]", "Arguments must be a JSON array of strings."],
    [
      "Environment (JSON object)",
      '{"N":1}',
      "Environment must be a JSON object with string values.",
    ],
    ["Environment (JSON object)", "[]", "Environment must be a JSON object with string values."],
  ])("rejects %s=%s without losing other fields", async (label, invalid, error) => {
    const { user, client } = await mount();
    await user.click(screen.getByRole("button", { name: "Add server" }));
    await user.type(screen.getByLabelText("Server name", { exact: false }), "local");
    await user.type(screen.getByLabelText("Command", { exact: true }), "/synthetic/command");
    fireEvent.change(screen.getByLabelText(label), { target: { value: invalid } });
    await user.click(screen.getByRole("button", { name: "Apply to draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent(error);
    expect(screen.getByLabelText("Command", { exact: true })).toHaveValue("/synthetic/command");
    expect(client.saveConfig).not.toHaveBeenCalled();
  });

  test("stdio fields preserve argument boundaries, environment values and working directory", async () => {
    const { user, client } = await mount();
    await user.click(screen.getByRole("button", { name: "Add server" }));
    for (const [label, value] of [
      ["Server name", "local"],
      ["Command", "/synthetic/command"],
      ["Arguments (JSON array)", '["serve","two words"]'],
      ["Environment (JSON object)", '{"MODE":"test"}'],
      ["Working directory", "/synthetic/workspace"],
    ])
      fireEvent.change(screen.getByLabelText(label, { exact: false }), { target: { value } });
    await user.click(screen.getByRole("button", { name: "Apply to draft" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(JSON.parse(client.saveConfig.mock.calls[0][0].text).mcpServers.local).toEqual({
      command: "/synthetic/command",
      args: ["serve", "two words"],
      env: { MODE: "test" },
      cwd: "/synthetic/workspace",
      disabled: false,
    });
  });

  test("HTTP fields retain typed header values and serialize transport-specific data only", async () => {
    const { user, client } = await mount();
    await user.click(screen.getByRole("button", { name: "Add server" }));
    await user.type(screen.getByLabelText("Server name", { exact: false }), "remote");
    await user.selectOptions(screen.getByLabelText("Transport", { exact: true }), "http");
    await user.type(
      screen.getByLabelText("Upstream URL", { exact: false }),
      "https://synthetic.example/mcp",
    );
    fireEvent.change(screen.getByLabelText("Headers (JSON object)"), {
      target: { value: '{"X-Test":false}' },
    });
    await user.click(screen.getByRole("button", { name: "Apply to draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Headers must be a JSON object with string values.",
    );
    fireEvent.change(screen.getByLabelText("Headers (JSON object)"), {
      target: { value: '{"X-Test":"value"}' },
    });
    await user.click(screen.getByRole("button", { name: "Apply to draft" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(JSON.parse(client.saveConfig.mock.calls[0][0].text).mcpServers).toEqual({
      remote: {
        url: "https://synthetic.example/mcp",
        headers: { "X-Test": "value" },
        disabled: false,
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("StaleRevision");
    expect(screen.getByRole("heading", { name: "remote" })).toBeVisible();
  });

  test("dialog cancel and close restore the opener focus without applying the Bear preset", async () => {
    const { user, client } = await mount();
    const opener = screen.getByRole("button", { name: "Add server" });
    await user.click(opener);
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(opener).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Use macOS Bear preset" }));
    expect(screen.getByLabelText("Command", { exact: true })).toHaveValue(
      "/Applications/Bear.app/Contents/MacOS/bearcli",
    );
    await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.getByRole("heading", { name: "No servers configured" })).toBeVisible();
    expect(client.saveConfig).not.toHaveBeenCalled();
  });
});

test("polling preserves modal then dirty draft and its original CAS revision", async () => {
  vi.useFakeTimers();
  const context = fixture();
  render(<App client={context.client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Add server" }));
  fireEvent.change(screen.getByLabelText("Server name", { exact: false }), {
    target: { value: "local" },
  });
  fireEvent.change(screen.getByLabelText("Command", { exact: true }), {
    target: { value: "/synthetic/draft" },
  });
  const next = snapshot();
  next.gateway.revision = "b".repeat(64);
  context.set(next);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByLabelText("Command", { exact: true })).toHaveValue("/synthetic/draft");
  fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await act(async () => {});
  expect(context.client.saveConfig.mock.calls[0][0].expectedRevision).toBe("a".repeat(64));
  expect(screen.getByRole("alert")).toHaveTextContent("StaleRevision");
  expect(screen.getByRole("heading", { name: "local" })).toBeVisible();
});

test.each(["add", "edit", "delete"])(
  "open %s action retains its JSONC document after external invalidation",
  async (action) => {
    vi.useFakeTimers();
    const initial = snapshot();
    const original = {
      ...config,
      mcpServers: { existing: { url: "https://synthetic.example/original" } },
    };
    initial.gateway.configFormat = "jsonc";
    initial.gateway.configPath = "/synthetic/mcp.jsonc";
    initial.gateway.configText = `// retained editor comment\n${JSON.stringify(original)}`;
    const context = fixture(initial);
    render(<App client={context.client} />);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", {
        name:
          action === "add" ? "Add server" : action === "edit" ? "Edit server" : "Delete existing",
      }),
    );
    if (action === "add") {
      fireEvent.change(screen.getByLabelText("Server name", { exact: false }), {
        target: { value: "added" },
      });
      fireEvent.change(screen.getByLabelText("Command", { exact: true }), {
        target: { value: "/synthetic/draft" },
      });
    } else if (action === "edit") {
      fireEvent.change(screen.getByLabelText("Upstream URL", { exact: false }), {
        target: { value: "https://synthetic.example/edited" },
      });
    }
    const invalid = structuredClone(initial);
    invalid.gateway.configText = '{"unknown":true}';
    invalid.gateway.revision = "b".repeat(64);
    invalid.gateway.configError = {
      code: "InvalidConfig",
      message: "Synthetic external invalidation",
      occurrenceId: "invalid-1",
    };
    context.set(invalid);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: action === "delete" ? "Delete server" : "Apply to draft",
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Unsaved changes", { exact: true })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("The retained draft remains editable.");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await act(async () => {});
    const saved = context.client.saveConfig.mock.calls[0][0];
    expect(saved.expectedRevision).toBe(initial.gateway.revision);
    expect(saved.text).toContain("// retained editor comment");
    const draft = JSON.parse(saved.text.slice(saved.text.indexOf("\n") + 1));
    expect(draft.gateway).toEqual(original.gateway);
    expect(draft.mcpServers).toEqual(
      action === "delete"
        ? {}
        : action === "edit"
          ? { existing: { url: "https://synthetic.example/edited" } }
          : {
              ...original.mcpServers,
              added: { command: "/synthetic/draft", args: [], env: {}, disabled: false },
            },
    );
    expect(
      screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("StaleRevision")),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
    expect(screen.getByLabelText("mcp.jsonc", { exact: true })).toHaveValue(saved.text);
    expect(screen.getByRole("button", { name: "Start gateway" })).toBeDisabled();
  },
);

test("invalid config remains editable after refusal and recovers after an authoritative save", async () => {
  const initial = snapshot();
  initial.gateway.configText = '{"unknown":true}';
  initial.gateway.configError = {
    code: "InvalidConfig",
    message: "Unsupported schema",
    occurrenceId: "synthetic-config-issue",
  };
  const { client } = fixture(initial);
  client.saveConfig
    .mockResolvedValueOnce(failure("InvalidConfig"))
    .mockResolvedValueOnce(ok(snapshot()));
  const user = userEvent.setup();
  render(<App client={client} />);
  await screen.findByText("Repair configuration to continue");
  expect(screen.getByRole("button", { name: "Add server" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
  const raw = screen.getByLabelText("mcp.json", { exact: true });
  fireEvent.change(raw, { target: { value: '{"unknown":false}' } });
  await user.click(screen.getByRole("button", { name: "Save mcp.json" }));
  expect(raw).toHaveValue('{"unknown":false}');
  expect(
    screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("InvalidConfig")),
  ).toBe(true);
  fireEvent.change(raw, { target: { value: JSON.stringify(config) } });
  await user.click(screen.getByRole("button", { name: "Save mcp.json" }));
  await waitFor(() =>
    expect(screen.queryByText("Repair configuration to continue")).not.toBeInTheDocument(),
  );
  expect(client.saveConfig.mock.calls[1][0].expectedRevision).toBe(initial.gateway.revision);
});

test("secure token visibility and desired login/autostart remain distinct from actual refusal", async () => {
  const { user, client } = await mount();
  const saved = snapshot();
  const desired = structuredClone(config);
  desired.gateway.launchAtLogin = true;
  desired.gateway.autoStart = true;
  saved.gateway.configText = JSON.stringify(desired);
  saved.login.error = "macOS refused synthetic registration";
  client.saveConfig.mockResolvedValueOnce(ok(saved));
  await user.click(screen.getByRole("button", { name: "Settings" }));
  const token = screen.getByLabelText("Bearer token", { exact: true });
  expect(token).toHaveAttribute("type", "password");
  await user.click(screen.getByRole("button", { name: "Show bearer token" }));
  expect(token).toHaveAttribute("type", "text");
  await user.click(screen.getByRole("button", { name: "Generate secure token" }));
  const generated = (token as HTMLInputElement).value;
  expect(generated).toMatch(/^[a-f0-9]{64}$/);
  expect(generated).not.toBe(config.gateway.token);
  await user.click(screen.getByRole("button", { name: "Hide bearer token" }));
  expect(token).toHaveAttribute("type", "password");
  await user.click(screen.getByRole("switch", { name: /Launch app at login/ }));
  await user.click(screen.getByRole("switch", { name: /Start gateway when the app opens/ }));
  expect(screen.getByText("Actual login registration: Disabled", { exact: true })).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(JSON.parse(client.saveConfig.mock.calls[0][0].text).gateway).toMatchObject({
    token: generated,
    launchAtLogin: true,
    autoStart: true,
  });
  expect(screen.getByText("Actual login registration: Disabled", { exact: true })).toBeVisible();
  expect(screen.getByText("macOS refused synthetic registration")).toBeVisible();
  expect(client.start).not.toHaveBeenCalled();
});

test("clean login retries remain reachable after dismissing an occurrence and stop after recovery", async () => {
  vi.useFakeTimers();
  const initial = snapshot();
  initial.login = {
    enabled: false,
    supported: true,
    error: "macOS refused synthetic unregister",
    occurrenceId: "login-1",
  };
  const context = fixture(initial);
  render(<App client={context.client} />);
  await act(async () => {});
  expect(screen.queryByText("Unsaved changes", { exact: true })).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("macOS refused synthetic unregister");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4100);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  const failedAgain = structuredClone(initial);
  failedAgain.login.occurrenceId = "login-2";
  context.client.saveConfig.mockResolvedValueOnce(ok(failedAgain));
  fireEvent.click(screen.getByRole("button", { name: "Retry login registration" }));
  await act(async () => {});
  expect(context.client.saveConfig.mock.calls[0][0]).toEqual({
    text: initial.gateway.configText,
    expectedRevision: initial.gateway.revision,
  });
  expect(screen.getByRole("alert")).toHaveTextContent("macOS refused synthetic unregister");
  fireEvent.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
  expect(screen.getByRole("button", { name: "Save mcp.json" })).toBeEnabled();
  context.client.saveConfig.mockResolvedValueOnce(ok(snapshot()));
  fireEvent.click(screen.getByRole("button", { name: "Save mcp.json" }));
  await act(async () => {});
  expect(
    screen.queryByRole("button", { name: "Retry login registration" }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save mcp.json" })).toBeDisabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(context.client.start).not.toHaveBeenCalled();
});

test.each(["unsupported", "invalid"])(
  "clean login retry is unavailable for %s configuration",
  async (reason) => {
    const initial = snapshot();
    initial.login.error = "Synthetic unavailable login state";
    if (reason === "unsupported") initial.login.supported = false;
    else
      initial.gateway.configError = {
        code: "InvalidConfig",
        message: "Synthetic invalid configuration",
        occurrenceId: "invalid-retry",
      };
    const context = fixture(initial);
    render(<App client={context.client} />);
    await screen.findByRole("button", { name: "Add server" });
    expect(
      screen.queryByRole("button", { name: "Retry login registration" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
    expect(screen.getByRole("button", { name: "Save mcp.json" })).toBeDisabled();
    expect(context.client.saveConfig).not.toHaveBeenCalled();
  },
);

test("transport and operation failures are visible without dropping settings drafts", async () => {
  const { user, client } = await mount();
  await user.click(screen.getByRole("button", { name: "Start gateway" }));
  expect(screen.getByRole("alert")).toHaveTextContent("ListenerFailure");
  await user.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Port", { exact: true }), { target: { value: "9876" } });
  client.saveConfig.mockRejectedValueOnce(new Error("synthetic disconnect"));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "The native operation failed. Your draft is preserved.",
  );
  expect(screen.getByLabelText("Port", { exact: true })).toHaveValue(9876);
});

test("JSONC form no-op, rename, server/gateway edits retain exact comments and source strings", async () => {
  const initial = snapshot();
  initial.gateway.configFormat = "jsonc";
  initial.gateway.configPath = "/synthetic/mcp.jsonc";
  const source = `// workspace\n{ "gateway": { /* policy */ "host":"127.0.0.1", "port":8765, "token":"\u0024{TOKEN}" }, "mcpServers": { /* server */ "remote": { "url":"https://synthetic.example/mcp", "headers": { /* credential */ "X-Token":"\u0024{UPSTREAM}" } } }, }\n`;
  initial.gateway.configText = source;
  const context = fixture(initial);
  const user = userEvent.setup();
  render(<App client={context.client} />);
  await screen.findByRole("heading", { name: "remote" });
  await user.click(screen.getByRole("button", { name: "Edit server" }));
  await user.click(screen.getByRole("button", { name: "Apply to draft" }));
  expect(screen.queryByText("Unsaved changes", { exact: true })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Edit server" }));
  fireEvent.change(screen.getByLabelText("Server name", { exact: false }), {
    target: { value: "renamed" },
  });
  fireEvent.change(screen.getByLabelText("Upstream URL", { exact: false }), {
    target: { value: "https://synthetic.example/edited" },
  });
  await user.click(screen.getByRole("button", { name: "Apply to draft" }));
  await user.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Port", { exact: true }), { target: { value: "9876" } });
  await user.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
  const expected = source
    .replace('"remote":', '"renamed":')
    .replace('/mcp"', '/edited"')
    .replace("8765", "9876");
  expect(screen.getByLabelText("mcp.jsonc", { exact: true })).toHaveValue(expected);
  await user.click(screen.getByRole("button", { name: "Save mcp.jsonc" }));
  expect(context.client.saveConfig.mock.calls[0][0]).toEqual({
    text: expected,
    expectedRevision: initial.gateway.revision,
  });
});

test("JSONC polling preserves a raw malformed draft and original revision after failed save", async () => {
  vi.useFakeTimers();
  const initial = snapshot();
  initial.gateway.configFormat = "jsonc";
  initial.gateway.configPath = "/synthetic/mcp.jsonc";
  initial.gateway.configText = `// retained\n${initial.gateway.configText}`;
  const context = fixture(initial);
  render(<App client={context.client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
  const raw = screen.getByLabelText("mcp.jsonc", { exact: true });
  const draft = '// broken but retained\n{"gateway":';
  fireEvent.change(raw, { target: { value: draft } });
  const next = structuredClone(initial);
  next.gateway.revision = "c".repeat(64);
  next.gateway.configText = `${initial.gateway.configText}\n`;
  context.set(next);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(raw).toHaveValue(draft);
  context.client.saveConfig.mockResolvedValueOnce(failure("InvalidConfig"));
  fireEvent.click(screen.getByRole("button", { name: "Save mcp.jsonc" }));
  await act(async () => {});
  expect(context.client.saveConfig.mock.calls[0][0]).toEqual({
    text: draft,
    expectedRevision: initial.gateway.revision,
  });
  expect(raw).toHaveValue(draft);
  expect(screen.getByRole("alert")).toHaveTextContent("InvalidConfig");
});

test("dismissed operational/config occurrences stay hidden across polls, new identical issues resurface without changing the Start gate", async () => {
  vi.useFakeTimers();
  const initial = snapshot();
  initial.gateway.configError = {
    code: "InvalidConfig",
    message: "Synthetic invalid file",
    occurrenceId: "config-1",
  };
  initial.gateway.operationalError = {
    code: "BackendFailure",
    message: "Synthetic failure",
    occurrenceId: "operation-1",
  };
  const context = fixture(initial);
  render(<App client={context.client} />);
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Start gateway" })).toBeDisabled();
  fireEvent.click(screen.getAllByRole("button", { name: "Dismiss error" })[0]);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4500);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start gateway" })).toBeDisabled();
  expect(initial.gateway.operationalError?.occurrenceId).toBe("operation-1");
  const next = structuredClone(initial);
  if (!next.gateway.configError || !next.gateway.operationalError)
    throw new Error("Missing issues");
  next.gateway.configError.occurrenceId = "config-2";
  next.gateway.operationalError.occurrenceId = "operation-2";
  context.set(next);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getAllByRole("alert")).toHaveLength(2);
});

test("success and local RPC failures dismiss, and a new identical action failure resurfaces", async () => {
  const { user, client } = await mount();
  client.start.mockResolvedValueOnce(ok(snapshot()));
  await user.click(screen.getByRole("button", { name: "Start gateway" }));
  expect(screen.getByRole("status")).toHaveTextContent("Gateway started.");
  await user.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.queryByText("Gateway started.")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Start gateway" }));
  await user.click(screen.getByRole("button", { name: "Dismiss error" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Start gateway" }));
  expect(screen.getByRole("alert")).toHaveTextContent("ListenerFailure");
});

test("polling transport error dismissal lasts until recovery and a new failure", async () => {
  vi.useFakeTimers();
  const context = fixture();
  context.client.snapshot.mockRejectedValue(new Error("Synthetic disconnect"));
  render(<App client={context.client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4100);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  context.client.snapshot.mockResolvedValueOnce(ok(snapshot()));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Could not read application status.");
});

test("dismissing a failed RPC also acknowledges its later polled controller occurrence, not an unrelated persistent issue", async () => {
  vi.useFakeTimers();
  const initial = snapshot();
  initial.gateway.configError = {
    code: "ConfigIO",
    message: "Synthetic unrelated config issue",
    occurrenceId: "config-old",
  };
  const context = fixture(initial);
  context.client.start.mockResolvedValue({
    ok: false,
    error: { code: "ListenerFailure", message: "Synthetic bind failure", occurrenceId: "bind-1" },
  });
  render(<App client={context.client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  // Use a valid authoritative snapshot before attempting Start; its dismissed issue
  // remains a separate acknowledgement if it subsequently reappears unchanged.
  const ready = snapshot();
  context.set(ready);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  fireEvent.click(screen.getByRole("button", { name: "Start gateway" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  const failed = snapshot();
  failed.gateway.operationalError = {
    code: "ListenerFailure",
    message: "Synthetic bind failure",
    occurrenceId: "bind-1",
  };
  context.set(failed);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(4100);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(failed.gateway.operationalError.occurrenceId).toBe("bind-1");
  failed.gateway.operationalError = { ...failed.gateway.operationalError, occurrenceId: "bind-2" };
  context.set(structuredClone(failed));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Synthetic bind failure");
});

test("a snapshot-free action cannot discard a dismissed RPC failure before its authoritative poll arrives", async () => {
  vi.useFakeTimers();
  const initial = snapshot();
  initial.gateway.configText = JSON.stringify({
    ...config,
    mcpServers: { echo: { command: "/synthetic/executable" } },
  });
  initial.gateway.servers = [
    {
      name: "echo",
      type: "stdio",
      endpoint: "http://127.0.0.1:8765/mcp/echo",
      enabled: true,
      status: "stopped",
      error: null,
    },
  ];
  const context = fixture(initial);
  context.client.start.mockResolvedValue({
    ok: false,
    error: {
      code: "ListenerFailure",
      message: "Synthetic occupied port",
      occurrenceId: "bind-pending",
    },
  });
  context.client.copyEndpoint.mockResolvedValue(ok(null));
  render(<App client={context.client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Start gateway" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy endpoint for echo" }));
  await act(async () => {});
  expect(context.client.copyEndpoint).toHaveBeenCalledOnce();
  const failed = structuredClone(initial);
  failed.gateway.operationalError = {
    code: "ListenerFailure",
    message: "Synthetic occupied port",
    occurrenceId: "bind-pending",
  };
  context.set(failed);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(failed.gateway.operationalError.occurrenceId).toBe("bind-pending");
  failed.gateway.operationalError = {
    ...failed.gateway.operationalError,
    occurrenceId: "bind-new",
  };
  context.set(structuredClone(failed));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Synthetic occupied port");
});

test("Linux controls use explicit platform metadata, disable native login only, and expose Quit", async () => {
  const initial = snapshot();
  initial.platform = "linux";
  // Explicit platform, not login.supported, chooses desktop behavior.
  const context = fixture(initial);
  const user = userEvent.setup();
  render(<App client={context.client} />);
  await screen.findByRole("heading", { name: "No servers configured" });
  expect(screen.getByText("Linux · local")).toBeVisible();
  expect(screen.getByText(/Closing minimizes to the taskbar/)).toBeVisible();
  expect(screen.getByRole("button", { name: "Use macOS Bear preset" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: /^Settings$/ }));
  expect(screen.getByRole("switch", { name: /Launch app at login/ })).toBeDisabled();
  expect(screen.getByRole("switch", { name: /Start gateway when the app opens/ })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Quit MCP Gateway" }));
  expect(context.client.quit).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Quit requested. Waiting for gateway cleanup.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
});

test("Quit preserves a dirty editor draft on cancel and reports refusals without a false cleanup success", async () => {
  const { user, client } = await mount();
  await user.click(screen.getByRole("button", { name: /^Settings$/ }));
  fireEvent.change(screen.getByLabelText("Port", { exact: true }), { target: { value: "8766" } });
  const quit = screen.getByRole("button", { name: "Quit MCP Gateway" });
  await user.click(quit);
  expect(screen.getByRole("dialog", { name: "Quit MCP Gateway?" })).toBeVisible();
  await user.click(screen.getByRole("button", { name: /^Cancel$/ }));
  expect(quit).toHaveFocus();
  expect(screen.getByLabelText("Port", { exact: true })).toHaveValue(8766);
  expect(client.quit).not.toHaveBeenCalled();
  client.quit.mockResolvedValue(failure("OperationFailed"));
  await user.click(quit);
  await user.click(screen.getByRole("button", { name: "Discard changes and quit" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("OperationFailed");
  expect(
    screen.queryByText("Quit requested. Waiting for gateway cleanup."),
  ).not.toBeInTheDocument();
  expect(quit).toBeEnabled();
  expect(screen.getByLabelText("Port", { exact: true })).toHaveValue(8766);
});

test("acknowledged Quit reports delayed cleanup failure and retries without accepting stale failure snapshots", async () => {
  vi.useFakeTimers();
  const context = fixture();
  const pending = (attempt: number) => ({ attempt, phase: "pending" as const, error: null });
  const failed = (attempt: number) => ({
    attempt,
    phase: "failed" as const,
    error: "Quit cleanup failed. The app has not exited. Retry Quit.",
  });
  let status:
    | ReturnType<typeof pending>
    | ReturnType<typeof failed>
    | { attempt: number; phase: "idle"; error: null } = { attempt: 0, phase: "idle", error: null };
  let attempt = 0;
  const client = {
    ...context.client,
    quit: vi.fn(async () => ok({ requested: true as const, status: pending(++attempt) })),
    quitStatus: vi.fn(async () => ok(status)),
  };
  render(<App client={client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Quit MCP Gateway" }));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
  expect(screen.getByText("Quit requested. Waiting for gateway cleanup.")).toBeVisible();
  const unrelated = snapshot();
  unrelated.gateway.operationalError = {
    code: "ListenerFailure",
    message: "Synthetic unrelated gateway failure",
    occurrenceId: "unrelated",
  };
  context.set(unrelated);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Synthetic unrelated gateway failure");
  expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Retry Quit" })).not.toBeInTheDocument();
  context.set(snapshot());
  status = failed(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByRole("alert")).toHaveTextContent(status.error);
  const retry = screen.getByRole("button", { name: "Retry Quit" });
  expect(retry).toBeEnabled();
  expect(
    screen.queryByText("Quit requested. Waiting for gateway cleanup."),
  ).not.toBeInTheDocument();
  let acknowledgeRetry = () => {};
  client.quit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledgeRetry = () => resolve(ok({ requested: true, status: pending(++attempt) }));
      }),
  );
  fireEvent.click(retry);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  acknowledgeRetry();
  await act(async () => {});
  expect(client.quit).toHaveBeenCalledTimes(2);
  // Poll deliberately returns the first failure after the second request was accepted.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  status = failed(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByRole("button", { name: "Retry Quit" })).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent(status.error);
});

test("a recreated renderer can retry authoritative failed Quit without a gateway snapshot", async () => {
  vi.useFakeTimers();
  const context = fixture();
  context.client.snapshot.mockResolvedValue(failure("OperationFailed"));
  context.client.quitStatus.mockResolvedValue(
    ok({
      attempt: 1,
      phase: "failed",
      error: "Quit cleanup failed. The app has not exited. Retry Quit.",
    }),
  );
  context.client.quit.mockResolvedValue(
    ok({ requested: true, status: { attempt: 2, phase: "pending", error: null } }),
  );
  render(<App client={context.client} />);
  await act(async () => {});
  const retry = screen.getByRole("button", { name: "Retry Quit" });
  expect(retry).toBeEnabled();
  expect(screen.getByText("Desktop · local")).toBeVisible();
  fireEvent.click(retry);
  await act(async () => {});
  expect(context.client.quit).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
  // The old failure remains the only status response until the next attempt is observed.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Retry Quit" })).not.toBeInTheDocument();
});

test.each(["refused", "disconnected"])(
  "unavailable Quit status (%s) preserves pending and honest completion-unknown feedback",
  async (mode) => {
    vi.useFakeTimers();
    const context = fixture();
    render(<App client={context.client} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Quit MCP Gateway" }));
    await act(async () => {});
    if (mode === "refused") context.client.quitStatus.mockResolvedValue(failure("OperationFailed"));
    else context.client.quitStatus.mockRejectedValue(new Error("synthetic-unavailable-status"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(
      screen.getByText("Could not read Quit status. Cleanup completion is unknown."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
    expect(screen.getByText("Quit requested. Waiting for gateway cleanup.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry Quit" })).not.toBeInTheDocument();
    expect(screen.queryByText("Quit cleanup failed.", { exact: false })).not.toBeInTheDocument();
  },
);
test("update restart locks configuration edits while preserving drafts", async () => {
  const initial = snapshot();
  initial.update.phase = "restarting";
  initial.update.readyVersion = "0.3.2";
  const context = fixture(initial);
  render(<App client={context.client} />);
  await screen.findByRole("heading", { name: "No servers configured" });
  expect(screen.getByRole("button", { name: "Add server" })).toBeDisabled();
  expect(screen.getByText(/update restart has started/)).toBeVisible();
});

describe("Updates settings", () => {
  test("shows installed version, automation switch and unsupported-platform explanation", async () => {
    const initial = snapshot();
    const context = fixture(initial);
    const first = render(<App client={context.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("heading", { name: "Updates" })).toBeVisible();
    expect(screen.getByText("0.3.1")).toBeVisible();
    expect(
      screen.getByRole("switch", { name: /Automatically check and download updates/ }),
    ).toBeChecked();
    expect(screen.getByRole("button", { name: "Check for Updates" })).toBeEnabled();

    first.unmount();
    const unsupported = snapshot();
    unsupported.update = { ...unsupported.update, supported: false, phase: "unsupported" };
    const unsupportedContext = fixture(unsupported);
    render(<App client={unsupportedContext.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    expect(
      screen.getByText(/Automatic updates are unavailable on this platform or build/),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Check for Updates" })).not.toBeInTheDocument();
  });

  test.each([false, true])(
    "keeps the published switch value and shows uncertain durability without a success notice: %s",
    async (enabled) => {
      const initial = snapshot();
      initial.update.automaticUpdates = !enabled;
      const context = fixture(initial);
      const warning =
        "The update preference was changed, but its durability could not be confirmed. The displayed setting is active now; it may not survive a crash.";
      const published = {
        ...initial,
        update: { ...initial.update, automaticUpdates: enabled, preferenceError: warning },
      };
      context.client.updatesSetAutomatic.mockImplementation(async () => {
        context.set(published);
        return ok(published.update);
      });
      render(<App client={context.client} />);
      await screen.findByRole("heading", { name: "No servers configured" });
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Settings" }));
      const toggle = screen.getByRole("switch", {
        name: /Automatically check and download updates/,
      });
      await user.click(toggle);
      expect(context.client.updatesSetAutomatic).toHaveBeenCalledWith({ automatic: enabled });
      expect(toggle).toHaveAttribute("aria-checked", String(enabled));
      expect(toggle).toBeEnabled();
      expect(screen.getByText(warning, { selector: ".inline-error" })).toBeVisible();
      expect(screen.getByText(`UpdatePreference: ${warning}`)).toBeVisible();
      expect(
        screen.queryByText(/Automatic update checks (enabled|disabled)\./),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Check for Updates" })).toBeEnabled();
    },
  );

  test("shows a nonmodal available banner and downloads through validated RPC", async () => {
    const initial = snapshot();
    initial.update = {
      ...initial.update,
      phase: "available",
      availableVersion: "0.3.2",
      availableHash: "next123456",
    };
    const context = fixture(initial);
    const download = vi.fn(async () => ok(initial.update));
    context.client.updatesDownload = download;
    render(<App client={context.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    expect(screen.getByText(/Version 0.3.2 is available/)).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Download Update" }));
    expect(download).toHaveBeenCalledTimes(1);
  });

  test("announces indeterminate progress and disables duplicate actions while downloading", async () => {
    const initial = snapshot();
    initial.update = {
      ...initial.update,
      phase: "downloading",
      availableVersion: "0.3.2",
      availableHash: "next123456",
    };
    const context = fixture(initial);
    render(<App client={context.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("progressbar", { name: "Update progress" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("button", { name: "Check for Updates" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Downloading…" })).toBeDisabled();
  });

  test("renders a retry action for a sanitized update error", async () => {
    const initial = snapshot();
    initial.update = {
      ...initial.update,
      phase: "error",
      error: "The update operation failed.",
    };
    const context = fixture(initial);
    const check = vi.fn(async () => ok(initial.update));
    context.client.updatesCheck = check;
    render(<App client={context.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The update operation failed.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry Check" }));
    expect(check).toHaveBeenCalledTimes(1);
  });

  test("requires explicit draft-discard confirmation before restarting and preserves cancel", async () => {
    const initial = snapshot();
    initial.update = {
      ...initial.update,
      installationEnabled: true,
      phase: "ready",
      availableVersion: "0.3.2",
      availableHash: "next123456",
      readyVersion: "0.3.2",
    };
    const context = fixture(initial);
    const restart = vi.fn(async () =>
      ok({
        requested: true as const,
        status: { attempt: 1, phase: "pending" as const, error: null },
      }),
    );
    context.client.updatesRestart = restart;
    render(<App client={context.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: /Authoritative configuration/ }));
    fireEvent.change(screen.getByLabelText("mcp.json"), {
      target: { value: `${JSON.stringify(config, null, 2)}\n// draft` },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Restart to Update" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Active MCP connections will be interrupted",
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(restart).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Restart to Update" }));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Discard draft and restart" }));
    expect(restart).toHaveBeenCalledWith({ version: "0.3.2", hash: "next123456" });
  });

  test("locks restart while installation is disabled and exposes ready state after recreation", async () => {
    const initial = snapshot();
    initial.update = {
      ...initial.update,
      installationEnabled: false,
      phase: "ready",
      availableVersion: "0.3.2",
      availableHash: "next123456",
      readyVersion: "0.3.2",
    };
    const context = fixture(initial);
    const first = render(<App client={context.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "Restart to Update" })).toBeDisabled();
    expect(screen.getByText(/Installation is disabled/)).toBeVisible();
    first.unmount();
    render(<App client={context.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("button", { name: "Restart to Update" })).toBeVisible();
  });

  test("window/menu update signal switches to Settings without opening a new surface", async () => {
    const context = fixture();
    render(<App client={context.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    act(() => {
      window.dispatchEvent(new Event("mcp-gateway:show-updates"));
    });
    expect(await screen.findByRole("heading", { name: "Gateway settings" })).toBeVisible();
    const updatesHeading = screen.getByRole("heading", { name: "Updates" });
    expect(updatesHeading).toBeVisible();
    await waitFor(() => expect(document.activeElement).toBe(updatesHeading));
  });
});

test("an unresolved manual update action does not disable Stop, Quit, Logs or drafts", async () => {
  const context = fixture();
  let release: (result: AppResult<import("../../src/shared/rpc").UpdateStatus>) => void = () => {};
  const pending = new Promise<AppResult<import("../../src/shared/rpc").UpdateStatus>>((resolve) => {
    release = resolve;
  });
  context.client.updatesCheck = vi.fn(async () => pending);
  render(<App client={context.client} />);
  await screen.findByRole("heading", { name: "No servers configured" });
  await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
  await userEvent.setup().click(screen.getByRole("button", { name: "Check for Updates" }));
  expect(screen.getByRole("button", { name: "Start gateway" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Quit MCP Gateway" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Logs" })).toBeEnabled();
  await act(async () => {
    release(
      ok({
        ...snapshot().update,
        phase: "available",
        availableVersion: "0.3.2",
        availableHash: "next123456",
      }),
    );
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Download Update" })).toBeEnabled(),
  );
});

test("recovery-required state disables new update actions and exposes the retained copy", async () => {
  const initial = snapshot();
  initial.update = {
    ...initial.update,
    phase: "error",
    error: "An update transaction has no trustworthy completion record.",
    recoveryRequired: true,
    recoveryPath: "/synthetic/recovery/previous.app",
  };
  const context = fixture(initial);
  render(<App client={context.client} />);
  await screen.findByRole("heading", { name: "No servers configured" });
  await userEvent.setup().click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("button", { name: "Retry Check" })).toBeDisabled();
  expect(screen.getByText(/previous update needs recovery/)).toBeVisible();
  expect(screen.getByText(/\/synthetic\/recovery\/previous\.app/)).toBeVisible();
});

test("old update action cannot overwrite fresh restart evidence; authoritative retirement unlocks", async () => {
  const initial = snapshot();
  initial.update = {
    ...initial.update,
    phase: "ready",
    availableVersion: "0.3.2",
    availableHash: "next123456",
    readyVersion: "0.3.2",
  };
  const context = fixture(initial);
  let release!: (value: AppResult<import("../../src/shared/rpc").UpdateStatus>) => void;
  context.client.updatesSetAutomatic = vi.fn(
    async () =>
      new Promise((done) => {
        release = done;
      }),
  );
  context.client.updatesRestart = vi.fn(async () => {
    throw new Error("lost acknowledgement");
  });
  render(<App client={context.client} />);
  await screen.findByRole("heading", { name: "No servers configured" });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Settings" }));
  await user.click(
    screen.getByRole("switch", { name: /Automatically check and download updates/ }),
  );
  await user.click(screen.getByRole("button", { name: "Restart to Update" }));
  await user.click(screen.getByRole("button", { name: "Restart to update" }));
  await screen.findByText(/Could not request the update restart/);
  context.set({ ...initial, update: { ...initial.update, phase: "restarting", attemptId: 1 } });
  context.client.quitStatus = vi.fn(async () => ok({ attempt: 1, phase: "idle", error: null }));
  await screen.findByText(/an update restart has started/, {}, { timeout: 4000 });
  await waitFor(() => expect(context.client.quitStatus).toHaveBeenCalled(), { timeout: 4000 });
  await act(async () => release(ok({ ...initial.update, automaticUpdates: false })));
  expect(screen.getByText("Restarting to apply the verified update.")).toBeVisible();
  expect(
    screen.getByRole("switch", { name: /Automatically check and download updates/ }),
  ).toBeChecked();
  expect(screen.getByLabelText("Port")).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Logs" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Quit MCP Gateway" })).toBeEnabled();
  context.set({ ...initial, update: { ...initial.update, attemptId: null } });
  await waitFor(() => expect(screen.getByLabelText("Port")).not.toHaveAttribute("readonly"), {
    timeout: 4000,
  });
}, 12000);

for (const mode of ["delayed", "failed"] as const) {
  test(`lost restart acknowledgement keeps drafts locked with ${mode} updater polling and fresh idle Quit`, async () => {
    const initial = snapshot();
    initial.update = {
      ...initial.update,
      phase: "ready",
      availableVersion: "0.3.2",
      availableHash: "next123456",
      readyVersion: "0.3.2",
    };
    const context = fixture(initial);
    let reads = 0;
    let release:
      | ((value: AppResult<import("../../src/shared/rpc").AppSnapshot>) => void)
      | undefined;
    context.client.snapshot = vi.fn(async () => {
      if (++reads === 1) return ok(initial);
      if (mode === "failed") return failure("Unavailable");
      return new Promise<AppResult<import("../../src/shared/rpc").AppSnapshot>>((done) => {
        release = done;
      });
    });
    context.client.updatesRestart = vi.fn(async () => {
      throw new Error("Acknowledgement lost");
    });
    render(<App client={context.client} />);
    await screen.findByRole("heading", { name: "No servers configured" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("button", { name: "Restart to Update" }));
    await user.click(screen.getByRole("button", { name: "Restart to update" }));
    await screen.findByText(/Could not request the update restart/);
    await waitFor(() => expect(context.client.quitStatus.mock.calls.length).toBeGreaterThan(1), {
      timeout: 4000,
    });
    expect(screen.getByLabelText("Port")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Logs" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Quit MCP Gateway" })).toBeEnabled();
    if (release) {
      await act(async () =>
        release?.(
          ok({ ...initial, update: { ...initial.update, phase: "restarting", attemptId: 1 } }),
        ),
      );
      expect(screen.getByLabelText("Port")).toHaveAttribute("readonly");
    }
  });
}
