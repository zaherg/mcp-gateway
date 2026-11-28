# Effect UI Throwaway Spike Report

Branch `spike/effect-ui` (originally `spike/effect-ui-logs`) branched from `develop` at `93b63d40afa46ce0783f57f67ff3f715cbe95c06` (`v0.9.0`). This spike reimplemented two tabs in `@effect/ui` (`82a1750`):

- **Logs** (`src/mainview/Logs.tsx` + `src/mainview/effect-logs/`): self-contained polling view with `Command.interrupt`, `mode: 'switch'`, `TestClock`, and `Story.explore`.
- **Settings** (`src/mainview/views/Settings.tsx` + `src/mainview/effect-settings/`): form-heavy preferences view bridged to `GatewayViewContext` and using `@effect/ui-kit` (`Switch`).

Both mount inside the existing React `<App />` shell with zero edits to `src/mainview/App.tsx`, `src/core/`, `src/main/`, `src/shared/`, or production CSP in `src/mainview/index.html`, and wire dev-only `@effect/ui-devtools`.

Do not merge this branch into `develop`. Delete or archive it after review.

## Verdict

**No-go for migrating `mcp-gateway` right now. Revisit after `@effect/ui` ships on npm with stable APIs.**

Converting both a self-contained async view (`Logs`) and a context-backed form view (`Settings`) confirmed the same conclusion with stronger evidence. The concurrency model and test tooling (`Story.explore`, `TestClock`, `HtmlPlay`, and the DevTools MCP server) are strong, and `@effect/ui-kit`'s `Switch` matched our macOS Tailwind styles directly. However, four concrete costs outweigh the gains today:

1. Running Effect UI alongside React added `+242,108` bytes raw (`+83,707` bytes gzip, `+34.0%`) to the renderer bundle for two tabs (`+75.1` KB gzip for Logs + `@effect/ui`, plus `+8.6` KB gzip for Settings + `@effect/ui-kit` `Switch`).
2. Packages are unreleased `pkg.pr.new` snapshots with experimental APIs and an optional `@effect/platform-node` peer dependency that `bun add` skipped.
3. Production code expanded sharply on both views: Logs grew from `336` to `903` lines (`2.7x`), and Settings grew from `399` to `1,448` lines (`3.6x`) because `Settings` reads `20` fields and callbacks from `GatewayViewContext`, requiring a `268`-line React-to-Effect adapter, `11` `Command.Service` wrappers, and duplicated `h.*` macOS controls and SVG icons.
4. Testing required maintaining two test runners (`bun test` and `vitest`), and Biome's React lint rule `noComponentHookFactories` threw false positives on PascalCase `TaggedEnum.match` keys inside functions.

## Measured metrics

All bundle sizes come from `bun run ui:build` (`vite build` v8.3.8). All test timings come from local runs on macOS.

| Metric | Trunk (`93b63d4`) | Logs + DevTools | Logs + Settings (`+ ui-kit Switch`) | Status |
| --- | --- | --- | --- | --- |
| Renderer JS raw | `799,240` B | `1,019,505` B (`+220,265` B) | `1,041,348` B (`+242,108` B vs trunk, `+21,843` B vs Logs) | Measured |
| Renderer JS gzip | `245,988` B | `321,113` B (`+75,125` B) | `329,695` B (`+83,707` B vs trunk, `+8,582` B vs Logs) | Measured |
| Renderer CSS raw | `55,127` B | `55,445` B (`+318` B) | `55,666` B (`+539` B vs trunk) | Measured |
| Renderer CSS gzip | `10,002` B | `10,081` B (`+79` B) | `10,087` B (`+85` B vs trunk) | Measured |
| `@effect/ui-devtools` in `dist/` | `0` matches | `0` matches | `0` matches | Pass |
| Existing `Logs` DOM test (`bun test`) | `26.50` ms | `98.04` ms full | `98.17` ms full | Pass |
| Existing `Settings` DOM tests (`bun test`) | Pass | Pass | `43.78` ms + `10.89` ms (`2` pass) | Pass |
| Effect UI test suite (`bun run test:effect`) | N/A | `14` tests (`656` ms) | `25` tests across `8` files (`831` ms) | Pass |
| Full existing suite (`bun run test`) | `363` pass, `0` fail | `363` pass, `0` fail | `363` pass, `0` fail (`7,363` assertions) | Pass |
| Typecheck (`tsc --noEmit`, TS 7.0.2) | Exit `0` | Exit `0` | Exit `0` | Pass |
| Lint (`biome check`) | Exit `0` | Exit `0` | Exit `0` | Pass |

### Code size and lint suppressions

| Scope | Trunk (`develop`) | Spike (`spike/effect-ui`) |
| --- | --- | --- |
| Logs production files | `1` file (`src/mainview/Logs.tsx`, `336` lines) | `4` files (`Logs.tsx` `108` + `buffer.ts` `97` + `services.ts` `116` + `LogsView.ts` `582` = `903` lines) |
| Settings production files | `1` file (`src/mainview/views/Settings.tsx`, `399` lines) | `4` files (`Settings.tsx` `268` + `logic.ts` `88` + `services.ts` `132` + `SettingsView.ts` `960` = `1,448` lines) |
| React hooks / refs in `Logs.tsx` | `12` `useState`, `6` `useRef`, `4` `useEffect` | `0` `useState`, `3` `useRef`, `2` `useEffect` |
| React hooks / refs in `Settings.tsx` | `5` `useState`, `1` `useEffect` (`1` `biome-ignore`) | `0` `useState`, `1` `useMemo`, `5` `useRef`, `3` `useEffect` (`0` `biome-ignore`) |
| Effect UI tests | `0` lines | `8` files (`1,308` lines total, `25` tests: `14` Logs + `11` Settings) |

## What worked well

1. **Exhaustive concurrency verification (`Logs` and `Settings`).** Replacing `Logs` refs with `pollPhase: 'polling' | 'clearing'`, `Command.interrupt`, and `mode: 'switch'` let `Story.explore` check overlapping `PollSucceeded`, `PollFailed`, and `ClickedClear` settlements to depth 5 (`tests/effect-logs/LogsView.story.test.ts`). On `Settings`, `Story.explore` checked interleaved draft typing, `GenerateAndCommitToken`, `SyncedSavedConfig` revision resyncs, and `ImportExternalServers` settlements (`tests/effect-settings/SettingsView.story.test.ts`).
2. **`@effect/ui-kit` `Switch` dropped into macOS styling cleanly.** `Switch` emits `role="switch"`, `aria-checked`, and `data-checked` / `data-unchecked` / `data-disabled` on both `root` and `thumb`. Existing Tailwind classes from `src/mainview/components/mac/switch.tsx` worked unchanged, and wrapping inside `<label class="toggle-row" for={id}>` kept the existing `getToggleControl` DOM tests passing.
3. **Explicit serializable gateway mutations.** Modeling `Settings` writes as a `GatewayMutation` tagged enum (`SetHost`, `SetPort`, `SetAllowedPeers`, `SetKeepAwake`, `ReplaceTokenWithLiteral`, etc.) preserved `undefined`-omission semantics (`keepAwake: false`, cleared `allowedPeers`, Keychain `tokenRef` replacement) while staying JSON-serializable for DevTools and tests.
4. **Deterministic time control without monkey-patching timers.** `HtmlPlay` with `TestClock.adjust('2 seconds')` and `TestClock.adjust('1500 millis')` tested retry cadence, `hasMore` immediate draining, and copy badge expiry without patching `globalThis.setTimeout`.
5. **Clean embedded mount inside React.** `BrowserHost.mountEffect` with `{ head: false }`, `root.setProps(...)`, and `Scope.close` mounted both `LogsView` and `SettingsView` without touching `src/mainview/App.tsx`, `src/core/`, `src/main/`, `src/shared/`, or `src/mainview/index.html`.
6. **Production tree-shaking of DevTools.** Guarding `DevTools.layer` with `import.meta.env.DEV` stripped `@effect/ui-devtools` completely from `dist/` (`0` DevTools strings in production output).
7. **CodeMirror viability noted.** Package docs in `node_modules/@effect/ui/ai-docs/src/10_ui/24_mounts.ts` show `Mount.make` and `Mount.makeStream` handling imperative widgets such as CodeMirror, so `RawConfig` would not be a technical blocker if a migration is reconsidered later.

## Friction and risks found

1. **Dual-framework bundle cost.** Adding `effect`, `@effect/ui`, and `@effect/ui-kit` beside React 19 added `+83.7` KB gzip (`+34.0%`) for two views. Incremental screen-by-screen migration carries a real payload tax until React is removed completely.
2. **High bridge cost on context-coupled views (`Settings` vs `Logs`).** `Logs` only took `{ client, servers }` (`108`-line adapter). `Settings` consumed `20` values/callbacks from `GatewayViewContext`, requiring a `268`-line adapter (`useMemo` for `SettingsProps`, `callbacksRef`, and a `savedSyncKey` effect to dispatch `SyncedSavedConfig` on revision changes without clobbering unsaved input drafts).
3. **Missing optional peer dependency for Vite DevTools.** `@effect/ui-devtools/node` (`DevToolsVite.plugin`) imports `@effect/platform-node/NodeHttpServer`. Because `@effect/platform-node` is listed as an optional peer dependency, `bun add` did not install it and `vite.config.ts` failed until `@effect/platform-node@^4.1.7` was added explicitly.
4. **Dual test runner setup.** `@effect/vitest` requires Vitest (`bun run test:effect`), while the existing `363` tests run on `bun test`. `package.json` had to exclude `tests/effect-*/**` from `bun test`.
5. **Verbose builder views and control duplication.** Without JSX or `@base-ui/react`, `LogsView.ts` (`582` lines) and `SettingsView.ts` (`960` lines) had to duplicate macOS `Button`, `Input`, `NativeSelect`, `Label`, `Alert`, `Field`, and Lucide SVG icons in chained `h.*` builders.
6. **Biome React lint false positive on `TaggedEnum.match`.** Biome's `lint/correctness/noComponentHookFactories` flagged PascalCase variant handlers inside `GatewayMutation.match(mutation, { SetHost: ... })` inside a function as inline React components; replacing `.match` with a `switch (mutation._tag)` resolved it without suppressions.
7. **Async DOM flush versus React Testing Library.** `BrowserHost` flushes DOM updates on a microtask and runs commands on `HtmlScheduler`. Existing synchronous post-`fireEvent` checks in `tests/mainview/components-dialogs-views.test.tsx` (in both the `Logs` test and two assertions in the `Settings` tests) had to be wrapped in `waitFor(...)`, and text inputs needed both `input` and `change` listeners for the repo's `setInputValue` helper.
8. **Async `DevTools.layer` mount lifecycle.** `DevTools.layer` waits for its overlay `<iframe srcdoc="...">` `load` event before resolving. Mounting in dev mode cannot use `Effect.runSync`; both `Logs.tsx` and `Settings.tsx` fork an async mount fiber in dev and interrupt it before closing `Scope` on unmount.

## DevTools and Electrobun WebView findings

### Verified in live Vite dev server (`http://127.0.0.1:5199/`)

- `DevToolsVite.plugin({ dispatch: true, overlay: false })` kept the overlay off React-only tabs while injecting `<meta name="effect-ui-devtools" content='{"url":"http://127.0.0.1:4774","size":1000}'>` and `<script type="module" src="/@effect-ui/hot" nonce="...">` into served HTML.
- `GET /@effect-ui/hot` returned `200 OK` under `base: './'`.
- Adding `frame-src 'self';` only in the `development-csp` transform in `vite.config.ts` allowed the overlay `srcdoc` iframe without weakening production CSP in `src/mainview/index.html`.
- `DevToolsServer` booted on `http://127.0.0.1:4774`. `GET /` returned `200 OK` (`386,806` bytes standalone viewer HTML).
- `POST http://127.0.0.1:4774/mcp` (`initialize` and `tools/list`) returned `200 OK` and exposed `16` Streamable HTTP MCP tools (`list_sessions`, `list_instances`, `list_entries`, `count_entries`, `get_entry`, `get_chain`, `get_state`, `diff_state`, `show_entry`, `resume`, `set_recording`, `get_message_schema`, `find_instances`, `get_picked`, `dispatch`, `wait`).
- WebMCP (`node_modules/@effect/ui-devtools/dist/internal/webmcp.js`) activates only when `document.modelContext.registerTool` exists. macOS `WKWebView` in Electrobun does not expose `document.modelContext`, so agent inspection in Electrobun uses the loopback MCP server at `http://127.0.0.1:4774/mcp` instead of WebMCP.

### Verified live in the running macOS Electrobun dev app (Logs tab)

Tested directly against `MCP Gateway-dev.app` running under `bun run dev` (Vite `127.0.0.1:5173` + DevTools server `127.0.0.1:4774`).

1. **Visual rendering in macOS dark mode.** Captured live window screenshots of the Logs tab and the open Sensitive data popover. Toolbar spacing, `All levels` / `All servers` selects, `Search text (⌘F)`, active teal `Follow Tail`, `Clear logs`, info popover, log rows, and the bottom-right Effect UI DevTools launcher button (`[UI] 73`) rendered cleanly with zero CSP blocking.
2. **Live WebSocket bridge from `WKWebView` to MCP.** `list_sessions` reported `{ app: "LogsView", host: "browser", connected: true, controllable: true }`, `list_instances` showed `/LogsView`, and `get_state` automatically outlined the `39,137`-byte Model and returned exact subtrees when passed `path: ["props"]` or `path: ["model", "pollPhase"]`.
3. **Dispatch, state diff, and Time travel.** Dispatched `ToggledInfo` and `ChangedSearch({ text: "liveness" })` over MCP (`applied: 2 of 2`), read `diff_state` (`text: "" -> "liveness"`), called `show_entry` at the earlier seq (`{ paused: 86, fellBack: [], fallbacks: [], skipped: [] }`), visually confirmed the frozen painted copy showing the open info popover plus `Paused at #86 [Resume]` in the DevTools overlay, and resumed cleanly (`{ resumed: true }`). As documented by Effect UI, scroll position is DOM state outside the Model and resets to top in the painted Time travel copy.
4. **Recording pause.** `set_recording({ tag: "PollTicked", recording: false })` suppressed `PollTicked` bursts while live `PollSucceeded` polling continued, and `recording: true` restored it.
5. **5x rapid tab toggle cleanup.** Sent `Cmd+1 -> Cmd+2 -> Cmd+3 -> Cmd+2` five times via System Events. All five previous sessions disconnected cleanly (`connected: false, controllable: false`), exactly `1` session stayed connected with `1` running `SchedulePollWait`, and `4.2` seconds of observation recorded `deltaPollSucceeded: 2` (exact `2,000` ms cadence with zero duplicate timers).
6. **Clipboard gesture note.** Dispatching `ClickedCopy` synthetically via MCP (without a user click gesture) did not write to the macOS clipboard because `WKWebView` gates `navigator.clipboard.writeText` on user activation.

### Verified live in the running macOS Electrobun dev app (Settings + Logs handoff)

Tested directly against `MCP Gateway-dev.app` running under `bun run dev` (`Cmd+3` Settings and `Cmd+2` Logs, DevTools server `127.0.0.1:4774`).

1. **Visual rendering of Settings in macOS dark mode.** All three `@effect/ui-kit` `Switch` toggles (`Launch app at login`, `Start gateway when the app opens`, `Keep the Mac awake while the gateway runs`), the green login-item LED, `Appearance` and `Language` native selects, `Network` fields, and the bottom-right DevTools launcher (`[UI] 0`) rendered cleanly with zero visual defects or CSP blocking.
2. **Live MCP inspection on `/SettingsView`.** `list_sessions` reported `{ app: "SettingsView", host: "browser", connected: true, controllable: true }`. Dispatching a non-mutating `ChangedHost({ value: "10.0.0.42" })` returned `{ applied: 1, of: 1, seq: 3 }`, `diff_state` reported the exact `hostInput` change, `show_entry` paused cleanly at `seq: 3` (`fellBack: [], skipped: []`), `resume` returned `{ resumed: true }`, and `ChangedHost` restored the original draft without saving.
3. **Secret redaction caught and fixed live with `Schema.Redacted`.** Initially, calling `get_state` on `/SettingsView` exposed literal `model.tokenInput` and `props.savedConfig.token` in plaintext over local MCP (`127.0.0.1:4774/mcp`) because both fields used plain `Schema.String`. Wrapping all token fields across `SettingsProps`, `SettingsModel`, `SettingsMessage`, and `GatewayMutation` in `Schema.Redacted(Schema.String)` fixed the leak: live `get_state` on `MCP Gateway-dev.app` now returns `{ "~redacted": true }` for both `model.tokenInput` and `props.savedConfig.token`, and `tests/effect-settings/SettingsView.story.test.ts` guards wire redaction with `MessageLog.redactSchema`.
4. **Live Logs inspection and clean `Settings <-> Logs` session handoff.** Switching `Settings` (`Cmd+3`) -> `Logs` (`Cmd+2`) -> `Settings` (`Cmd+3`) cleanly disconnected every previous Effect UI session (`connected: false`), kept exactly `1` connected session at a time, and showed `/LogsView` running `1` `SchedulePollWait` timer with `cursor: 10`, `readError: null`, `clearError: null`, and live `bear` session traffic.

## Practical takeaway for `develop`

Keep React 19 + `@base-ui/react` + Tailwind CSS v4 on `develop`. Extract only the pure log buffer logic (`src/mainview/effect-logs/buffer.ts`, planned in `.agents/plans/065-extract-pure-log-buffer.md`) into a plain TypeScript helper on `develop` with zero new dependencies.
