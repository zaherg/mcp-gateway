import { createRoot } from "react-dom/client";
import { App } from "../../src/mainview/App";
import "../../src/mainview/styles.css";
import type { AppClient, AppResult } from "../../src/shared/rpc";

const token = location.hash.slice(1);
async function request<T>(method: string, params?: unknown): Promise<AppResult<T>> {
  const response = await fetch(`/rpc/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ params }),
  });
  if (!response.ok) throw new Error(`Bridge rejected request: ${response.status}`);
  return response.json();
}
const client: AppClient = {
  readLogs: (params) => request("readLogs", params),
  clearLogs: () => request("clearLogs"),
  snapshot: () => request("snapshot"),
  quit: () => request("quit"),
  quitStatus: () => request("quitStatus"),
  start: () => request("start"),
  stop: () => request("stop"),
  restartServer: (params) => request("restartServer", params),
  saveConfig: (params) => request("saveConfig", params),
  copyEndpoint: (params) => request("copyEndpoint", params),
  copyClientConfig: (params) => request("copyClientConfig", params),
};
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<App client={client} />);
