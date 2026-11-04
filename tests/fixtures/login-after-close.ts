import { openLoginManager } from "../../src/main/login";

const dylibPath = process.argv[2];
const counterPath = process.argv[3];
const mode = process.argv[4];
if (
  !dylibPath ||
  !counterPath ||
  (mode !== "control" && mode !== "after-close" && mode !== "repeated-close")
) {
  console.error("usage: login-after-close <dylib> <counter> <control|after-close|repeated-close>");
  process.exit(2);
}

const login = openLoginManager("macos", dylibPath, true);

if (mode === "control") {
  const status = login.manager.status();
  const setResult = login.manager.setEnabled(false);
  const code = login.statusCode();
  login.requestCloseShortcut();
  login.requestQuitShortcut();
  console.log("status-enabled", status.enabled);
  console.log("set-enabled", setResult.enabled);
  console.log("code", code);
  console.log("completed");
  process.exit(0);
}

const retained = login.manager.status();
login.close();
if (mode === "repeated-close") {
  login.close();
  login.close();
}

console.log("retained-enabled", retained.enabled);
try {
  login.statusCode();
  console.log("statusCode", "called");
} catch (error) {
  console.log("statusCode-error", error instanceof Error ? error.message : String(error));
}
try {
  login.requestCloseShortcut();
  console.log("closeShortcut", "called");
} catch (error) {
  console.log("closeShortcut-error", error instanceof Error ? error.message : String(error));
}
try {
  login.requestQuitShortcut();
  console.log("quitShortcut", "called");
} catch (error) {
  console.log("quitShortcut-error", error instanceof Error ? error.message : String(error));
}
try {
  login.manager.setEnabled(false);
  console.log("setEnabled", "called");
} catch (error) {
  console.log("setEnabled-error", error instanceof Error ? error.message : String(error));
}
console.log("retained-after", login.manager.status().enabled);
console.log("completed");
