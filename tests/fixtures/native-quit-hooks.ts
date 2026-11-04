function replaceOnce(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error("Native Quit fixture hook changed.");
  return source.replace(before, after);
}

/** Private development fixture only. The SDK, gate, lifecycle and renderer stay real. */
export function nativeQuitSource(source: string, ignoreSignal = false): string {
  let result = replaceOnce(
    source,
    'import { writeFile } from "node:fs/promises";',
    'import { writeFile } from "node:fs/promises";\nimport { appendFileSync } from "node:fs";',
  );
  result = replaceOnce(
    result,
    "let quitRequested = false;",
    `let quitRequested = false;
let acceptanceRendererRequests = 0;
function acceptanceRecord(phase: string) {
  appendFileSync(join(dataDirectory, "quit-events.jsonl"), JSON.stringify({
    phase, pid: process.pid, signal: nativeQuitSignal(),
    rendererRequests: acceptanceRendererRequests, lifecycle: quitStatus(),
  }) + "\\n", { mode: 0o600 });
}`,
  );
  result = replaceOnce(
    result,
    "    if (!window) return undefined;\n    restoreWindow(window);",
    '    if (!window) return undefined;\n    acceptanceRendererRequests++;\n    acceptanceRecord("renderer-request");\n    restoreWindow(window);',
  );
  result = replaceOnce(
    result,
    "    await controller.close();",
    '    acceptanceRecord("cleanup-start");\n    await controller.close();\n    acceptanceRecord("cleanup-complete");',
  );
  if (ignoreSignal) result = replaceOnce(result, "  nativeQuitSignal,", "  () => false,");
  return `${result}
// Test-only DOM actions use the real WKWebView, React draft state and RPC.
void (async () => {
  await waitForNativeWindow(() => windowReady);
  const view = window?.webview;
  if (!view || !inspectViewport) throw new Error("Missing native window");
  async function mark(script: string, color: string) {
    view!.executeJavascript(script);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await inspectViewport!()).bodyBackground === color) return;
      await Bun.sleep(50);
    }
    throw new Error("Native DOM assertion did not complete");
  }
  await mark(
    \`(() => {
      let ticks = 0;
      const timer = setInterval(() => {
        if ([...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Add server')) {
          document.body.style.backgroundColor = 'rgb(7, 8, 9)';
          clearInterval(timer);
        } else if (++ticks > 150) clearInterval(timer);
      }, 25);
    })()\`,
    "rgb(7, 8, 9)",
  );
  await mark(
    \`(() => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add server');
      if (!button) throw new Error('Missing Add server');
      button.click();
      setTimeout(() => {
        const input = document.querySelector('dialog input');
        if (!input) throw new Error('Missing draft input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'unsaved-native-draft');
        input.dispatchEvent(new Event('input', {bubbles: true}));
        setTimeout(() => {
          if (input.value === 'unsaved-native-draft') document.body.style.backgroundColor = 'rgb(1, 2, 3)';
        }, 50);
      }, 50);
    })()\`,
    "rgb(1, 2, 3)",
  );
  acceptanceRecord("draft-ready");
  login.requestQuitShortcut();
  await waitForNativeWindow(() => acceptanceRendererRequests === 1);
  {
    await mark(
      \`(() => {
        const prompt = [...document.querySelectorAll('dialog')].find(d => d.textContent.includes('Discard changes and quit'));
        const draft = document.querySelector('dialog input');
        if (prompt && draft?.value === 'unsaved-native-draft') document.body.style.backgroundColor = 'rgb(4, 5, 6)';
      })()\`,
      "rgb(4, 5, 6)",
    );
    acceptanceRecord("draft-confirmation");
  }
  if (process.env.MCP_GATEWAY_NATIVE_QUIT_MODE === "unresponsive") {
    view.executeJavascript("setTimeout(() => { const end = Date.now() + 60000; while (Date.now() < end) {} }, 0)");
    await Bun.sleep(100);
    const reply = inspectViewport().then(() => "responsive", () => "failed");
    if (await Promise.race([reply, Bun.sleep(300).then(() => "blocked")]) !== "blocked")
      throw new Error("Renderer did not block");
    acceptanceRecord("renderer-blocked");
  }
  if (quitStatus().phase !== "idle") throw new Error("Interactive Quit discarded the draft");
  acceptanceRecord("signal-ready");
})().catch((error) => { acceptanceRecord("fixture-failed"); console.error(error); });
`;
}
