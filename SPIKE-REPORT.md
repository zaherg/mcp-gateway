# Effect UI Logs Throwaway Spike Report

Branch `spike/effect-ui-logs` branched from `develop` at `93b63d40afa46ce0783f57f67ff3f715cbe95c06` (`v0.9.0`). This spike reimplemented only the Logs tab (`src/mainview/Logs.tsx`) in `@effect/ui` (`82a1750`), mounted it inside the existing React `<App />` shell with zero edits to `src/mainview/App.tsx`, wired dev-only `@effect/ui-devtools`, and collected measured data for a go/no-go decision.

Do not merge this branch into `develop`. Delete or archive it after review.

## Verdict

**No-go for migrating `mcp-gateway` right now. Revisit after `@effect/ui` ships on npm with stable APIs.**

The concurrency model and test tooling (`Story.explore`, `TestClock`, `HtmlPlay`, and the DevTools MCP server) are strong. For `mcp-gateway` today, those gains do not outweigh four concrete costs observed in this spike.

1. Running Effect UI alongside React added `+220,256` bytes raw (`+75,123` bytes gzip, `+30.5%`) to the renderer bundle for one tab.
2. Packages are unreleased `pkg.pr.new` snapshots with experimental APIs and an optional `@effect/platform-node` peer dependency that `bun add` skipped.
3. View and schema code grew from `336` lines in `src/mainview/Logs.tsx` to `903` production lines across four files, largely due to `h.*` builder verbosity and re-expressing macOS controls and SVG icons without `@base-ui/react` or `lucide-react`.
4. Testing required maintaining two test runners (`bun test` and `vitest`).

## Measured metrics

All bundle sizes come from `bun run ui:build` (`vite build` v8.3.8). All test timings come from local runs on macOS.

| Metric | Trunk (`93b63d4`) | PR-1 (deps only) | PR-3 (mounted Logs) | PR-4 (+ DevTools) | Plan 064 threshold | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Renderer JS raw | `799,240` B | `799,240` B (`+0` B) | `1,019,496` B (`+220,256` B) | `1,019,505` B (`+9` B vs PR-3) | PR-1 `<= +1,024` B; PR-3 `<= +350,000` B; PR-4 `+-1,024` B vs PR-3 | Pass |
| Renderer JS gzip | `245,988` B | `245,988` B (`+0` B) | `321,111` B (`+75,123` B) | `321,113` B (`+2` B vs PR-3) | PR-3 `<= +100,000` B; PR-4 `+-1,024` B vs PR-3 | Pass |
| Renderer CSS raw | `55,127` B | `55,127` B (`+0` B) | `55,445` B (`+318` B) | `55,445` B (`+0` B vs PR-3) | Report exact delta | Pass |
| Renderer CSS gzip | `10,002` B | `10,002` B (`+0` B) | `10,081` B (`+79` B) | `10,081` B (`+0` B vs PR-3) | PR-3 `<= +5,000` B | Pass |
| `@effect/ui-devtools` in `dist/` | `0` matches | `0` matches | `0` matches | `0` matches | Zero leakage in production `dist/` | Pass |
| Existing `Logs` DOM test (`bun test`) | `26.50` ms | `26.50` ms | `101.94` ms full / `122-131` ms solo | `98.04` ms full | `<= 150` ms | Pass |
| Effect UI test suite (`bun run test:effect`) | N/A | `4` tests | `14` tests (`853` ms) | `14` tests (`656` ms) | `<= 5,000` ms | Pass |
| Full existing suite (`bun run test`) | `363` pass, `0` fail | `363` pass, `0` fail | `363` pass, `0` fail | `363` pass, `0` fail | `0` regressions | Pass |
| Typecheck (`tsc --noEmit`, TS 7.0.2) | Exit `0` | Exit `0` | Exit `0` | Exit `0` | Exit `0` | Pass |
| Lint (`biome check`) | Exit `0` | Exit `0` | Exit `0` | Exit `0` | Exit `0` | Pass |

### Code size and lint suppressions

| Scope | Trunk (`develop`) | Spike (`spike/effect-ui-logs`) |
| --- | --- | --- |
| Production files | `1` file (`src/mainview/Logs.tsx`, `336` lines) | `4` files (`Logs.tsx` `108` + `buffer.ts` `97` + `services.ts` `116` + `LogsView.ts` `582` = `903` lines) |
| React hooks / refs in `Logs.tsx` | `12` `useState`, `6` `useRef`, `4` `useEffect` | `0` `useState`, `3` `useRef`, `2` `useEffect` |
| `biome-ignore` comments in Logs | `2` (`useExhaustiveDependencies`) + `1` (`noNoninteractiveTabindex`) | `0` |
| Effect UI tests | `0` lines | `5` files (`736` lines total, `14` tests) |

## What worked well

1. **Exhaustive concurrency verification.** Replacing `clearing`, `epoch`, and `requestGeneration` refs with `pollPhase: 'polling' | 'clearing'`, `Command.interrupt`, and `mode: 'switch'` made the state machine explicit. `Story.explore` checked overlapping `PollSucceeded`, `PollFailed`, and `ClickedClear` settlements to depth 5 (`tests/effect-logs/LogsView.story.test.ts`) and confirmed that no stale pre-clear log page can repopulate the buffer after a clear succeeds.
2. **Deterministic time control without monkey-patching timers.** `HtmlPlay` with `TestClock.adjust('2 seconds')` and `TestClock.adjust('1500 millis')` tested retry cadence, `hasMore` immediate draining, and copy badge expiry in `202` ms without patching `globalThis.setTimeout`.
3. **Clean embedded mount inside React.** `BrowserHost.mountEffect` with `{ head: false }`, `root.setProps(...)`, and `Scope.close` mounted `LogsView` inside `<div ref={containerRef} />` without touching `src/mainview/App.tsx`, `src/core/`, `src/main/`, `src/shared/`, or `src/mainview/index.html`.
4. **Built-in command status in views.** `h.isRunning(ClearLogs)` drove the Clear button disabled state directly in `LogsView.ts` and was verified in `tests/effect-logs/LogsView.scene.test.ts`.
5. **Production tree-shaking of DevTools.** Guarding `DevTools.layer` with `import.meta.env.DEV` stripped `@effect/ui-devtools` completely from `dist/` (`+9` bytes raw / `+2` bytes gzip vs PR-3, zero DevTools strings in `dist/`).
6. **CodeMirror viability noted.** Package docs in `node_modules/@effect/ui/ai-docs/src/10_ui/24_mounts.ts` show `Mount.make` and `Mount.makeStream` handling imperative widgets such as CodeMirror, so `RawConfig` would not be a technical blocker if a migration is reconsidered later.

## Friction and risks found

1. **Dual-framework bundle cost.** Adding `effect` and `@effect/ui` beside React 19 added `+75.1` KB gzip (`+30.5%`) for one view. Incremental screen-by-screen migration carries a real payload tax until React is removed completely.
2. **Missing optional peer dependency for Vite DevTools.** `@effect/ui-devtools/node` (`DevToolsVite.plugin`) imports `@effect/platform-node/NodeHttpServer`. Because `@effect/platform-node` is listed as an optional peer dependency, `bun add` did not install it and `vite.config.ts` failed until `@effect/platform-node@^4.1.7` was added explicitly.
3. **Dual test runner setup.** `@effect/vitest` requires Vitest (`bun run test:effect`), while the existing `363` tests run on `bun test`. `package.json` had to exclude `tests/effect-logs/**` from `bun test`.
4. **Verbose builder views and icon duplication.** Without JSX or `@base-ui/react`, `LogsView.ts` required `582` lines of chained `h.*` builders and six inline SVG icon helpers to match `src/mainview/styles/styles.css`.
5. **Async DOM flush versus React Testing Library.** `BrowserHost` flushes DOM updates on a microtask and runs commands on `HtmlScheduler` (`postTask` / `MessageChannel`), while React `fireEvent` flushes synchronously inside `act()`. Existing assertions in `tests/mainview/components-dialogs-views.test.tsx` had to wrap post-`fireEvent` checks in `waitFor(...)`, which raised the test runtime from `26.50` ms to `98-131` ms (mostly from two `50` ms `waitFor` poll intervals). `LogsView` also needed both `input` and `change` listeners for the repo's `setInputValue` test helper, and `Logs.tsx` needed a small `window` `keydown` bridge for direct `window` dispatches.
6. **Async `DevTools.layer` mount lifecycle.** `DevTools.layer` waits for its overlay `<iframe srcdoc="...">` `load` event before resolving. Mounting in dev mode cannot use `Effect.runSync`; `Logs.tsx` forks an async mount fiber in dev and interrupts it before closing `Scope` on unmount.

## DevTools and Electrobun WebView findings

### Verified in live Vite dev server (`http://127.0.0.1:5199/`)

- `DevToolsVite.plugin({ dispatch: true, overlay: false })` kept the overlay off React-only tabs while injecting `<meta name="effect-ui-devtools" content='{"url":"http://127.0.0.1:4774","size":1000}'>` and `<script type="module" src="/@effect-ui/hot" nonce="...">` into served HTML.
- `GET /@effect-ui/hot` returned `200 OK` under `base: './'`.
- Adding `frame-src 'self';` only in the `development-csp` transform in `vite.config.ts` allowed the overlay `srcdoc` iframe without weakening production CSP in `src/mainview/index.html`.
- `DevToolsServer` booted on `http://127.0.0.1:4774`. `GET /` returned `200 OK` (`386,806` bytes standalone viewer HTML).
- `POST http://127.0.0.1:4774/mcp` (`initialize` and `tools/list`) returned `200 OK` and exposed `16` Streamable HTTP MCP tools (`list_sessions`, `list_instances`, `list_entries`, `count_entries`, `get_entry`, `get_chain`, `get_state`, `diff_state`, `show_entry`, `resume`, `set_recording`, `get_message_schema`, `find_instances`, `get_picked`, `dispatch`, `wait`).
- WebMCP (`node_modules/@effect/ui-devtools/dist/internal/webmcp.js`) activates only when `document.modelContext.registerTool` exists. macOS `WKWebView` in Electrobun does not expose `document.modelContext`, so agent inspection in Electrobun uses the loopback MCP server at `http://127.0.0.1:4774/mcp` instead of WebMCP.

### Verified live in the running macOS Electrobun dev app

Tested directly against `MCP Gateway-dev.app` running under `bun run dev` (Vite `127.0.0.1:5173` + DevTools server `127.0.0.1:4774`).

1. **Visual rendering in macOS dark mode.** Captured live window screenshots of the Logs tab and the open Sensitive data popover. Toolbar spacing, `All levels` / `All servers` selects, `Search text (⌘F)`, active teal `Follow Tail`, `Clear logs`, info popover, log rows, and the bottom-right Effect UI DevTools launcher button (`[UI] 73`) rendered cleanly with zero CSP blocking.
2. **Live WebSocket bridge from `WKWebView` to MCP.** `list_sessions` reported `{ app: "LogsView", host: "browser", connected: true, controllable: true }`, `list_instances` showed `/LogsView`, and `get_state` automatically outlined the `39,137`-byte Model and returned exact subtrees when passed `path: ["props"]` or `path: ["model", "pollPhase"]`.
3. **Dispatch, state diff, and Time travel.** Dispatched `ToggledInfo` and `ChangedSearch({ text: "liveness" })` over MCP (`applied: 2 of 2`), read `diff_state` (`text: "" -> "liveness"`), called `show_entry` at the earlier seq (`{ paused: 86, fellBack: [], fallbacks: [], skipped: [] }`), visually confirmed the frozen painted copy showing the open info popover plus `Paused at #86 [Resume]` in the DevTools overlay, and resumed cleanly (`{ resumed: true }`). As documented by Effect UI, scroll position is DOM state outside the Model and resets to top in the painted Time travel copy.
4. **Recording pause.** `set_recording({ tag: "PollTicked", recording: false })` suppressed `PollTicked` bursts while live `PollSucceeded` polling continued, and `recording: true` restored it.
5. **5x rapid tab toggle cleanup.** Sent `Cmd+1 -> Cmd+2 -> Cmd+3 -> Cmd+2` five times via System Events. All five previous sessions disconnected cleanly (`connected: false, controllable: false`), exactly `1` session stayed connected with `1` running `SchedulePollWait`, and `4.2` seconds of observation recorded `deltaPollSucceeded: 2` (exact `2,000` ms cadence with zero duplicate timers).
6. **Clipboard gesture note.** Dispatching `ClickedCopy` synthetically via MCP (without a user click gesture) did not write to the macOS clipboard because `WKWebView` gates `navigator.clipboard.writeText` on user activation.

### Remaining quick manual spot-checks (optional)

1. Click a row's Copy button directly in the window to verify user-gesture clipboard write and `1.5`s check-icon revert, click Pick inside the DevTools pill, and check light macOS appearance if you want visual sign-off in light mode.

## Practical takeaway for `develop`

Keep React 19 + `@base-ui/react` + Tailwind CSS v4 on `develop`. If you want the cleanest piece of this spike with zero new dependencies, extract the pure log buffer logic (`src/mainview/effect-logs/buffer.ts`) into a plain TypeScript helper on `develop` in a future small PR.
