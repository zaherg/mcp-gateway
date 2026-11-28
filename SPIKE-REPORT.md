# Effect UI Throwaway Spike Report

Branch `spike/effect-ui` (originally `spike/effect-ui-logs`) branched from `develop` at `93b63d40afa46ce0783f57f67ff3f715cbe95c06` (`v0.9.0`).

Across three phases, this spike first converted the three primary tabs inside the React shell (`82a1750`), then executed **Plan 066 (`.agents/plans/066-remove-react-full-effect-ui.md`)** to remove React completely and run the entire renderer on `@effect/ui` + `@effect/ui-kit`, and finally executed **Plan 067 (`.agents/plans/067-effect-ui-audit-remediation.md`)** to remediate all audit findings:

- **Single root shell & error boundary** (`src/mainview/main.ts` + `src/mainview/effect-app/`): owns RPC bootstrap, snapshot/menu/appearance subscriptions, unsaved-raw-config guard, window chrome, navigation, and modal orchestration under one persistent `AppView` root wrapped in `AppRoot` (`Component.boundary`) plus a static `BrowserHost.mount` fallback.
- **Shared macOS UI primitives & icons** (`src/mainview/effect-ui/`): replaces `@base-ui/react`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, and `src/mainview/components/mac/*` with typed `h.*` builders, `@effect/ui-kit` `Switch` + `Checkbox`, `h.dialog.modal(true)` + `RestoreDialogFocus` (`Mount.makeStream` with explicit `restoreFocusSelector` support), `LocaleSchema`, and inline SVG icons.
- **All workspace views**: `OverviewView` (`effect-overview/`), `LogsView` (`effect-logs/`), `SettingsView` (`effect-settings/`), and `RawConfigView` (`effect-raw-config/`, mounting CodeMirror 6 via `AttachCodeMirror` `Mount.makeStream` + `Subscription` debounced validation with hashed trigger keys).
- **All modals**: `ServerEditorView`, `KeyMigrationView`, `WhatsNewView` (`effect-dialogs/`), and `UpdatesView` (`effect-updates/`).
- **Scope & approved amendment**: zero edits to `src/core/`, `src/shared/`, or the packaged production CSP `<meta>` in `src/mainview/index.html`. Under the approved Plan 067 scope amendment (`R-05`), three startup-polish changes outside the renderer views are retained: startup background styling in `src/mainview/index.html` (`bb868a4`, alongside `./main.tsx` -> `./main.ts`), delayed window reveal in `src/main/index.ts` + `WindowRevealCoordinator` in `src/main/lifecycle.ts` (`637b8ae` + Plan 067), and dynamic `NSAppearance` in `src/native/window.m` (`637b8ae`).

Do not merge this branch into `develop` without an explicit decision on package stability (`@effect/ui`, `@effect/ui-devtools`, and `@effect/ui-kit` are still pre-1.0 `pkg.pr.new` preview tarballs).

## Verdict

**Removing React eliminated the dual-framework bundle tax (`-209.4` KB raw / `-76.0` KB gzip vs the 3-tab hybrid), bringing the full Effect UI renderer within `+10.4` KB gzip (`+4.2%`) of React-only `develop` — while delivering a single persistent DevTools session (with `dispatch` disabled by default), deterministic `TestClock` / `Story.explore` concurrency tests across stateful views and modals, and zero-leak `Schema.Redacted` wire telemetry.**

Remaining trade-offs before considering a production migration:

1. **Pre-release UI packages:** `@effect/ui`, `@effect/ui-kit`, and `@effect/ui-devtools` are still unreleased `pkg.pr.new` snapshots (`@82a1750`) with experimental APIs, while `effect` (`^4.1.6`), `@effect/vitest` (`^4.1.6`), and `@effect/platform-node` (`^4.1.7`, required explicitly for `DevToolsVite.plugin`) are published npm releases.
2. **Code footprint:** Removing React deleted `11` React/Base UI/Lucide/CVA/utility/RTL packages and all `.tsx` files (`0` `.tsx` files remain), and shared `effect-ui/` primitives removed the per-view control duplication from the hybrid phase. Total renderer TypeScript across `src/mainview/main.ts` and `effect-*` is `8,159` lines across `27` files (vs React-only `develop` where JSX + `@base-ui/react` was more terse), plus `3,570` lines across `18` Vitest Effect UI test files.
3. **Dual test runner:** `@effect/vitest` tests (`67` tests across `18` files) run on Vitest (`bun run test:effect`), while the `329` core/main/shared/DOM/E2E tests run on `bun test` (`bun run test`, using `@testing-library/dom` instead of `@testing-library/react`).

## Measured metrics

All bundle sizes come from `bun run ui:build` (`vite build` v8.3.8, exact raw and `gzip -c` bytes on `dist/index.html` and `dist/assets/*`). All test timings come from local runs on macOS.

| Metric | Trunk (`93b63d4`, React only) | Logs + DevTools (Hybrid) | Logs + Settings (Hybrid) | 3 Tabs (Hybrid) | **Full Effect UI (Plan 066 + 067, React removed)** | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Renderer JS raw | `799,240` B | `1,019,505` B (`+220,265` B) | `1,041,348` B (`+242,108` B) | `1,055,397` B (`+256,157` B) | **`846,037` B** (`+46,797` B / `+5.9%` vs trunk; **`-209,360` B / `-19.8%`** vs 3-tab hybrid) | Measured |
| Renderer JS gzip | `245,988` B | `321,113` B (`+75,125` B) | `329,695` B (`+83,707` B) | `332,383` B (`+86,395` B) | **`256,338` B** (`+10,350` B / `+4.2%` vs trunk; **`-76,045` B / `-22.9%`** vs 3-tab hybrid; Vite reporter: `258.98` kB) | Measured |
| Renderer CSS raw | `55,127` B | `55,445` B (`+318` B) | `55,666` B (`+539` B) | `55,702` B (`+575` B) | **`55,199` B** (`+72` B vs trunk) | Measured |
| Renderer CSS gzip | `10,002` B | `10,081` B (`+79` B) | `10,087` B (`+85` B) | `10,092` B (`+90` B) | **`9,976` B** (`-26` B vs trunk; Vite reporter: `9.97` kB) | Measured |
| `dist/index.html` | `692` B | `692` B | `692` B | `692` B | **`812` B** (`500` B `gzip -c`; Vite reporter: `0.48` kB gzip) | Pass |
| `@effect/ui-devtools` / `4774` in `dist/` | `0` matches | `0` matches | `0` matches | `0` matches | **`0` matches** | Pass |
| React / `react-dom` / `createRoot` in `dist/` | Present | Present | Present | Present | **`0` matches** | Pass |
| `.tsx` files in `src/` & `tests/` | All renderer + UI tests | Hybrid | Hybrid | Hybrid | **`0` files** (`0` React / Base UI / Lucide / RTL imports) | Pass |
| Effect UI test suite (`bun run test:effect`) | N/A | `14` tests (`656` ms) | `25` tests, `8` files (`831` ms) | `34` tests, `11` files (`1.04` s) | **`67` tests across `18` files** (`1.75` s) | Pass |
| Full `bun test` suite (`bun run test`) | `363` pass, `0` fail | `363` pass, `0` fail | `363` pass, `0` fail | `363` pass, `0` fail | **`329` pass, `0` fail** (`7,078` assertions across `18` files in `6.77` s, incl. `E2E-01`..`E2E-06`) | Pass |
| Typecheck (`tsc --noEmit`, TS 7.0.2) | Exit `0` | Exit `0` | Exit `0` | Exit `0` | **Exit `0`** | Pass |
| Lint (`biome check`) | Exit `0` | Exit `0` | Exit `0` | Exit `0` | **Exit `0`** | Pass |

*(Note: `bun run test` decreased from `363` to `329` tests because the React-specific component unit tests were replaced by dedicated Effect UI `HtmlPlay` / `HtmlScene` / `Story.explore` / `TestClock` tests in `bun run test:effect` (`67` tests across `18` files), while `tests/mainview/app-dom.test.ts` retained end-to-end DOM integration tests mounted directly via `BrowserHost.mount(AppView | AppRoot, ...)` + `@testing-library/dom`. Total test count across both runners is `396` passing tests, `0` failing.)*

### Dependencies changed relative to `develop` (`93b63d4`)

- **Removed (`11` devDependencies):** `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@vitejs/plugin-react`, `@base-ui/react`, `lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, `@testing-library/react`.
- **Added (`8` devDependencies):**
  - Published npm packages: `effect@^4.1.6`, `@effect/vitest@^4.1.6`, `@effect/platform-node@^4.1.7`, `vitest@^5.1.2`, `@testing-library/dom@^10.4.0`.
  - `pkg.pr.new` preview tarballs: `@effect/ui@82a1750`, `@effect/ui-devtools@82a1750`, `@effect/ui-kit@82a1750`.

### Production & test code size (Plan 066 + 067 final React-free state)

| Module | Files | Lines (`wc -l`) | Notes |
| --- | --- | --- | --- |
| `src/mainview/main.ts` | `1` | `54` | Single `BrowserHost.mount(AppRoot, ...)` entry point with static `fallback`; DevTools injected dev-only by `DevToolsVite.plugin` (`dispatch: false` by default unless `EFFECT_UI_DEVTOOLS_DISPATCH=1`) |
| `src/mainview/effect-app/` | `5` | `2,962` | `AppView.ts` (incl. `AppRoot`), `chrome.ts`, `logic.ts`, `schemas.ts`, `services.ts` |
| `src/mainview/effect-dialogs/` | `4` | `1,246` | `ServerEditorView.ts`, `KeyMigrationView.ts`, `WhatsNewView.ts`, `server-editor-logic.ts` |
| `src/mainview/effect-logs/` | `3` | `716` | `LogsView.ts`, `buffer.ts`, `services.ts` (React `Logs.tsx` adapter deleted) |
| `src/mainview/effect-overview/` | `3` | `648` | `OverviewView.ts`, `logic.ts`, `services.ts` (React `Overview.tsx` adapter deleted) |
| `src/mainview/effect-raw-config/` | `2` | `773` | `RawConfigView.ts` (incl. CodeMirror 6 `AttachCodeMirror` `Mount.makeStream`), `logic.ts` |
| `src/mainview/effect-settings/` | `3` | `848` | `SettingsView.ts`, `logic.ts`, `services.ts` (React `Settings.tsx` adapter deleted) |
| `src/mainview/effect-ui/` | `5` | `666` | `i18n.ts` (`LocaleSchema`, `richMessage`), `icons.ts`, `index.ts`, `modal.ts`, `primitives.ts` |
| `src/mainview/effect-updates/` | `1` | `246` | `UpdatesView.ts` |
| **Total Effect UI renderer** | **`27`** | **`8,159`** | Zero React bridges, zero `.tsx`, zero `useEffect`/`useRef`/`useState`, zero `as Locale` / `as never` casts |
| `tests/effect-*/*.test.ts` | **`18`** | **`3,570`** | `67` tests (`HtmlPlay`, `HtmlScene`, `Story`, `Story.explore`, `TestClock`, `MessageLog.redactSchema`) |

## What worked well

1. **Removing React eliminated all hybrid friction and slashed bundle overhead.** Dropping React 19, `@base-ui/react`, `lucide-react`, and the three React-to-Effect context adapters (`579` lines of bridge boilerplate) cut `-209,360` B raw (`-76,045` B gzip, `-22.9%`) from the 3-tab hybrid bundle. The full React-free bundle (`256.3` KB gzip) is only `+10.4` KB gzip (`+4.2%`) larger than React-only `develop` (`246.0` KB gzip) while including full `effect` + `@effect/ui` + `@effect/ui-kit` + CodeMirror 6.
2. **One persistent DevTools session for the entire desktop app.** Under `AppRoot` / `AppView`, switching tabs and opening/closing modals no longer destroys and recreates DevTools sessions. Every child component (`OverviewView`, `LogsView`, `SettingsView`, `RawConfigView`, `ServerEditorView`, `KeyMigrationView`, `WhatsNewView`, `UpdatesView`) mounts under `/AppRoot/AppView/...` with causal `causedBy` chains across parent/child events and automatic unmount interruption of background commands (`SchedulePollWait interrupted (unmount)`).
3. **CodeMirror 6 inside `Mount.makeStream` worked cleanly.** `AttachCodeMirror` in `src/mainview/effect-raw-config/RawConfigView.ts` attaches CodeMirror 6 cleanly in both Happy DOM and real macOS `WKWebView`, syncs external document revisions without clobbering cursor state or undo history across rapid synchronous edits, supports `JumpToLine`, and drives debounced remote config validation via a revision-hashed subscription key (never putting raw config text in subscription keys).
4. **Native `<dialog>` modals via `h.dialog.modal(true)` + `RestoreDialogFocus`.** `@effect/ui`'s native `modal(true)` plus `RestoreDialogFocus` (`Mount.makeStream({ beforeCommit: true })`) replaced `@base-ui/react` dialogs cleanly, preserving `Escape`/`cancel` locking while busy and restoring focus via explicit `restoreFocusSelector` -> opener -> `[data-fallback-focus]`.
5. **End-to-end `Schema.Redacted` wire safety.** Every secret-bearing field across `AppSnapshot`, `Document`, `SettingsView`, `ServerEditorView`, `RawConfigView`, and all `Command` args/messages (including `GenerateSettingsToken` / `GenerateServerKey`) uses `Schema.Redacted(Schema.String)`. Both unit tests (`MessageLog.redactSchema`) and full live DevTools wire audits confirmed `{"~redacted": true}` with zero plaintext leaks.
6. **Bounded concurrency & invariant exploration (`Story.explore` + `TestClock`).** Six `Story.explore` test suites cover `LogsView` (`tests/effect-logs/LogsView.story.test.ts` + `tests/effect-logs/smoke.test.ts`), `OverviewView` (`tests/effect-overview/OverviewView.story.test.ts`), `SettingsView` (`tests/effect-settings/SettingsView.story.test.ts`), `UpdatesView` (`tests/effect-updates/UpdatesView.test.ts`), and `ServerEditorView` (`tests/effect-dialogs/ServerEditorView.test.ts`), alongside virtual-clock `TestClock` tests without monkey-patching timers.
7. **Production tree-shaking and dev-mode dispatch lock-down.** `DevToolsVite.plugin` in `vite.config.ts` injects the DevTools MCP bridge only during `vite serve` with `dispatch: process.env.EFFECT_UI_DEVTOOLS_DISPATCH === '1'` (disabled by default so local unauthenticated processes cannot dispatch MVU messages to `127.0.0.1:4774/mcp`), and production `bun run ui:build` strips DevTools completely (`0` matches for `4774`, `effect-ui-devtools`, `react-dom`, or `createRoot` in `dist/`).

## Friction and risks found

1. **Pre-release UI package ecosystem.** `@effect/ui`, `@effect/ui-kit`, and `@effect/ui-devtools` are still `pkg.pr.new` preview builds (`@82a1750`), and `@effect/platform-node` (`^4.1.7`, published on npm alongside `effect@^4.1.6` and `@effect/vitest@^4.1.6`) must be installed explicitly because it is an optional peer dependency of `@effect/ui-devtools/node`.
2. **Dual test runner setup.** `@effect/vitest` requires Vitest (`bun run test:effect`), while the existing `329` tests run on `bun test` (`package.json` excludes `tests/effect-*/**` from `bun test`).
3. **Biome React lint rule (`noComponentHookFactories`).** Even without React installed, Biome's `lint/correctness/noComponentHookFactories` flags PascalCase variant handlers in `TaggedEnum.match` inside functions as inline React components; using `switch (x._tag)` avoids suppressions.
4. **Async DOM flush and Bun error serialization in Happy DOM.** `BrowserHost` flushes DOM updates on a microtask; DOM integration tests in `tests/mainview/app-dom.test.ts` use `waitFor` / `findByRole`, and absence assertions use `expect(queryBy...() === null).toBe(true)` to avoid Happy DOM serialization stalls in `bun:test`.
5. **macOS `WKWebView` occlusion suspension during automated headless inspection.** When `MCP Gateway-dev.app`'s window is 100% occluded behind another opaque window (such as Zed), macOS WebKit suspends the `com.apple.WebKit.WebContent` XPC process after ~2–6 seconds (`mach_msg2_trap`), pausing timers, Vite HMR, and `/control` WebSocket replies until the window is uncovered. This is standard macOS WebKit power management (not an Effect UI defect) and only affects automated MCP driving when the app window is hidden behind another window.

## DevTools and Electrobun WebView findings

### Verified live in the running macOS Electrobun dev app (Plan 066 — Full React-free `AppView`)

Tested directly against `MCP Gateway-dev.app` running under `bun scripts/build.ts dev` (Vite `127.0.0.1:5173` + DevTools MCP server `http://127.0.0.1:4774/mcp`; dispatch now requires `EFFECT_UI_DEVTOOLS_DISPATCH=1`).

1. **Single persistent root session & redaction on boot:** `list_sessions` reported exactly `1` session (`app: "AppView"`, `host: "browser"`, `connected: true`, `controllable: true`). `InitialSnapshotLoaded` mounted `/AppView/OverviewView[overview]` and `/AppView/RawConfigView[raw-config]` with live servers `["bear", "Herd"]`, while `model.snapshot.gateway.configText` and `model.doc.text` reported `{"~redacted": true}`.
2. **`LogsView` polling & clean unmount interruption:** Dispatching `SelectedTab({ tab: "logs" })` mounted `/AppView/LogsView[logs]`, completed `ReadLogsPage` (`PollSucceeded`, `pollPhase: "polling"`, `readError: null`), and started `SchedulePollWait`. Switching away immediately logged `Unmounted` and `CommandInterrupted mcp-gateway/logs/SchedulePollWait interrupted (unmount)`.
3. **`SettingsView` secret redaction (`Schema.Redacted`):** Dispatching `SelectedTab({ tab: "settings" })` mounted `/AppView/SettingsView[settings]` with a hashed `sync-saved-config` key. Dispatching `ChangedToken({ value: "LIVE_SECRET_SETTINGS_TOKEN_XYZ" })` recorded `{"~redacted": true}` on both `model.tokenInput` and `props.savedConfig.token`; auditing all `45/45` wire entries found `11` redacted frames and `0` plaintext leaks.
4. **`ServerEditorView` modal, native `dialog[open]`, and token/env redaction:** Dispatching `MenuCommandReceived({ command: "server:add" })` mounted `/AppView/ServerEditorView[server-editor]` with `MountStarted mcp-gateway/ui/RestoreDialogFocus` and `find_instances("dialog[open]")` returning `total: 1`. Dispatching `ChangedName`, `ChangedCommand`, `ChangedAuthMode("custom")`, `ChangedToken("LIVE_SECRET_SERVER_TOKEN_789")`, and `AddedKeyValueRow("env")` updated `model.editor` cleanly with `token: {"~redacted": true}` and `env[0].value: {"~redacted": true}`; auditing all `38/38` wire entries found `15` redacted frames and `0` plaintext leaks. *(In dev builds, `model.snapshot.update.supported` is `false`, so `updates:open` intentionally clears without opening `UpdatesView`, matching `develop`; `UpdatesView` is verified in `tests/effect-updates/UpdatesView.test.ts` and `tests/mainview/app-dom.test.ts`.)*
5. **`RawConfigView` CodeMirror 6 live mount + validation + redaction:** Dispatching `SelectedTab({ tab: "settings" })` and `ToggledRawOpen({ open: true })` triggered `SubscriptionStarted validate-trigger` (using a revision hash, never raw config text), `MountStarted mcp-gateway/raw-config/AttachCodeMirror`, and `find_instances(".raw-code-editor .cm-editor")` returning `total: 1` owned by `/AppView/RawConfigView[raw-config]`. Dispatching `EditorTextChanged` with a sentinel token (`LIVE_SECRET_RAW_CONFIG_TOKEN_999`) triggered `ChangedDoc` on `AppView` while auditing all `33/33` wire entries confirmed `11` redacted frames and `0` plaintext leaks.
6. **Live `bear` server probe through the gateway:** Dispatching `ClickedTestServer({ name: "bear" })` on `/AppView/OverviewView[overview]` executed the live gateway probe against `bearcli` and settled to `{ name: "bear", state: "passed", message: "Server answered through the gateway (MCP 2025-06-18)." }`.
7. **Time travel (`show_entry` + `resume`):** Calling `show_entry({ seq: 14 })` paused cleanly with `{ paused: 14, fellBack: [], fallbacks: [], skipped: [] }`, and `resume()` returned `{ resumed: true }` with live servers untouched (`["bear", "Herd"]`).

### Historical baseline (Hybrid 3-tab phase, `82a1750`)

- `DevToolsVite.plugin({ dispatch: true, overlay: false })` injected `<meta name="effect-ui-devtools">` and `/@effect-ui/hot` (`200 OK` under `base: './'`); adding `frame-src 'self';` only in Vite's dev CSP transform enabled the overlay `srcdoc` iframe without weakening packaged CSP.
- `POST http://127.0.0.1:4774/mcp` exposed `16` Streamable HTTP MCP tools; macOS `WKWebView` does not expose `document.modelContext`, so agent inspection uses the loopback MCP server rather than WebMCP.
- Full CRUD (Add -> Edit -> Test fail -> Toggle -> Copy 1500ms expiry -> Delete), 5x rapid `Cmd+1/2/3` tab toggles, and dark-mode visual screenshots were verified live during the hybrid phase.

## Practical takeaway for `develop`

- **Pure helper extraction (zero risk, zero new deps):** Extract the pure log buffer logic (`src/mainview/effect-logs/buffer.ts`, `.agents/plans/065-extract-pure-log-buffer.md`) onto `develop` immediately if staying on React 19.
- **Full Effect UI migration (viable once `@effect/ui` reaches stable npm release):** Plans 066 and 067 proved that removing React eliminates the hybrid bundle penalty (`256.3` KB gzip vs `246.0` KB gzip on `develop`, `-76.0` KB gzip vs hybrid), keeps CodeMirror 6 and native `<dialog>` ergonomics intact, and delivers stronger concurrency testing (`Story.explore` + `TestClock`), root crash recovery (`AppRoot`), and redaction-safe live DevTools inspection under a single persistent session.
