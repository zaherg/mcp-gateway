import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { App } from "../../src/mainview/App";
import { Logs } from "../../src/mainview/Logs";
import { LOG_LIMITS, type LogEntry, type LogPage } from "../../src/shared/logs";
import type { AppResult } from "../../src/shared/rpc";
import { failure, fixture, ok } from "./client";

const entry = (id: number, text = `synthetic-${id}`): LogEntry => ({
  id,
  text,
  time: "2026-11-02T12:00:00.000Z",
  level: "error",
  source: "stderr",
  server: "echo",
  truncated: false,
});
const page = (entries: LogEntry[], extra: Partial<LogPage> = {}): LogPage => ({
  entries,
  cursor: entries.at(-1)?.id ?? 0,
  generation: 0,
  gap: false,
  hasMore: false,
  ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("Logs fetch only while active, render full text without markup, filter, and stop polling on unmount", async () => {
  vi.useFakeTimers();
  const { client } = fixture();
  client.readLogs.mockResolvedValue(
    ok(
      page([
        entry(1, "<script>fake-token=fixture-only</script>"),
        { ...entry(2), level: "debug", server: "remote" },
      ]),
    ),
  );
  render(<App client={client} />);
  await act(async () => {});
  expect(client.readLogs).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /^Logs$/ }));
  await act(async () => {});
  expect(screen.getByText("<script>fake-token=fixture-only</script>")).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
  fireEvent.change(screen.getByLabelText("Level", { exact: true }), { target: { value: "debug" } });
  expect(screen.getByText("synthetic-2")).toBeVisible();
  expect(screen.queryByText("<script>fake-token=fixture-only</script>")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search text"), { target: { value: "absent" } });
  expect(screen.getByText("No entries match these filters.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /^Overview$/ }));
  const count = client.readLogs.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(client.readLogs).toHaveBeenCalledTimes(count);
});

test("incremental reads follow cursor, replace after external clear, cap renderer retention, and show gaps", async () => {
  vi.useFakeTimers();
  const { client } = fixture();
  let batch = 0;
  client.readLogs.mockImplementation(async () => {
    const start = batch++ * LOG_LIMITS.batchEntries;
    return ok(
      page(
        Array.from({ length: LOG_LIMITS.batchEntries }, (_, index) =>
          entry(start + index + 1, `${start + index + 1}:${"x".repeat(30_000)}`),
        ),
        { hasMore: batch < 6 },
      ),
    );
  });
  render(<Logs client={client} servers={["echo"]} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  const retained = screen.getByLabelText("Diagnostic entries").querySelectorAll("article");
  expect(retained.length).toBeLessThan(LOG_LIMITS.entries);
  expect(retained.length).toBeGreaterThan(100);
  expect(
    Array.from(retained).reduce((size, node) => size + (node.textContent?.length ?? 0), 0),
  ).toBeLessThan(LOG_LIMITS.bytes);
  expect(client.readLogs.mock.calls[1][0]).toEqual({ after: 50 });
  expect(screen.getByRole("status")).toHaveTextContent("Some earlier entries");
  client.readLogs.mockResolvedValueOnce(
    ok(page([entry(301, "after-clear")], { generation: 1, gap: true })),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2100);
  });
  expect(screen.getByLabelText("Diagnostic entries").querySelectorAll("article")).toHaveLength(1);
  expect(screen.getByText("after-clear")).toBeVisible();
});

test("clear ignores an older pending page, while failed clear and read remain dismissible", async () => {
  vi.useFakeTimers();
  const { client } = fixture();
  const stale = deferred<AppResult<LogPage>>();
  client.readLogs
    .mockImplementationOnce(() => stale.promise)
    .mockResolvedValue(ok(page([entry(2, "new-generation")], { generation: 1 })));
  render(<Logs client={client} servers={[]} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Clear logs" }));
  await act(async () => {});
  stale.resolve(ok(page([entry(1, "stale-private-value")])));
  await act(async () => {});
  expect(screen.queryByText("stale-private-value")).not.toBeInTheDocument();
  expect(screen.getByText("new-generation")).toBeVisible();
  client.clearLogs.mockResolvedValueOnce(failure("OperationFailed"));
  fireEvent.click(screen.getByRole("button", { name: "Clear logs" }));
  await act(async () => {});
  expect(screen.getByRole("alert")).toHaveTextContent("OperationFailed");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("hung log request times out once without spawning overlapping polls or stuck clear controls", async () => {
  vi.useFakeTimers();
  const { client } = fixture();
  client.readLogs.mockImplementation(() => new Promise(() => {}));
  render(<Logs client={client} servers={[]} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LOG_LIMITS.requestTimeoutMs + 1);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Could not read local logs");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100_000);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(client.readLogs).toHaveBeenCalledTimes(1);
  client.clearLogs.mockImplementation(() => new Promise(() => {}));
  fireEvent.click(screen.getByRole("button", { name: "Clear logs" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(LOG_LIMITS.requestTimeoutMs + 1);
  });
  expect(screen.getByRole("button", { name: "Clear logs" })).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Could not clear local logs");
});
