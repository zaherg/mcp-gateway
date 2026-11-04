import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { QuitCoordinator } from "../../src/main/lifecycle";
import { AppService, type UpdateManager } from "../../src/main/service";
import type { FrozenCandidate } from "../../src/main/updater/candidate";
import { withQuitInvocation } from "../../src/main/updater/invocation";
import { App } from "../../src/mainview/App";
import type { GatewayController } from "../../src/shared/types";
import { fixture, snapshot } from "./client";

// AppService only imports the policy error from this native dependency graph.
// Keep the real service and lifecycle; do not acquire Bun FFI inside jsdom.
vi.mock("../../src/main/updater/coordinator", () => ({
  UpdatePolicyError: class extends Error {
    readonly code = "UpdatePolicy";
  },
}));

test("real service/lifecycle attempts survive two failed Quits and feed the renderer's update ordering", async () => {
  vi.useFakeTimers();
  const initial = snapshot();
  initial.update = {
    ...initial.update,
    phase: "ready",
    availableVersion: "0.3.2",
    readyVersion: "0.3.2",
    availableHash: "next123456",
  };
  const context = fixture(initial);
  const candidate: FrozenCandidate = {
    schema_version: 1,
    identifier: "dev.srvr.mcpgateway",
    channel: "stable",
    version: "0.3.2",
    hash: "next123456",
    artifact_file: "stable-macos-arm64-MCPGateway.app.tar.zst",
    prepared_path: "/synthetic/prepared.json",
    prepared_sha256: "a".repeat(64),
    retained_tar_path: "/synthetic/next.tar",
    archive_sha256: "b".repeat(64),
    archive_bytes: 1,
    frozen_at: "2026-11-04T00:00:00.000Z",
  };
  let cleanups = 0;
  const lifecycle = new QuitCoordinator(
    async () => {
      cleanups++;
      throw new Error("synthetic cleanup refusal");
    },
    () => {},
    () => {},
  );
  const unused = async (): Promise<never> => {
    throw new Error("Unexpected gateway mutation");
  };
  const controller: GatewayController = {
    snapshot: () => initial.gateway,
    recordLocalError: () => {},
    operation: () => ({ signal: new AbortController().signal }),
    readLogs: () => ({ entries: [], cursor: 0, generation: 0, gap: false, hasMore: false }),
    clearLogs: () => ({ entries: [], cursor: 0, generation: 1, gap: false, hasMore: false }),
    start: unused,
    stop: unused,
    restartServer: unused,
    saveConfig: unused,
    close: unused,
  };
  const updates: UpdateManager = {
    statusValue: () => initial.update,
    check: async () => initial.update,
    download: async () => initial.update,
    setAutomatic: async () => initial.update,
    beginRestart: () => {
      const attempt = lifecycle.reserveUpdate(candidate);
      if (!attempt) throw new Error("Reservation refused");
      return attempt;
    },
    restartToUpdate: async (_version, _hash, attempt) => {
      if (!attempt || !lifecycle.acceptUpdateRestart(attempt)) throw new Error("Restart refused");
      withQuitInvocation({ kind: "begin-update-shutdown", attemptId: attempt.id }, () =>
        lifecycle.handle(() => {}),
      );
      return lifecycle.status();
    },
  };
  const service = new AppService(
    controller,
    { status: () => initial.login, setEnabled: () => initial.login },
    () => {},
    {
      platform: "macos",
      requestQuit: () => {
        lifecycle.armQuit();
        lifecycle.handle(() => {});
        return lifecycle.status();
      },
      quitStatus: () => lifecycle.status(),
    },
    updates,
  );
  context.client.quit.mockImplementation(() => service.handlers.quit());
  context.client.quitStatus.mockImplementation(() => service.handlers.quitStatus());
  context.client.updatesRestart.mockImplementation(() =>
    service.handlers.updatesRestart({ version: candidate.version, hash: candidate.hash }),
  );
  render(<App client={context.client} />);
  await act(async () => {});
  for (const attempt of [1, 2]) {
    fireEvent.click(
      screen.getByRole("button", { name: attempt === 1 ? "Quit MCP Gateway" : "Retry Quit" }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(lifecycle.status()).toMatchObject({ attempt, phase: "failed" });
  }
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Restart to Update" }));
  fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(lifecycle.status()).toMatchObject({ attempt: 3, phase: "failed" });
  expect(
    screen.getByText("Update cleanup failed. The app has not exited. Retry Update or Quit."),
  ).toBeVisible();
  expect(context.client.updatesRestart).toHaveBeenCalledTimes(1);
  expect(cleanups).toBe(3);
  expect(context.client.saveConfig).not.toHaveBeenCalled();
});
