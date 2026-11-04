import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "../../src/mainview/App";
import type { QuitStatus } from "../../src/shared/rpc";
import { config, failure, fixture, ok, snapshot } from "./client";

const pending: QuitStatus = { attempt: 1, phase: "pending", error: null };
const failed: QuitStatus = {
  attempt: 1,
  phase: "failed",
  error: "Quit cleanup failed. The app has not exited. Retry Quit.",
};
async function poll() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
}

function nativeQuit(): boolean {
  return !window.dispatchEvent(new Event("mcp-gateway:request-quit", { cancelable: true }));
}

test.each(["typed", "raw", "add", "edit", "delete"])(
  "native Quit preserves the %s draft on cancellation and uses the shared discard action",
  async (kind) => {
    const initial = snapshot();
    initial.gateway.configText = JSON.stringify({
      ...config,
      mcpServers: { existing: { url: "https://synthetic.example/original" } },
    });
    const context = fixture(initial);
    render(<App client={context.client} />);
    await act(async () => {});
    let draft: HTMLElement;
    if (kind === "typed" || kind === "raw") {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      if (kind === "raw") {
        fireEvent.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
        draft = screen.getByLabelText("mcp.json", { exact: true });
        fireEvent.change(draft, { target: { value: "retained incomplete JSON" } });
      } else {
        draft = screen.getByLabelText("Port", { exact: true });
        fireEvent.change(draft, { target: { value: "8766" } });
      }
    } else {
      fireEvent.click(
        screen.getByRole("button", {
          name: kind === "add" ? "Add server" : kind === "edit" ? "Edit server" : "Delete existing",
        }),
      );
      draft =
        kind === "delete"
          ? screen.getByRole("button", { name: "Delete server" })
          : screen.getByLabelText("Server name", { exact: false });
      if (kind !== "delete") fireEvent.change(draft, { target: { value: "retained" } });
    }
    draft.focus();
    act(() => {
      expect(nativeQuit()).toBe(true);
    });
    act(() => {
      expect(nativeQuit()).toBe(true);
    });
    expect(screen.getAllByRole("dialog", { name: "Quit MCP Gateway?" })).toHaveLength(1);
    expect(context.client.quit).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("dialog", { name: "Quit MCP Gateway?" });
    fireEvent(confirmation, new Event("cancel", { cancelable: true }));
    expect(screen.queryByRole("dialog", { name: "Quit MCP Gateway?" })).not.toBeInTheDocument();
    expect(draft).toHaveFocus();
    if (kind === "typed") expect(draft).toHaveValue(8766);
    else if (kind === "raw") expect(draft).toHaveValue("retained incomplete JSON");
    else if (kind !== "delete") expect(draft).toHaveValue("retained");
    else expect(draft).toBeEnabled();
    expect(context.client.saveConfig).not.toHaveBeenCalled();
    act(() => {
      nativeQuit();
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard changes and quit" }));
    act(() => {
      nativeQuit();
      nativeQuit();
    });
    await act(async () => {});
    expect(context.client.quit).toHaveBeenCalledTimes(1);
    expect(context.client.saveConfig).not.toHaveBeenCalled();
  },
);

test("native Quit retries failed cleanup without repeating the draft decision", async () => {
  const context = fixture();
  context.client.quit.mockResolvedValueOnce(ok({ requested: true, status: failed }));
  render(<App client={context.client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Port", { exact: true }), { target: { value: "8766" } });
  act(() => {
    nativeQuit();
  });
  fireEvent.click(screen.getByRole("button", { name: "Discard changes and quit" }));
  await act(async () => {});
  act(() => {
    nativeQuit();
  });
  await act(async () => {});
  expect(context.client.quit).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog", { name: "Quit MCP Gateway?" })).not.toBeInTheDocument();
  expect(screen.getByLabelText("Port", { exact: true })).toHaveValue(8766);
});

test("native Quit refuses an unavailable renderer and coalesces clean requests", async () => {
  expect(nativeQuit()).toBe(false);
  const context = fixture();
  render(<App client={context.client} />);
  await act(async () => {});
  act(() => {
    expect(nativeQuit()).toBe(true);
    nativeQuit();
  });
  await act(async () => {});
  expect(context.client.quit).toHaveBeenCalledTimes(1);
});

test("a recreated renderer waits for authoritative Quit status before allowing edits", async () => {
  const context = fixture();
  let receiveStatus = () => {};
  context.client.quitStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        receiveStatus = () => resolve(ok({ attempt: 0, phase: "idle", error: null }));
      }),
  );
  render(<App client={context.client} />);
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Add server" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByLabelText("Port", { exact: true })).toHaveAttribute("readonly");
  await act(async () => {
    receiveStatus();
  });
  expect(screen.getByLabelText("Port", { exact: true })).not.toHaveAttribute("readonly");
});

test("settings and raw drafts stay selectable but cannot change during requesting, pending or failed Quit", async () => {
  vi.useFakeTimers();
  const context = fixture();
  let acknowledge = () => {};
  context.client.quit.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        acknowledge = () => resolve(ok({ requested: true, status: pending }));
      }),
  );
  render(<App client={context.client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Port", { exact: true }), { target: { value: "8766" } });
  fireEvent.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
  const raw = screen.getByLabelText("mcp.json", { exact: true });
  if (!(raw instanceof HTMLTextAreaElement)) throw new Error("Expected draft textarea");
  const draft = raw.value;
  fireEvent.click(screen.getByRole("button", { name: "Quit MCP Gateway" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes and quit" }));
  for (const phase of ["requesting", "pending", "failed"]) {
    if (phase === "pending") {
      acknowledge();
      await act(async () => {});
    } else if (phase === "failed") {
      context.client.quitStatus.mockResolvedValue(ok(failed));
      await poll();
    }
    for (const label of ["Interface / address", "Port", "Bearer token", "mcp.json"]) {
      const field = screen.getByLabelText(label, { exact: true });
      expect(field).toHaveAttribute("readonly");
      expect(field).not.toBeDisabled();
      fireEvent.change(field, { target: { value: label === "Port" ? "9999" : "changed" } });
    }
    expect(screen.getByLabelText("Port", { exact: true })).toHaveValue(8766);
    expect(raw).toHaveValue(draft);
    raw.focus();
    raw.select();
    expect(raw.selectionEnd - raw.selectionStart).toBe(draft.length);
    for (const label of [
      "Generate secure token",
      "Save changes",
      "Discard",
      "Save mcp.json",
      "Start gateway",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeDisabled();
    }
    for (const toggle of screen.getAllByRole("switch")) expect(toggle).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Logs" }));
    await act(async () => {});
    expect(context.client.readLogs).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Clear logs" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  }
  expect(context.client.saveConfig).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Retry Quit" })).toBeEnabled();
  context.client.quit.mockResolvedValueOnce(
    ok({ requested: true, status: { attempt: 2, phase: "pending", error: null } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry Quit" }));
  await act(async () => {});
  expect(context.client.quit).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  context.client.quitStatus.mockResolvedValue(ok({ attempt: 2, phase: "ready", error: null }));
  await poll();
  expect(screen.getByLabelText("Port", { exact: true })).toHaveAttribute("readonly");
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
});

test.each(["refused", "disconnected"])(
  "an unacknowledged Quit (%s) cannot reuse cached idle authority to unlock editing",
  async (mode) => {
    vi.useFakeTimers();
    const context = fixture();
    render(<App client={context.client} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
    let staleIdle = () => {};
    context.client.quitStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          staleIdle = () => resolve(ok({ attempt: 0, phase: "idle", error: null }));
        }),
    );
    await poll();
    if (mode === "refused") context.client.quit.mockResolvedValueOnce(failure("OperationFailed"));
    else context.client.quit.mockRejectedValueOnce(new Error("Synthetic lost acknowledgement"));
    fireEvent.click(screen.getByRole("button", { name: "Quit MCP Gateway" }));
    await act(async () => {});
    const port = screen.getByLabelText("Port", { exact: true });
    expect(port).toHaveAttribute("readonly");
    await act(async () => {
      staleIdle();
    });
    expect(port).toHaveAttribute("readonly");
    context.client.quitStatus.mockResolvedValue(failure("OperationFailed"));
    await poll();
    expect(port).toHaveAttribute("readonly");
    expect(screen.getByLabelText("mcp.json", { exact: true })).toHaveAttribute("readonly");
    fireEvent.change(port, { target: { value: "9999" } });
    expect(port).toHaveValue(config.gateway.port);
    context.client.quitStatus.mockResolvedValue(ok(pending));
    await poll();
    expect(port).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "Quitting…" })).toBeDisabled();
    expect(context.client.saveConfig).not.toHaveBeenCalled();
  },
);

test.each(["add", "edit", "delete"])(
  "native Quit locks an already-open %s dialog without losing retained fields",
  async (action) => {
    vi.useFakeTimers();
    const initial = snapshot();
    initial.gateway.configText = JSON.stringify({
      ...config,
      mcpServers: { existing: { url: "https://synthetic.example/original" } },
    });
    const context = fixture(initial);
    render(<App client={context.client} />);
    await act(async () => {});
    const opener = screen.getByRole("button", {
      name: action === "add" ? "Add server" : action === "edit" ? "Edit server" : "Delete existing",
    });
    opener.focus();
    fireEvent.click(opener);
    if (action !== "delete") {
      fireEvent.change(screen.getByLabelText("Server name", { exact: false }), {
        target: { value: "retained" },
      });
      if (action === "add")
        fireEvent.change(screen.getByLabelText("Command", { exact: true }), {
          target: { value: "/synthetic/retained" },
        });
    }
    for (const status of [pending, failed]) {
      context.client.quitStatus.mockResolvedValue(ok(status));
      await poll();
      const apply = screen.getByRole("button", {
        name: action === "delete" ? "Delete server" : "Apply to draft",
      });
      expect(apply).toBeDisabled();
      fireEvent.click(apply);
      expect(screen.getByRole("dialog")).toBeVisible();
      if (action !== "delete") {
        const name = screen.getByLabelText("Server name", { exact: false });
        expect(name).toHaveAttribute("readonly");
        expect(name).not.toBeDisabled();
        fireEvent.change(name, { target: { value: "unsavable" } });
        expect(name).toHaveValue("retained");
        expect(screen.getByLabelText("Transport", { exact: true })).toBeDisabled();
        expect(screen.getByLabelText("Disabled (do not mount this endpoint)")).toBeDisabled();
        if (action === "add") {
          expect(screen.getByLabelText("Command", { exact: true })).toHaveValue(
            "/synthetic/retained",
          );
          expect(screen.getByRole("button", { name: /Fill macOS Bear preset/ })).toBeDisabled();
        }
      }
    }
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("button", { name: /Authoritative configuration/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: /Authoritative configuration/ }));
    expect(screen.getByLabelText("mcp.json", { exact: true })).toHaveValue(
      initial.gateway.configText,
    );
    expect(screen.getByRole("button", { name: "Add server" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit server" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete existing" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retry Quit" })).toBeEnabled();
    expect(context.client.saveConfig).not.toHaveBeenCalled();
  },
);

test("a refused idle Quit unlocks editing, while snapshot-free failed Quit keeps Logs and Retry reachable", async () => {
  vi.useFakeTimers();
  const context = fixture();
  context.client.quit.mockResolvedValue(failure("OperationFailed"));
  const view = render(<App client={context.client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Quit MCP Gateway" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(screen.getByLabelText("Port", { exact: true })).toHaveAttribute("readonly");
  await poll();
  expect(screen.getByLabelText("Port", { exact: true })).not.toHaveAttribute("readonly");
  fireEvent.change(screen.getByLabelText("Port", { exact: true }), { target: { value: "8766" } });
  expect(screen.getByLabelText("Port", { exact: true })).toHaveValue(8766);
  view.unmount();
  context.client.snapshot.mockResolvedValue(failure("OperationFailed"));
  context.client.quitStatus.mockResolvedValue(ok(failed));
  render(<App client={context.client} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Logs" }));
  await act(async () => {});
  expect(context.client.readLogs).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Clear logs" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Retry Quit" })).toBeEnabled();
});
