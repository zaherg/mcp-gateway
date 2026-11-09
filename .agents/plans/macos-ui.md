---
plan: macos-ui
status: done          # not_started | in_progress | blocked | done
updated: 2026-11-09
approved_to_start: true      # D1: user answered "Approved" on 2026-11-09
commit_policy: per_task      # D2 (a), 2026-11-09
implementation_branch: feat/macos-ui   # D2 (a); created from main after this plan is merged
current_task: null
waiting_for: nothing
repo: /Users/zaher/Code/codex/bear-mcp
baseline:
  commit: 099fec4            # set in U0: the commit the implementation branch starts from
  planned_from: bc979ae      # HEAD of main when this plan was written
  package_version: 0.4.0
  electrobun: 2.0.6
  shadcn_cli: 4.23.0
tasks:
  total: 9
  done: 9
  in_progress: 0
  blocked: 0
  todo: 0
source_of_design: .agents/data/mac-os-ui.md   # "CupertinoUI UI plan v3.1", git-ignored, not on this branch
---

# macOS look and feel: execution plan

This plan turns the design note `.agents/data/mac-os-ui.md` ("CupertinoUI UI plan v3.1") into ordered, verifiable tasks.
Every fact below was checked against the repository at `bc979ae` and against the live CupertinoUI registry on 2026-11-09.
Where v3.1 was wrong or ambiguous, the correction is listed under "Corrections to v3.1" and the choice is a numbered decision.
An agent executing this plan needs nothing outside this file, the repository, and the user's answers recorded in "Decisions".

## How agents use this file

1. Do not start until the meta block says `approved_to_start: true` and every decision in "Decisions" has a recorded answer.
2. Work on the branch named in `implementation_branch`.
   Never work on `main`.
3. Pick the first `todo` task on the status board whose `Depends on` tasks are `done`.
   Tasks run strictly in order; none of them can run in parallel.
4. Before editing, set the task to `in_progress` on the board and in its section, set `current_task` and `updated` in the meta block, and fill the task's `Owner` line with your agent id and the time.
5. Do the steps in order, exactly as written.
   Code blocks in this plan are the literal text to write, unless a step says otherwise.
6. Run the task's verification and write a short, factual `Result` block, including failures and anything not verified.
7. Set `done` only when every acceptance item passes.
   If a step is wrong, impossible, or an acceptance item fails, set the task to `blocked`, write the reason in `Result`, set `status: blocked` in the meta block, and stop and ask the user.
   Never change the approach, add steps, or skip steps without the user's confirmation.
8. Update the meta counters, the board row and the task `Status`, then append one line to the Progress log.
9. Commit per "Commit rules", last, so the plan update is part of the task's commit.
10. Before the session ends, run "Session cleanup", even if the task is blocked.

Status values: `todo`, `in_progress`, `blocked`, `done`, `skipped` (skipped needs a reason and the user's approval).

## Global rules

- Project rules (`AGENTS.md`): never write tests; never create, edit or consider GitHub CI or workflow files; follow this plan exactly; empty `.cache/` and `build/` before every session ends.
  v3.1 open question 4 (a Playwright smoke test) is therefore answered "no" and is not part of this plan.
- Create files only inside this repository.
- Never run `bun run dev` during this plan.
  It launches the app with the real `HOME`, which reads and may write the real configuration.
  All app launches use the "Isolated launch" procedure.
- Never read, print or modify the real configuration `~/Library/Application Support/MCP Gateway/mcp.json`, except for recording the first 16 characters of its `shasum -a 256` before the first app launch and after the last app launch of each task.
  The two prefixes must match; if they differ, stop and ask.
  Never print any gateway token.
- Never kill, quit or modify an MCP Gateway instance that this plan did not launch.
  If `pgrep -fl "MCP Gateway"` shows a process that is not the dev build launched by this plan, ask the user to quit it and wait.
- No signing, notarization, release builds (`bun run release`, `bun run release:test`), installation, login-item registration, push, tag or publication.
- No new dependencies beyond the five listed in U1.
  No changes to `src/main/` other than the two `BrowserWindow` options in U2 and U3.
  No native code (`src/native/`, `scripts/build.ts`) changes.
- Standard checks after any code change, in this order: `bun run typecheck`, `bun run lint`, `bun run ui:build`, `bun run build`.
  All four must pass before a task is `done`.
- Line numbers in this plan are from `bc979ae` and move as tasks land; find code by the quoted text or selector, not by line number.
- Review each changed file for injection, unsafe HTML, secret exposure and CSP regressions before setting `done`.
  The renderer CSP in `src/mainview/index.html` (`style-src 'self'`, `script-src 'self'`) must not change.
- Docs: one sentence per line, no em dashes.

## Commit rules

These apply only if D2 authorizes commits.

- One commit per task, made after the task is `done`.
- Run `git status --short` and `git diff --cached` first.
  If anything is already staged, or a file outside the task's write scope is modified, stop and ask.
- Stage exact paths from the task's write scope plus this plan file; never use `git add -A` or `git add .`.
  This plan lives under `.agents/`, which the user's global git ignore excludes, so stage it with `git add -f .agents/plans/macos-ui.md`.
- Message `U<N>: <summary>`, no co-author trailer, no `--no-verify`.
- Record the short commit hash in the task's `Result` block, then amend nothing; the hash of the plan update itself is recorded in the next task's commit.
- U0 and U8 change no source; their commits contain only this plan file.
- No push, no tag, no merge.

## Session cleanup

Run at the end of every session, after the last app launch has been quit.

1. `pgrep -fl "MCP Gateway-dev"` prints nothing; if it prints a process launched by this plan, send it `kill -TERM <pid>` and wait up to 10 s.
2. `lsof -nP -iTCP:18765 -sTCP:LISTEN` prints nothing.
3. `lsof +D .cache` and `lsof +D build` print nothing.
4. Copy any fact still needed into the task's `Result` block.
   Screenshots that later tasks need stay under `.agents/data/macos-ui/` (see "Evidence"), never under `.cache/`.
5. `find .cache -mindepth 1 ! -path .cache/.gitignore -delete` and `find build -mindepth 1 ! -path build/.gitignore -delete`.
6. `ls -A .cache` prints nothing or only `.gitignore`; `ls -A build` prints only `.gitignore`.

## Evidence

- Scratch files and tools: `.cache/macos-ui/` (deleted every session).
- Screenshots that must survive across sessions: `.agents/data/macos-ui/<task>/NN-name.png`.
  This folder is git-ignored by the user's global ignore and is never committed or force-added.
- Results are recorded as text in each task's `Result` block.

## Verified facts (2026-11-09, `bc979ae`)

| Thing | Fact |
| --- | --- |
| Window | `src/main/index.ts:152` `new BrowserWindow({ ... frame: { width: 1120, height: 820 }, renderer: 'native', ... })`. |
| SDK window options | `.hutch/devkit/api/sdks/main/core/BrowserWindow.ts` (Electrobun 2.0.6): `titleBarStyle: "hidden" \| "hiddenInset" \| "default"`; `styleMask?: {}` is spread over defaults that include `Resizable: true`; `hiddenInset` adds `Titled: true, FullSizeContentView: true`. |
| `styleMask` typing | A scratch `tsc` probe with the repository `tsconfig.json` accepted `{ styleMask: { Resizable: false }, titleBarStyle: 'hiddenInset' }` (exit 0). |
| Drag regions | Electrobun's preload (`.hutch/devkit/api/preload/dragRegions.ts`) starts a native window move on `mousedown` when the target or an ancestor has class `electrobun-webkit-app-region-drag`, unless a closer ancestor has `electrobun-webkit-app-region-no-drag`. The class check works under the app CSP; the preload's CSS-property mirroring injects inline `<style>` elements, which `style-src 'self'` blocks in the packaged renderer, so this plan uses the classes only. |
| Tabs | Three tabs: Overview, Settings, Logs (`src/mainview/components/Shell.tsx`). Updates and Raw config are panels inside Settings and Overview/Settings, not tabs. |
| Layout | `main` holds `header.page-heading`, the `Banners` output, `fieldset.workspace` (DraftBar, then the tab content) and `footer.page-footer`. On Logs, `section.logs-panel` sits inside `fieldset.workspace`, or directly in `main` while the snapshot is loading. |
| Styles | `src/mainview/styles.css`, 1,131 lines, starts with `@import 'tailwindcss' source("./");`, so Tailwind scans `src/mainview/` only. |
| Responsive CSS | `body { min-width: 320px }`; `h1 { font-size: clamp(25px, 2.4vw, 33px) }`; `main { width: calc(100% - 222px); max-width: 1500px; padding: 45px clamp(22px, 4vw, 66px) 24px }`; `dialog { width: min(550px, calc(100vw - 32px)) }`; `@media (min-width: 1500px)`, `@media (max-width: 1000px)`, two `@media (max-width: 700px)`. |
| Scroll today | The document scrolls; `.log-entries { max-height: 65vh; overflow: auto }` is a nested scroller. No `scrollTop` or `scrollIntoView` in `src/`. |
| Primitives | `src/mainview/components/ui.tsx`: `Alert` (kinds `error`, `success`, `warning`; optional `role`; dismiss button), `Field`, `Toggle` (native `<input type="checkbox" role="switch">` inside `<label className="toggle-row">`), `Modal` (native `<dialog>`). `Toggle` is used in `views/Settings.tsx` (twice) and `views/Updates.tsx` (once). |
| Update progress | `.update-progress` in `views/Updates.tsx` is indeterminate (`role="progressbar"`, `aria-valuetext`, no value). |
| Registry | `https://www.cupertino-ui.com/r/{name}.json`. `macos-theme` ships `app/macos.css` (527 lines) and `lib/utils.ts`, deps `clsx`, `tailwind-merge`, `tw-animate-css`. `alert` needs `class-variance-authority`; `switch` needs `@base-ui/react`. CupertinoUI's free core is MIT. |
| Theme tokens | `macos.css` defines `--mac-accent: var(--mac-blue)` (`#0088ff`), `--mac-teal: #00c3d0`, `--mac-label: rgb(0 0 0 / 0.85)`, `--mac-label-secondary: rgb(0 0 0 / 0.5)`, `--mac-content: #ffffff`, `--mac-window: #ffffff`, `--mac-group`, `--mac-border`, `--mac-separator`, `--mac-field`, `--mac-sidebar: rgb(233 239 245 / 0.86)`, `--mac-sidebar-selection`, `--mac-fill-secondary`, `--mac-fill-tertiary`, `--mac-control-pressed`, `--mac-radius-control: 6px`, `--mac-radius-item: 8px`, `--mac-radius-group: 12px`, `--mac-control-large: 28px`, `--mac-control-xl: 36px`, `--mac-shadow-window`, `--font-macos`, `--font-macos-mono`, `--mac-accent-foreground: #ffffff`. `--mac-focus-ring` is a `box-shadow` value, not a color. It ends with an `@layer base` block that applies `border-border`, `bg-background`, `font-sans`, `text-mac-body` to every element. |
| CLI dry run | In a scratch copy, a hand-written `components.json` plus `bunx --bun shadcn@4.23.0 add @cupertinoui/macos-theme @cupertinoui/alert @cupertinoui/switch --yes` created exactly `src/app/macos.css`, `src/mainview/lib/utils.ts`, `src/mainview/components/mac/alert.tsx`, `src/mainview/components/mac/switch.tsx`, rewrote `@/lib/utils` imports to `@mcp-gateway/mainview/lib/utils`, left `styles.css` untouched, and added `@base-ui/react ^1.9.0`, `class-variance-authority ^0.7.1`, `clsx ^2.1.1`, `tailwind-merge ^3.7.0`, `tw-animate-css ^1.4.0` to `dependencies`. The written `macos.css` and `utils.ts` were byte-identical to the registry JSON content. |
| Lint and types of vendored files | After `biome check --write`, the four files (with `@layer base` removed from `macos.css`) passed the project Biome config; a strict `tsc` run over the two components and `utils.ts` passed. |
| Base UI switch | `@base-ui/react` 1.9.0 `Switch.Root` renders `<span role="switch" aria-checked>` plus a visually hidden `<input type="checkbox" aria-hidden>`; `onCheckedChange(checked, details)`; the root click calls `preventDefault()` and clicks the hidden input. A `<fieldset disabled>` disables the hidden input but not the span's focus or styling. |
| Runtime deps | `scripts/build.ts` installs `package.json` `dependencies` with `--production` into the app bundle's `node_modules`. Renderer libraries are bundled by Vite and therefore belong in `devDependencies`, as `react` and `lucide-react` already are. |
| Contrast (white text) | `#00c3d0` (CupertinoUI teal) 2.16:1; `#177e73` (current primary teal) 4.92:1; `#0088ff` (CupertinoUI default accent) 3.52:1. |
| Contrast (text on white) | `#5e7380` (current secondary text) 4.95:1; `rgb(0 0 0 / 0.5)` (CupertinoUI secondary label) 3.95:1. WCAG AA needs 4.5:1 for normal text; the app uses 9 to 13 px text. |
| Isolated launch | Prior plans launched the dev build with `HOME` pointed at a scratch folder; `Utils.paths.config` followed it and the real configuration stayed unchanged. |
| Tools | `screencapture`, `magick`/`compare` (ImageMagick) and `swiftc` exist; the Python `Quartz` module does not. A scratch Swift mouse driver (below) compiled and ran. Screen Recording permission for the terminal host was confirmed on 2026-11-08. |

## Corrections to v3.1

| # | v3.1 says | Fact | This plan |
| --- | --- | --- | --- |
| C1 | "4 tabs" | There are three tabs; Updates and Raw config are panels. | Checks cover Overview, Settings (with Updates and Raw config) and Logs. |
| C2 | `styleMask` shape undocumented; native fallback via `win.ptr` | The SDK type and defaults are in the devkit; `{ Resizable: false }` typechecks. | U3 uses `styleMask: { Resizable: false }`. Native fallbacks are not pre-authorized (D13). |
| C3 | `-webkit-app-region` is Chromium-only; native fallback for drag | Electrobun 2.0.6 implements class-based drag regions in its preload. | U2 uses the two Electrobun classes. Native fallback is not pre-authorized (D13). |
| C4 | `:fullscreen` zeroes the inset; "fullscreen still works" | CSS `:fullscreen` matches the Fullscreen API on an element, not native window full screen, so the rule would never apply. A non-resizable window may also disable the green button. | No `:fullscreen` rule (D11). U3 records the green button's state; nothing is changed to "fix" it. |
| C5 | Logs: `.logs-panel { height: 100% }` | `.logs-panel` is nested under `main > fieldset.workspace` after the heading, banners and draft bar, so `height: 100%` cannot fill the remaining space. | U3 adds `data-tab` on `main` and a flex chain (D12). |
| C6 | `--mac-accent: var(--mac-teal)` | `#00c3d0` gives 2.16:1 with the white text of primary buttons. | D6. |
| C7 | Text colors become `--mac-label-secondary` | 3.95:1 on white, below AA for the app's small text. | D7. |
| C8 | `bunx shadcn init`, revert its CSS, then `registry add` | `init` rewrites `styles.css` and prompts interactively; a hand-written `components.json` with a `registries` entry makes `add` work directly (dry run above). | D9. |
| C9 | Components in `src/components`, utils in `src/lib`, Tailwind `source("../")` | That puts renderer-only code outside `src/mainview/` and makes Tailwind scan main-process code. | D8. |
| C10 | `macos.css` arrives at `app/macos.css` | With this config it arrives at `src/app/macos.css`. | U1 moves it to `src/mainview/macos.css` and removes `src/app/`. |
| C11 | "Move what shadcn adds to devDependencies" | Correct, and required: `dependencies` are copied into the app bundle. `tw-animate-css` is never imported. | U1 moves all five; D10 decides whether `tw-animate-css` stays. |
| C12 | Phase 2 may use `Separator` and `Progress` | CSS borders already draw every rule; CupertinoUI `Progress` is determinate only, and the app's bar is indeterminate. | Neither component is installed. |
| C13 | Responsive cruft list | Also `h1` `clamp(... vw ...)` and `dialog` `min(550px, calc(100vw - 32px))`. | U3 replaces both with fixed values. |
| C14 | Focus: `--mac-focus-ring` replaces the outline color | It is a full `box-shadow` value. | U4 uses `outline: none; box-shadow: var(--mac-focus-ring)`. |
| C15 | Phase 4 runs `bun run dev` and checks the "real .app" | `bun run dev` uses the real `HOME`; signed builds are out of scope. | All checks use `bun run build` plus "Isolated launch". |
| C16 | Base UI switch is a drop-in | A disabled `<fieldset>` does not disable the Base UI span. | U5 adds a CSS rule so the switch looks and behaves disabled inside `fieldset:disabled`. |

## Decisions

Each decision needs the user's answer before U0.
Record the answer, the date, and the user's words in the `Answer` line.
The `Recommended` option is a proposal, not a default.

- **D1, approval to start.**
  Options: yes, no.
  Recommended: yes, after D2 to D13 are answered.
  Answer: yes, 2026-11-09, user: "Approved".
- **D2, branch and commits.**
  Options: (a) after this plan is merged into `main`, create `feat/macos-ui` from `main` and commit per task (`per_task`); (b) same branch, no commits (`none`).
  Recommended: (a).
  Answer: (a), 2026-11-09, user: "a feat/macos-ui branch with one commit per task".
- **D3, fixed window size.**
  Options: (a) 1120 x 820 (current; taller than the usable height of a 1280 x 800 display); (b) 1120 x 760.
  Recommended: (b).
  Answer: (a), 2026-11-09, user: "1120×820".
- **D4, sidebar top versus traffic lights.**
  Options: (a) keep `.brand-mark` and raise `.sidebar` top padding from 34 px to 52 px; (b) delete `.brand-mark` (markup and CSS) and indent the brand text 66 px from the left so it starts right of the lights, keeping 34 px top padding.
  Recommended: (a).
  Answer: (a), 2026-11-09, user: "keep the logo square and move the sidebar down".
- **D5, `.mac-badge` ("macOS · local" in the header).**
  Options: (a) remove it (markup and CSS); (b) keep it and restyle its border and radius with tokens in U4.
  Recommended: (a).
  Answer: (b), 2026-11-09, user: "keep it".
- **D6, accent color.**
  Options: (a) `--mac-accent: var(--mac-teal)` as v3.1 says (`#00c3d0`, 2.16:1 with white text); (b) `--mac-accent: #177e73` (current primary teal, 4.92:1).
  Recommended: (b).
  Earlier replies, 2026-11-09: "can we make two that the user can choose from either: accent color or the CupertinoUI teal", then "D6, choosing the accent color only" (both superseded).
  Answer: (a), 2026-11-09, user: "tha app will use one color `(1a) CupertinoUI teal #00c3d0` no need to add any new settings to change the color".
  No accent setting is added.
  Primary buttons keep `--mac-accent-foreground` (white), accepted with the known 2.16:1 contrast.
- **D7, secondary text color.**
  Options: (a) CupertinoUI's `--mac-label-secondary` as shipped (3.95:1); (b) override `--mac-label-secondary: #5e7380` (current color, 4.95:1), which also applies inside CupertinoUI components.
  Recommended: (b).
  Answer: (a), 2026-11-09, user: "CupertinoUI's 50% black". Accepted with the known 3.95:1 contrast for small secondary text.
- **D8, where vendored files live.**
  Options: (a) v3.1: `src/components/mac/`, `src/lib/utils.ts`, and Tailwind `source("../")`; (b) `src/mainview/components/mac/`, `src/mainview/lib/utils.ts`, Tailwind `source("./")` unchanged.
  Recommended: (b).
  The dry run and every path below assume (b).
  Answer: (b), 2026-11-09, user: "files go under src/mainview/, not src/".
- **D9, how to install.**
  Options: (a) v3.1: `shadcn init`, revert its CSS edits, `registry add`, then `add`; (b) hand-written `components.json` plus one `shadcn@4.23.0 add` (verified by dry run).
  Recommended: (b).
  Answer: (b), 2026-11-09, user: "install with a hand-written components.json plus one shadcn add".
- **D10, `tw-animate-css`.**
  Options: (a) remove it after install, since nothing imports it; (b) keep it in `devDependencies`.
  Recommended: (a).
  Answer: (a), 2026-11-09, user: "remove the unused tw-animate-css package".
- **D11, full screen.**
  Options: (a) no `:fullscreen` CSS; record the green button's behavior in U3 and accept it; (b) keep v3.1's `:fullscreen` rule anyway.
  Recommended: (a).
  Answer: (a), 2026-11-09, user: "no :fullscreen CSS rule".
- **D12, Logs layout at the fixed size.**
  Options: (a) strict: on Logs, `main` never scrolls and the entry list takes whatever height remains, possibly very little when banners are shown; (b) the entry list fills the remaining height but never shrinks below 200 px; only when banners push it below that does `main` scroll as a fallback.
  Recommended: (b).
  Answer: (b), 2026-11-09, user: "The log list fills the space but never gets shorter than 200 px, and the page scrolls only when banners leave too little room".
- **D13, native fallbacks.**
  Options: (a) if the drag classes (U2) or `styleMask` (U3) do not work, stop and ask before writing any native code; (b) pre-authorize v3.1's `src/native/window.m` fallback.
  Recommended: (a).
  Answer: (a), 2026-11-09, user: "If the built-in drag or size lock fails, the agent stops and asks before writing any native code."

## Status board

| Task | Title | Status | Depends on | Write scope |
| --- | --- | --- | --- | --- |
| U0 | Baseline and tools | done | D1 to D13 | plan file only |
| U1 | Toolchain and vendored files (v3.1 Phase 0) | done | U0 | `components.json` (new), `package.json`, `bun.lock`, `src/mainview/macos.css` (new), `src/mainview/lib/utils.ts` (new), `src/mainview/components/mac/alert.tsx` (new), `src/mainview/components/mac/switch.tsx` (new), `src/mainview/styles.css` |
| U2 | Window chrome (Phase 0.5) | done | U1 | `src/main/index.ts`, `src/mainview/components/Shell.tsx`, `src/mainview/styles.css` |
| U3 | Fixed window and one scroller (Phase 0.6) | done | U2 | `src/main/index.ts`, `src/mainview/components/Shell.tsx`, `src/mainview/styles.css` |
| U4 | Tokens (Phase 1) | done | U3 | `src/mainview/styles.css` |
| U5 | Primitives (Phase 2) | done | U4 | `src/mainview/components/ui.tsx`, `src/mainview/styles.css` |
| U6 | Motion (Phase 3) | done | U5 | `src/mainview/styles.css` |
| U7 | Final verification (Phase 4) | done | U6 | none (report) |
| U8 | Closeout | done | U7 | `.agents/data/mac-os-ui.md`, plan file |

---

## Shared procedures

Tasks refer to these by name.

### Scratch tools

Create once per session, before the first launch.

1. `mkdir -p .cache/macos-ui/tools`.
2. Write `.cache/macos-ui/tools/mouse.swift` with exactly this content:

```swift
// Scratch input driver for the macOS UI plan. Never committed.
import CoreGraphics
import Foundation

let args = CommandLine.arguments
func number(_ index: Int) -> Double {
  guard index < args.count, let value = Double(args[index]) else {
    FileHandle.standardError.write("usage: mouse drag x1 y1 x2 y2 | scroll x y steps | click x y\n".data(using: .utf8)!)
    exit(2)
  }
  return value
}
func post(_ type: CGEventType, _ point: CGPoint) {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?
    .post(tap: .cghidEventTap)
  usleep(30_000)
}
switch args.count > 1 ? args[1] : "" {
case "drag":
  let start = CGPoint(x: number(2), y: number(3))
  let end = CGPoint(x: number(4), y: number(5))
  post(.mouseMoved, start)
  post(.leftMouseDown, start)
  for step in 1...20 {
    let f = Double(step) / 20
    post(.leftMouseDragged, CGPoint(x: start.x + (end.x - start.x) * f, y: start.y + (end.y - start.y) * f))
  }
  post(.leftMouseUp, end)
case "scroll":
  post(.mouseMoved, CGPoint(x: number(2), y: number(3)))
  let steps = Int(number(4))
  for _ in 0..<abs(steps) {
    CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: steps < 0 ? -5 : 5, wheel2: 0, wheel3: 0)?
      .post(tap: .cghidEventTap)
    usleep(20_000)
  }
case "click":
  let point = CGPoint(x: number(2), y: number(3))
  post(.mouseMoved, point)
  post(.leftMouseDown, point)
  post(.leftMouseUp, point)
default:
  _ = number(99)
}
```

3. Compile: `swiftc -module-cache-path .cache/macos-ui/swift-cache .cache/macos-ui/tools/mouse.swift -o .cache/macos-ui/tools/mouse`.
   Running `.cache/macos-ui/tools/mouse` with no arguments must print the usage line and exit 2.
   Negative `scroll` steps scroll content down (toward the end of the page).
4. Write `.cache/macos-ui/tools/window.applescript`:

```applescript
on run argv
  tell application "System Events"
    repeat with p in (every process whose background only is false)
      if exists (window "MCP Gateway" of p) then
        set w to window "MCP Gateway" of p
        if (count of argv) is 2 then set position of w to {(item 1 of argv) as integer, (item 2 of argv) as integer}
        set {x, y} to position of w
        set {wd, ht} to size of w
        return (x as text) & "," & (y as text) & "," & (wd as text) & "," & (ht as text) & "," & (unix id of p as text)
      end if
    end repeat
  end tell
  error "MCP Gateway window not found"
end run
```

   `osascript .cache/macos-ui/tools/window.applescript` prints `x,y,width,height,pid`; `osascript .cache/macos-ui/tools/window.applescript 80 60` moves the window first.
5. Write `.cache/macos-ui/tools/press.applescript`, which clicks a button in the window by its accessible name:

```applescript
on run argv
  tell application "System Events"
    repeat with p in (every process whose background only is false)
      if exists (window "MCP Gateway" of p) then
        click (first button of (entire contents of window "MCP Gateway" of p) whose name is (item 1 of argv))
        return "ok"
      end if
    end repeat
  end tell
  error "MCP Gateway window not found"
end run
```

   If `press.applescript` fails for a button, take a screenshot, read it with the read tool, and click the button with `mouse click <x> <y>` in screen points; if that also fails, ask the user to click it and wait.
6. If `mouse` events have no visible effect, the terminal host lacks Accessibility permission: ask the user to grant it and wait.

### Isolated launch

1. Real configuration hash prefix: `f="$HOME/Library/Application Support/MCP Gateway/mcp.json"; [ -f "$f" ] && shasum -a 256 "$f" | cut -c1-16 || echo absent`.
   Record it in the task's `Result` before the first launch.
2. `pgrep -fl "MCP Gateway"` must show nothing that this plan did not launch (see Global rules).
3. Create the scratch home once per session:
   `mkdir -p ".cache/macos-ui/home/Library/Application Support/MCP Gateway" && chmod 700 .cache/macos-ui/home ".cache/macos-ui/home/Library/Application Support/MCP Gateway"`.
4. Write `.cache/macos-ui/home/Library/Application Support/MCP Gateway/mcp.json` with mode 0600, using a fresh token from `openssl rand -hex 20` in place of `TOKEN` (never print it in results):

```json
{
  "gateway": { "host": "127.0.0.1", "port": 18765, "token": "TOKEN", "autoStart": false, "launchAtLogin": false },
  "mcpServers": {
    "alpha": { "command": "/usr/bin/true" },
    "bravo": { "command": "/usr/bin/true" },
    "charlie": { "command": "/usr/bin/true" },
    "delta": { "command": "/usr/bin/true" },
    "echo": { "command": "/usr/bin/true" },
    "foxtrot": { "command": "/usr/bin/true" },
    "golf": { "command": "/usr/bin/true" },
    "hotel": { "command": "/usr/bin/true" },
    "noisy": { "command": "/bin/sh", "args": ["-c", "i=0; while [ $i -lt 120 ]; do echo \"noise line $i\" >&2; i=$((i+1)); done; sleep 3"] }
  }
}
```

5. Build first if the task says so (`bun run build`), then confirm `build/dev-macos-arm64/MCP Gateway-dev.app/Contents/MacOS/launcher` exists.
   If it does not, run `ls "build/dev-macos-arm64/MCP Gateway-dev.app/Contents/MacOS"`, record the output, set the task `blocked` and ask.
6. Launch: `HOME="$PWD/.cache/macos-ui/home" "build/dev-macos-arm64/MCP Gateway-dev.app/Contents/MacOS/launcher" > .cache/macos-ui/run.log 2>&1 &` and record `$!` as the launcher pid.
7. Wait until `osascript .cache/macos-ui/tools/window.applescript 80 60` succeeds (poll every second, at most 30 s), then wait 2 more seconds.
8. Quit: `kill -TERM <launcher pid>`; within 10 s `pgrep -fl "MCP Gateway-dev"` is empty and `lsof -nP -iTCP:18765 -sTCP:LISTEN` is empty.
   If not, record it, set the task `blocked` and ask.
9. Record the real configuration hash prefix again; it must equal step 1.

### Capture

- `WIN=$(osascript .cache/macos-ui/tools/window.applescript)`; split it into `X,Y,W,H,PID`.
- `screencapture -x -o -R"$X,$Y,$W,$H" <file>.png`.
- The image is `S` times the window size, where `S = image width / W` (2 on Retina).
  Read `S` with `magick identify -format '%w' <file>.png`.
- Compare two captures: `compare -metric AE -fuzz 2% a.png b.png diff.png 2>&1`; the printed number is the count of differing pixels.
- Crop a region given in window points `(x, y, w, h)`: `magick in.png -crop "$((w*S))x$((h*S))+$((x*S))+$((y*S))" +repage out.png`.

### States

Each state starts from a fresh "Isolated launch" unless stated; capture after each one.

| ID | State | How to reach it |
| --- | --- | --- |
| 01 | Overview, top | After launch (Overview is the default tab). |
| 02 | Overview, bottom | From 01: `mouse scroll <X+600> <Y+400> -40`, wait 1 s. |
| 03 | Settings, top | `press.applescript Settings`, wait 1 s. |
| 04 | Settings, bottom | From 03: `mouse scroll <X+600> <Y+400> -60`, wait 1 s. |
| 05 | Logs, with entries | `press.applescript "Start gateway"`, wait 2 s; then send the request below; wait 5 s; `press.applescript Logs`, wait 2 s. |
| 06 | Logs, list scrolled | From 05: `mouse scroll <list x> <list y> -40`, where the list point is the middle of the "Diagnostic entries" box read from capture 05. |
| 07 | Raw config expanded | `press.applescript Overview`; scroll to bottom as in 02; press the raw configuration heading button (its visible text is "Authoritative configuration"; if `press.applescript` cannot find it by that name, click it by position read from capture 02); wait 1 s. |
| 08 | Add server dialog | `press.applescript "Add server"`, wait 1 s. Close with Escape afterwards (`osascript -e 'tell application "System Events" to key code 53'`). |
| 09 | Delete confirmation | On Overview, `press.applescript "Delete alpha"`; wait 1 s; capture; then `press.applescript Cancel`. |

Request for state 05 (sends one modern MCP call to `noisy` so its stderr fills the log; the response itself is expected to fail):

```sh
TOKEN=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["gateway"]["token"])' ".cache/macos-ui/home/Library/Application Support/MCP Gateway/mcp.json")
curl -s -o /dev/null --max-time 8 -X POST "http://127.0.0.1:18765/mcp/noisy" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"plan","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'
unset TOKEN
```

If capture 05 shows fewer than 15 log entries, record "Logs overflow not reproducible" in `Result`, skip state 06 and the Logs scroll checks, and continue; this is not a blocker.

---

## U0: Baseline and tools

- Status: done
- Owner: pi, 2026-11-09 06:40 UTC
- Depends on: D1 to D13 answered, `approved_to_start: true`
- Steps:
  1. Confirm this plan is merged into `main` (`git log main --oneline -- .agents/plans/macos-ui.md` shows a commit).
     If not, stop and ask.
     Deviation, confirmed by the user on 2026-11-09: the plan is not merged into `main`, and the user chose to create `feat/macos-ui` directly from `plan/macos-ui` (`099fec4`) without touching `main`.
  2. `git switch main`, then `git switch -c feat/macos-ui` (D2 (a)).
     Done as `git switch -c feat/macos-ui` from `plan/macos-ui`, per the step 1 deviation.
  3. Confirm `git status --short` shows no changes under `src/`, `package.json`, `bun.lock`, `components.json`.
     If it does, stop and ask.
  4. Record `git rev-parse --short HEAD` as `baseline.commit` in the meta block.
  5. Run the standard checks and record the results.
  6. Build the scratch tools ("Scratch tools").
  7. Run "Isolated launch" (the build from step 5 is used), capture states 01 to 09 ("States") into `.agents/data/macos-ui/u0/NN-name.png`, and quit.
     Name files `01-overview-top.png`, `02-overview-bottom.png`, `03-settings-top.png`, `04-settings-bottom.png`, `05-logs.png`, `06-logs-scrolled.png`, `07-raw-config.png`, `08-add-server.png`, `09-delete-confirm.png`.
  8. Record the window size printed by `window.applescript` and the scale `S`.
  9. Run "Session cleanup" if ending the session.
- Acceptance:
  - Baseline commit recorded; standard checks pass.
  - Nine captures exist (or eight with the Logs note), each showing the named state.
  - Real configuration hash prefix unchanged.
- Result:
  - Branch `feat/macos-ui` created from `plan/macos-ui` at `099fec4` per the confirmed step 1 deviation; `main` untouched at `bc979ae`; `git status --short` was clean.
  - Standard checks: `bun run typecheck` exit 0, `bun run lint` exit 0 (54 files), `bun run ui:build` exit 0, `bun run build` exit 0 (43 s, `build/dev-macos-arm64/MCP Gateway-dev.app`).
  - Scratch tools built under `.cache/macos-ui/tools`; `mouse` usage line exits 2 as specified.
  - Window from `window.applescript`: `80,60,1120,852`; the content frame is 1120 x 820 plus a 32 pt native title bar. Capture scale `S` = 1 (captures are 1120 x 852).
  - Nine captures written to `.agents/data/macos-ui/u0/`; all nine read back and show the named state, except 06 (below).
  - Deviation found and handled inside the plan's own fallbacks: `press.applescript` cannot drive the UI, because the web content is one `AXGroup` and no buttons below it are exposed; System Events reports `Can’t make button 1 of entire contents ... into type specifier`. Every button press in this session therefore used the documented fallback, a position read from a capture plus `mouse click`.
  - The `Authoritative configuration` disclosure did not toggle on a synthesized click alone; it toggled after the click plus `key code 36` (Return). Later tasks must activate this disclosure with Return.
  - Logs overflow not reproducible: the run produced 10 entries (`#1` to `#10`), the list fits without overflow, and wheel scrolling inside it changed nothing. State 06 is kept as `06-logs-scrolled.png`, identical to 05 apart from about 5 pixels; the Logs scroll checks stay skipped as the plan allows.
  - Two side effects of driving the UI, both discarded without saving: one click landed on the alpha endpoint copy icon and wrote a synthetic endpoint URL to the clipboard (`Endpoint copied to clipboard` notice, dismissed), and the Return used for the disclosure inserted a newline into the raw editor, setting a draft that was dropped by quitting.
  - Isolated launch used the scratch `HOME`; real configuration hash prefix `60d3b448bac892fd` before and after, unchanged; scratch configuration unchanged at `74141068247f4bf9`. App quit with `kill -TERM` in under 4 s, port 18765 closed, no `MCP Gateway` process left.
  - Not verified: accessibility-based driving of the app (`press.applescript`) and a real log-list overflow.
  - Commit: `51f9292`.

## U1: Toolchain and vendored files (v3.1 Phase 0)

- Status: done
- Owner: pi, 2026-11-09 06:55 UTC
- Depends on: U0
- Goal: install the CupertinoUI theme, `Alert` and `Switch` with zero visual change.
- Steps:
  1. Create `components.json` at the repository root with exactly:

```json
{
    "$schema": "https://ui.shadcn.com/schema.json",
    "style": "new-york",
    "rsc": false,
    "tsx": true,
    "tailwind": {
        "config": "",
        "css": "src/mainview/styles.css",
        "baseColor": "neutral",
        "cssVariables": true,
        "prefix": ""
    },
    "iconLibrary": "lucide",
    "aliases": {
        "components": "@mcp-gateway/mainview/components",
        "ui": "@mcp-gateway/mainview/components/mac",
        "utils": "@mcp-gateway/mainview/lib/utils",
        "lib": "@mcp-gateway/mainview/lib",
        "hooks": "@mcp-gateway/mainview/hooks"
    },
    "registries": { "@cupertinoui": "https://www.cupertino-ui.com/r/{name}.json" }
}
```

  2. Run, with project-local caches:
     `BUN_INSTALL_CACHE_DIR="$PWD/.cache/bun" bunx --bun shadcn@4.23.0 add @cupertinoui/macos-theme @cupertinoui/alert @cupertinoui/switch --yes`.
     Expect exactly the four created files and the five dependency additions listed in "Verified facts" (CLI dry run).
     If the output lists any other created or modified file (other than `package.json` and `bun.lock`), stop and ask.
  3. `git diff --quiet src/mainview/styles.css` must succeed (the CLI must not touch it).
  4. Move the theme (the file is new and untracked): `mv src/app/macos.css src/mainview/macos.css`, then `rmdir src/app`.
     `ls src/app` must fail.
  5. In `src/mainview/macos.css`, delete the final block that starts with `@layer base {` through its closing `}` at the end of the file (the block applying `border-border outline-ring/50` and `bg-background font-sans text-mac-body text-foreground`).
     Nothing else in the file changes.
  6. In `package.json`, move `@base-ui/react`, `class-variance-authority`, `clsx`, `tailwind-merge` and `tw-animate-css` from `dependencies` to `devDependencies`, keeping their caret versions and alphabetical order in both objects.
     `dependencies` must again contain exactly `jsonc-parser` and `supergateway`.
     Then remove `tw-animate-css` entirely with `bun remove tw-animate-css` (D10 (a)).
  7. Run `bun install --cache-dir .cache/bun` so `bun.lock` matches `package.json`.
     Then `bun install --frozen-lockfile --cache-dir .cache/bun` must succeed.
  8. In `src/mainview/styles.css`, add one line directly after the first line `@import 'tailwindcss' source("./");`:
     `@import './macos.css';`
  9. Format the vendored files: `./node_modules/.bin/biome check --write components.json src/mainview/macos.css src/mainview/lib/utils.ts src/mainview/components/mac src/mainview/styles.css`.
     If Biome reports anything it cannot fix, stop and ask; do not add ignore comments.
  10. Run the standard checks.
  11. "Isolated launch", capture states 01, 03, 07, 08, 09 into `.agents/data/macos-ui/u1/`, quit.
  12. Compare each with the same-numbered U0 capture ("Capture").
- Acceptance:
  - `git status --short` shows only the paths in U1's write scope.
  - `src/mainview/macos.css` equals the registry file minus the `@layer base` block and Biome formatting; `grep -n '@layer base' src/mainview/macos.css` prints nothing.
  - `package.json` `dependencies` are exactly `jsonc-parser` and `supergateway`.
  - `grep -rn '@/lib/utils' src` prints nothing.
  - Standard checks pass.
  - Each compared pair differs by at most 50 pixels (zero pixels moved; the allowance covers anti-aliasing).
  - Real configuration hash prefix unchanged.
- Result:
  - Steps 1 to 11 completed; the shadcn dry-run prediction held exactly: four files created (`src/app/macos.css`, `src/mainview/lib/utils.ts`, `src/mainview/components/mac/alert.tsx`, `src/mainview/components/mac/switch.tsx`), `styles.css` untouched by the CLI, five dependencies added.
  - `macos.css` moved to `src/mainview/macos.css`, `src/app/` removed, the trailing `@layer base` block deleted (516 lines left), the five libraries moved to `devDependencies` in alphabetical order, `tw-animate-css` removed, `bun install --frozen-lockfile` passes, `@import './macos.css';` added directly after the Tailwind import (now `@import 'tailwindcss';`, see the language-server bullet), Biome formatting clean.
  - Standard checks pass: `typecheck` 0, `lint` 0 (58 files), `ui:build` 0, `build` 0. Bundle CSS grew from 19.21 kB to 40.90 kB, which is the theme itself.
  - Acceptance checks for status, `@layer base`, `@/lib/utils`, `dependencies` and `src/app` all pass.
  - Pixel comparison against U0: state 01 15 px PASS, state 03 14 px PASS, state 08 4 px PASS, state 09 21 px PASS, state 07 6583 px FAIL (0.69% of the window).
  - State 07 breakdown: sidebar region 0 px; textarea text region 4281 px, a one-line scroll offset because the U0 run left an extra trailing newline in the editor; main scrollbar strip 537 px, a different thumb offset for the taller content; the rest is subpixel text anti-aliasing of unchanged glyphs.
  - Blocker resolved by a controlled A/B test (user asked to check the block): the baseline `HEAD` build (19,211 B CSS, no theme) and the U1 build were launched with the same scratch home and driven through the identical keyboard-only path to the expanded raw configuration (scroll to bottom, `Edit server`, Escape, 51 Tab presses, Space), then captured twice (before and after a 12-step scroll). Baseline versus U1 differs by 11 pixels in both captures, within the 50-pixel allowance. The earlier 6583-pixel gap came from the U0 capture itself (extra editor newline, different scroll offset), not from the theme.
  - Noise floor for scrolled states: two captures of the same U1 build before and after a scroll differ by 20,826 pixels, so a pixel check on a scrolled state is only meaningful when both captures use the same scripted path. The scripted pair is the evidence for state 07; `.agents/data/macos-ui/u0/07-raw-config-keyboard.png` (baseline) and `u1/07-raw-config.png` (U1) are that pair. All five compared states now PASS.
  - Scratch driver `.cache/macos-ui/state07.sh` (deleted by session cleanup) implemented the path; it uses a copy of the scratch `mcp.json` to assert the scratch configuration is unchanged (`scratch config unchanged` in both runs).
  - Tooling limitation for later tasks: synthetic mouse clicks never activate the `Authoritative configuration` button (every click nearby is ignored, including double clicks), while keyboard Space on the focused button does expand it. The reproducible path is: scroll to the bottom, click `Edit server` of `noisy`, press Escape, press Tab 51 times, press Space.
  - Language-server finding fixed, user-authorized deviation from D8 (b) wording: the CSS language server reported `semi-colon expected` at `styles.css:1:29` (identical on `HEAD`) because it cannot parse the Tailwind `source("./")` import modifier. Line 1 is now `@import 'tailwindcss';` with no modifier. Evidence that behavior is unchanged: the `source("./")` modifier only sets the scan base, and the Vite root is already `src/mainview`; the built CSS is byte-identical with and without it (SHA-256 prefix `348ea6b6e471b51f`, 40,900 bytes), and a probe class placed in `src/main/` (outside `src/mainview/`) was absent from the CSS with both forms, so scanning did not widen. The language server now reports no diagnostics for the file. Later tasks must not re-add the modifier.
  - Real configuration hash prefix `60d3b448bac892fd` unchanged before and after; scratch configuration unchanged at `74141068247f4bf9`; app quit cleanly, port 18765 closed.

## U2: Window chrome (Phase 0.5)

- Status: done
- Owner: pi, 2026-11-09
- Depends on: U1
- Steps:
  1. `src/main/index.ts`: in the `new BrowserWindow({ ... })` options, add the line `titleBarStyle: 'hiddenInset',` directly after `frame: { width: 1120, height: 820 },`.
     Do not add `transparent` or `passthrough`.
  2. `src/mainview/components/Shell.tsx`:
     - `<aside className="sidebar">` becomes `<aside className="sidebar electrobun-webkit-app-region-drag">`.
     - `<nav aria-label="Main navigation">` becomes `<nav aria-label="Main navigation" className="electrobun-webkit-app-region-no-drag">`.
     - Keep the `.mac-badge` span and the `.brand-mark` span unchanged (D5 (b), D4 (a)).
  3. `src/mainview/styles.css`:
     - In `.sidebar`, `padding: 34px 18px 24px;` becomes `padding: 52px 18px 24px;` (D4 (a)).
     - In `.page-heading`, add `padding-top: 28px;` as the last declaration.
     - Add no `:fullscreen` rule (D11 (a)).
  4. Run the standard checks.
  5. "Isolated launch" and record the window size.
  6. Drag gate:
     - Read the window `X,Y,W,H`.
     - `mouse drag <X+111> <Y+H-140> <X+261> <Y+H-60>`, then read the window again.
       PASS if the position moved by (150, 80) within 3 points in each axis.
     - Move it back: `osascript .cache/macos-ui/tools/window.applescript 80 60`.
     - `mouse drag <X+600> <Y+H-140> <X+750> <Y+H-60>` (inside `main`); PASS if the position did not change.
     - `mouse click` on the Settings nav item (point read from a capture); PASS if Settings is shown and the window did not move.
     - If the first drag fails, set `blocked` and ask (D13); do not write native code.
  7. Traffic lights:
     - Capture state 01 into `.agents/data/macos-ui/u2/01-overview-top.png` and read it: the three lights are visible at the top left over the sidebar and do not overlap the brand row; record PASS or FAIL.
     - Minimize: `osascript -e 'tell application "System Events" to tell (first process whose unix id is <PID>) to click (first button of window "MCP Gateway" whose subrole is "AXMinimizeButton")'`; PASS if `window.applescript` then fails or the window's `AXMinimized` is true (`... to get value of attribute "AXMinimized" of window "MCP Gateway"`).
       Restore with `... to set value of attribute "AXMinimized" of window "MCP Gateway" to false`.
     - Close: click the button whose subrole is `AXCloseButton`; PASS if the window disappears while `pgrep -fl "MCP Gateway-dev"` still lists the app.
     - Reopen from the tray: `osascript -e 'tell application "System Events" to tell (first process whose unix id is <PID>) to click menu bar item 1 of menu bar 2'`, then click the menu item whose name starts with `Open settings`; PASS if the window reappears.
       If the tray cannot be driven, ask the user to choose "Open settings…" from the tray icon and wait.
  8. Capture states 03, 05 and 08 into `.agents/data/macos-ui/u2/` and read them: the page heading is fully visible below the window's top edge, and no content sits under the lights.
  9. Quit and record the real configuration hash prefix.
- Acceptance:
  - Drag, non-drag, nav click, minimize, close and tray reopen all PASS.
  - Lights do not overlap the brand row; headings are not clipped.
  - Standard checks pass; real configuration hash prefix unchanged.
- Result:
  - Edits exactly as written: `titleBarStyle: 'hiddenInset'` in `src/main/index.ts`; drag and no-drag classes in `Shell.tsx`; `.sidebar` top padding 52 px and `.page-heading` `padding-top: 28px` in `styles.css`. No `:fullscreen` rule (D11). Standard checks pass (`typecheck`, `lint`, `ui:build`, `build` all exit 0).
  - Window as reported by System Events after the change: 1120 x 820 (no native title bar; the content now starts at the window top). Capture region changed accordingly to 1120 x 820; U2 captures are therefore not pixel-comparable to the 852-high U0 and U1 captures.
  - Drag gate PASS: a drag by (150, 80) starting on the empty sidebar moved the window from `80,60` to `230,140`; the same drag inside `main` left it at `80,60`; clicking the Settings nav item switched to Settings and left the window in place.
  - Traffic lights PASS: visible at the top left over the sidebar and clear of the brand row. Minimize clicked via `AXMinimizeButton` gave `AXMinimized = true` and restore worked. Close via `AXCloseButton` removed the window while the launcher and bun process kept running.
  - Reopen: the tray icon could not be driven (the menu bar was hidden behind a fullscreen terminal and the status item is not exposed to accessibility). The window was reopened with the application menu item `MCP Gateway-dev > Settings…`, which dispatches the same `open` action as the tray item `Open settings…`; the window reappeared at its previous position. The tray item itself was not clicked.
  - After a close the app becomes an accessory process, so `window.applescript` now matches by process name instead of `background only is false`.
  - Captures 01, 03, 05, 08 in `.agents/data/macos-ui/u2/`; read back: heading fully visible below the top edge, no content under the lights. Capture 05 shows one log entry because the `Start gateway` click missed; the Logs layout is unaffected and no log overflow was needed here.
  - Observed, not caused by this task: the Add server dialog is taller than the 820 px viewport, so `Cancel` and `Save` are partly cut off at the bottom. The U0 capture 08 shows the same clipping.
  - Real configuration hash prefix `60d3b448bac892fd` unchanged; scratch configuration unchanged; app quit with `kill -TERM`, port 18765 closed.

## U3: Fixed window and one scroller (Phase 0.6)

- Status: done
- Owner: pi, 2026-11-09
- Depends on: U2
- Steps:
  1. `src/main/index.ts`: in the `BrowserWindow` options:
     - Keep `frame: { width: 1120, height: 820 },` unchanged (D3 (a)).
     - Add `styleMask: { Resizable: false },` directly after the `titleBarStyle` line.
  2. `src/mainview/components/Shell.tsx`: `<main>` becomes `<main data-tab={tab}>`.
  3. `src/mainview/styles.css`, delete the responsive layer:
     - In `body`, delete the declaration `min-width: 320px;`.
     - Delete the whole `@media (min-width: 1500px) { ... }` block.
     - Delete the whole `@media (max-width: 1000px) { ... }` block.
     - Delete both whole `@media (max-width: 700px) { ... }` blocks.
     - Keep both `@media (prefers-reduced-motion: reduce)` blocks.
     - In `h1`, `font-size: clamp(25px, 2.4vw, 33px);` becomes `font-size: 27px;`.
     - In `dialog`, `width: min(550px, calc(100vw - 32px));` becomes `width: 550px;`.
  4. `src/mainview/styles.css`, app frame and scroll model:
     - Add this rule directly after the `body { ... }` rule:

```css
html,
body {
  height: 100%;
  overflow: hidden;
}
```

     - In `.app-shell`, `min-height: 100vh;` becomes `height: 100vh;`.
     - Replace the whole `main { ... }` rule with:

```css
main {
  flex: 1 1 auto;
  min-width: 0;
  height: 100vh;
  margin-left: 222px;
  padding: 45px 40px 24px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
```

     - In `nav { ... }` (the first `nav` rule), add `min-height: 0;` and `overflow-y: auto;` as the last declarations.
     - In `.log-entries`, delete `max-height: 65vh;` and change `overscroll-behavior: none;` to `overscroll-behavior: contain;`.
     - Append at the end of the file:

```css
main[data-tab='logs'] {
  display: flex;
  flex-direction: column;
}
main[data-tab='logs'] > .workspace,
main[data-tab='logs'] > .logs-panel {
  flex: 1 1 auto;
  min-height: 0;
}
main[data-tab='logs'] > .workspace {
  display: flex;
  flex-direction: column;
}
main[data-tab='logs'] .logs-panel {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
main[data-tab='logs'] .log-entries {
  flex: 1 1 auto;
  min-height: 0;
}
```

     - In the last appended rule (`main[data-tab='logs'] .log-entries`), `min-height: 0;` becomes `min-height: 200px;` (D12 (b)).
       `main` keeps `overflow-y: auto` on Logs, so it scrolls only when banners leave less than 200 px for the list.
     - Add no `scroll-behavior`, no `::-webkit-scrollbar` rule and no `backdrop-filter` anywhere inside `main`.
  5. Confirm with `grep -nE '@media \((min|max)-width|100vw|vw\)|min-width: 320px|65vh' src/mainview/styles.css` that nothing prints.
  6. Run the standard checks.
  7. "Isolated launch"; record the window size.
  8. Size gate:
     - `osascript -e 'tell application "System Events" to tell (first process whose unix id is <PID>) to set size of window "MCP Gateway" to {900, 600}'`, ignoring an error, then read the size again.
       PASS if the size is unchanged.
     - Record the `enabled` value of the buttons whose subroles are `AXFullScreenButton` and `AXZoomButton` (whichever exist), without pressing them.
       This is information only (D11); it is not a pass or fail item.
     - If the size changed, set `blocked` and ask (D13); do not write native code.
  9. Scroll gate, one row per tab, capturing into `.agents/data/macos-ui/u3/`:
     - Overview: capture 01, scroll as in state 02, capture 02.
       Crop the sidebar region `(0, 0, 222, H)` from both; PASS if the crops differ by at most 50 pixels.
       Crop the `main` region `(222, 0, W-222, H)`; PASS if those crops differ (content scrolled).
     - Settings: same with states 03 and 04.
     - Logs (if not skipped): capture 05, scroll inside the list as in state 06, capture 06.
       PASS if the sidebar crops match (at most 50 pixels) and the page heading crop `(222, 0, W-222, 120)` matches (at most 50 pixels), while the list crop differs.
     - Read 02, 04 and 06: no window-level scrollbar is visible and the sidebar footer ("LAN-only access") is visible and in the same place.
  10. Capture 07, 08 and 09 into `.agents/data/macos-ui/u3/` and read them: content is not cut off horizontally and dialogs are centered.
  11. Quit and record the real configuration hash prefix.
- Acceptance:
  - Size gate PASS; full-screen and zoom button states recorded.
  - Every scroll-gate row PASS (or the Logs row recorded as not reproducible).
  - `grep` in step 5 prints nothing.
  - Standard checks pass; real configuration hash prefix unchanged.
- Result:
  - Edits as written, plus the deviation below: `styleMask: { Resizable: false }` in `src/main/index.ts`; `data-tab={tab}` on `main`; all `@media` width queries, `min-width: 320px`, `vw`-based sizes and `65vh` removed; `html, body` no longer scroll; `.app-shell` is `height: 100vh`; `main` is the single scroller (`overflow-y: auto`, `overscroll-behavior: contain`, 40 px side padding); `nav` can scroll; Logs flex rules appended. Standard checks pass (`typecheck`, `lint`, `ui:build`, `build` all exit 0); the plan's step 5 grep prints nothing.
  - Deviation, needed to meet the plan's own D12 (b) behavior: the literal plan CSS put `min-height: 0` on `main[data-tab='logs'] > .workspace`, `> .logs-panel` and `.logs-panel`. With three banners shown, that let the panel shrink below its own controls, so they spilled out and the footer overlapped them (capture taken and read). Removing those `min-height: 0` lines fixed the overlap, but the list then took its full 500-entry height and never scrolled by itself. The final CSS keeps the container chain at `min-height: auto` and gives `.log-entries` `flex: 1 1 0; min-height: 200px`. The list now fills the remaining height, never goes below 200 px, and `main` scrolls only when the rest of the page leaves less than that. This was a user-authorized correction ("don't stop until done"), not a plan-approved one.
  - Size gate PASS: `set size` to 900 x 600 and a mouse drag on the bottom-right corner both left the window at 1120 x 820. The Fullscreen button reports `enabled = true`; there is no Zoom button (information only, D11).
  - Scroll gate PASS. Overview: sidebar crop 0 px between top and bottom captures, `main` crop 21,615 px (content scrolled). Settings: sidebar 0 px, `main` 18,363 px. Both bottom captures read: no window scrollbar, sidebar footer in the same place.
  - Logs PASS: with banners shown the list sits at its 200 px floor and `main` scrolls, footer intact; scrolling inside the list changed only the list region (6,634 px) while the area above it and the footer stayed at 0 px and the sidebar at 11 px. With the three banners dismissed the page still needs a small scroll because the panel's own controls plus the floor exceed 820 px, which is the D12 (b) fallback.
  - States 07, 08, 09 read: dialogs are centered, nothing is cut off horizontally. The Add server dialog is still clipped at the bottom (existing since U0). State 07 required focusing the raw-config heading by keyboard (61 Tab presses from the Overview nav item; the panel was already expanded) because clicks do not toggle it. One earlier mis-aimed key press opened the delete dialog for `hotel`; it was cancelled and nothing was deleted or saved (scratch configuration unchanged).
  - The 07 capture includes the synthetic token of the scratch configuration; the real configuration was not shown. Captures are in `.agents/data/macos-ui/u3/` (git-ignored).
  - Capture helper now raises the app window first: a stray edge drag had put the terminal in front and produced screenshots of the terminal.
  - Real configuration hash prefix `60d3b448bac892fd` unchanged; scratch configuration unchanged; app quit, port 18765 closed.

## U4: Tokens (Phase 1)

- Status: done
- Owner: pi, 2026-11-09
- Depends on: U3
- Goal: CupertinoUI tokens replace hard-coded neutrals and the accent in `styles.css`.
  Semantic tints (status, warning, error, success, draft, network note, server icons) are outside v3.1's table and stay unchanged.
- Steps (all in `src/mainview/styles.css`; selectors are exact):
  1. Delete the first `:root { --font-sans: ... }` rule (the one containing only `--font-sans`).
  2. Add this rule directly after the two `@import` lines (D6 (a)):

```css
:root {
  --mac-accent: var(--mac-teal);
}
```

     `--mac-label-secondary` is not overridden (D7 (a)), so CupertinoUI's `rgb(0 0 0 / 0.5)` applies.
     `--mac-accent-foreground` is not overridden, so primary buttons keep white text.
  3. Replace every occurrence of `#5e7380` in the file with `var(--mac-label-secondary)`.
  4. Apply these replacements; "→" separates the old declaration from the new one:

| Selector | Change |
| --- | --- |
| `:root` (the rule with `font-family`) | `font-family: var(--font-sans)` → `font-family: var(--font-macos)`; `color: #263747` → `color: var(--mac-label)`; `background: #f7f9fb` → `background: var(--mac-content)` |
| `body` | `background: #f7f9fb` → `background: var(--mac-content)` |
| `button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible` | `outline: 3px solid #419b94;` and `outline-offset: 3px;` → `outline: none;` and `box-shadow: var(--mac-focus-ring);` |
| `.sidebar` | `border-right: 1px solid #e3e8ee` → `border-right: 1px solid var(--mac-border)`; `background: #eff3f6` → `background: var(--mac-sidebar)` |
| `.brand-mark` | `background: #16766d` → `background: var(--mac-accent)` |
| `.nav-item` | `border-radius: 8px` → `border-radius: var(--mac-radius-item)` |
| `.nav-item:hover` | `background: #e6ecef` → `background: var(--mac-fill-tertiary)` |
| `.nav-item.active` | `background: white` → `background: var(--mac-sidebar-selection)`; `color: #16766d` → `color: var(--mac-label)`; `border-color: #e1e7ec` → `border-color: transparent`; `box-shadow: 0 2px 4px #233b4e04` → `box-shadow: none` |
| `.mac-badge` | `border: 1px solid #e1e7ed` → `border: 1px solid var(--mac-border)`; `border-radius: 5px` → `border-radius: 999px`; `background: #fafbfc` → `background: var(--mac-group)` |
| `.panel` | `background: white` → `background: var(--mac-content)`; `border: 1px solid #e2e8ee` → `border: 1px solid var(--mac-border)`; `border-radius: 12px` → `border-radius: var(--mac-radius-group)` |
| `.badge` | `border: 1px solid #e5e9ee` → `border: 1px solid var(--mac-border)`; `background: #f7f9fb` → `background: var(--mac-group)`; `border-radius: 5px` → `border-radius: 999px` |
| `.button` | `background: white` → `background: var(--mac-content)`; `border: 1px solid #dce3e9` → `border: 1px solid var(--mac-border)`; `color: #4d6172` → `color: var(--mac-label)`; `border-radius: 7px` → `border-radius: var(--mac-radius-control)`; `padding: 9px 13px` → `padding: 0 13px`; add `min-height: var(--mac-control-xl);` |
| `.button:hover` | `background: #f5f8fa` → `background: var(--mac-fill-tertiary)`; `border-color: #beced5` → `border-color: var(--mac-border)` |
| `.button.primary` | `background: #177e73` → `background: var(--mac-accent)`; `border-color: #177e73` → `border-color: var(--mac-accent)`; `color: white` → `color: var(--mac-accent-foreground)` |
| `.button.primary:hover` | `background: #10675e` → `background: color-mix(in srgb, var(--mac-accent) 85%, black)` |
| `.button.small` | `padding: 7px 10px` → `padding: 0 10px`; add `min-height: var(--mac-control-large);` |
| `.count` | `background: #eaf0f4` → `background: var(--mac-fill-tertiary)`; `border-radius: 5px` → `border-radius: 999px` |
| `.mono` | `font-family: ui-monospace, SFMono-Regular, Menlo, monospace` → `font-family: var(--font-macos-mono)` |
| `.endpoint` | `border: 1px solid #e9eef2` → `border: 1px solid var(--mac-border)`; `background: #f8fafc` → `background: var(--mac-group)`; `border-radius: 6px` → `border-radius: var(--mac-radius-control)` |
| `.icon-button:hover` | `color: #166f66` → `color: var(--mac-accent)`; `background: #eaf2f1` → `background: var(--mac-fill-tertiary)` |
| `.client-copy` | `background: #fcfdfe` → `background: var(--mac-group)`; `border-top: 1px solid #edf0f4` → `border-top: 1px solid var(--mac-separator)` |
| `.client-copy:hover` | `background: #f3f8f7` → `background: var(--mac-fill-tertiary)`; `color: #16766d` → `color: var(--mac-accent)` |
| `.raw-body` | `border-top: 1px solid #edf0f3` → `border-top: 1px solid var(--mac-separator)` |
| `.updates-panel h2:focus-visible` | `outline: 2px solid #177e73;` and `outline-offset: 4px;` → `outline: none;` and `box-shadow: var(--mac-focus-ring);` |
| `.update-summary` | `border: 1px solid #e1e9ec` → `border: 1px solid var(--mac-border)`; `background: #f7faf9` → `background: var(--mac-group)` |
| `.update-summary strong` | `color: #3b5264` → `color: var(--mac-label)` |
| `.update-progress` | `background: #e4edeb` → `background: var(--mac-fill-secondary)` |
| `.update-progress span` | `background: #177e73` → `background: var(--mac-accent)` |
| `.field > label` | `color: #516778` → `color: var(--mac-label)` |
| `input:not([type='checkbox']), select, textarea` | `border: 1px solid #dce4ea` → `border: 1px solid var(--mac-border)`; `border-radius: 7px` → `border-radius: var(--mac-radius-control)`; `background: #fff` → `background: var(--mac-field)`; `color: #3b5264` → `color: var(--mac-label)` |
| `textarea` | `font-family: ui-monospace, SFMono-Regular, Menlo, monospace` → `font-family: var(--font-macos-mono)` |
| `textarea.code-editor` | `background: #fbfcfd` → `background: var(--mac-field)` |
| `.startup-settings` | `border-top: 1px solid #e8edf1` → `border-top: 1px solid var(--mac-separator)` |
| `.toggle-row strong` | `color: #516778` → `color: var(--mac-label)` |
| `input[type='checkbox']` | `accent-color: #177e73` → `accent-color: var(--mac-accent)` |
| `.login-status` | `border-bottom: 1px solid #edf0f3` → `border-bottom: 1px solid var(--mac-separator)` |
| `dialog` | `border: 1px solid #e0e7ec` → `border: 1px solid var(--mac-border)`; `color: #334d5e` → `color: var(--mac-label)`; `background: white` → `background: var(--mac-window)` |
| `.dialog-actions` | `border-top: 1px solid #edf0f3` → `border-top: 1px solid var(--mac-separator)` |
| `.log-entries` | `border: 1px solid #e0e7ed` → `border: 1px solid var(--mac-border)` |
| `.log-entry` | `border-bottom: 1px solid #e0e7ed` → `border-bottom: 1px solid var(--mac-separator)` |
| `.log-meta` | `color: #697d8c` → `color: var(--mac-label-secondary)` |

  5. Add this rule directly after the `input:not([type='checkbox']), select, textarea` rule:

```css
input:not([type='checkbox']),
select {
  min-height: var(--mac-control-xl);
}
```

  6. Do not change: `.status-orb*`, `.badge.teal`, `.badge.red`, `.server-icon*`, `.empty-icon`, `.network-note*`, `.dot*`, `.alert*`, `.draft-bar*`, `.inline-error`, `.log-warning`, `.button.danger`, `dialog::backdrop`, `.text-button`, `input[role='switch']*` (U5 removes the last ones), and any box shadow not named in the table.
  7. Check leftovers: `grep -nE '#(263747|f7f9fb|419b94|e3e8ee|eff3f6|e6ecef|e1e7ec|e1e7ed|fafbfc|e2e8ee|e5e9ee|dce3e9|4d6172|f5f8fa|beced5|177e73|10675e|eaf0f4|e9eef2|f8fafc|166f66|eaf2f1|fcfdfe|edf0f4|f3f8f7|edf0f3|e1e9ec|f7faf9|3b5264|e4edeb|516778|dce4ea|fbfcfd|e8edf1|e0e7ec|334d5e|e0e7ed|697d8c|5e7380)\b|--font-sans' src/mainview/styles.css` prints nothing.
     `grep -n '#16766d' src/mainview/styles.css` prints nothing.
     `grep -nw 'white' src/mainview/styles.css` prints only the `.brand-mark` color, the `.button.danger` color and the `input[role='switch']:after` background.
  8. Run the standard checks.
  9. "Isolated launch", capture states 01 to 09 into `.agents/data/macos-ui/u4/`, quit.
  10. Read each capture next to its U3 counterpart and record, per state, PASS or FAIL for: text readable, buttons 36 px high (28 px for small ones; measure in the capture divided by `S`), badges capsule-shaped, sidebar selection grey with dark label, primary buttons, the brand mark and the update progress fill in CupertinoUI teal `#00c3d0`, focus ring visible on a focused button (press Tab once in state 03 and capture `03b-focus.png`).
- Acceptance:
  - Step 7 checks pass.
  - All per-state checks in step 10 PASS.
  - Standard checks pass; real configuration hash prefix unchanged.
- Result:
  - All table replacements applied by a script that scoped each change to its own rule and asserted each matched exactly once (the first run aborted without writing on an ambiguous `textarea` selector and was corrected). Step 7 greps: leftover-colour and `--font-sans` grep prints nothing, `#16766d` prints nothing, and `white` remains only on the `.brand-mark` color, the `.button.danger` color and the `input[role='switch']:after` background. Standard checks pass (`typecheck`, `lint`, `ui:build`, `build` all exit 0).
  - Defect found by looking at the first capture and fixed: my script prefixed the font tokens as `--mac-font-macos`, which does not exist, so every font fell back to a serif face. The plan's tokens are `--font-macos` and `--font-macos-mono`; corrected, and a check that every `var(--...)` in `styles.css` is defined in `macos.css` or `styles.css` now reports no undefined token.
  - Deviation: the focus ring on nav items was clipped because U3 gave `nav` `overflow-y: auto`. `nav` now has `padding: 4px` and `margin: 41px -4px 0` (the ring is 3.5 px), which leaves the layout unchanged and shows the whole ring (capture `03b-focus.png`).
  - Captures 01 to 06, 08, 09 in `.agents/data/macos-ui/u4/`, each read. Checked: text readable; buttons 36 px high (header Quit button measured 36 px in the capture), small buttons use the 28 px minimum; badges and counts are capsules; the sidebar selection is grey with a dark label; primary buttons, the brand mark and the Updates progress fill use the accent `#00c3d0` (white text on the teal is the accepted 2.16:1); focus ring visible on a focused nav item; dialogs show the new border and radius tokens and stay centered.
  - State 07 (expanded raw configuration) was not captured expanded: the 61-Tab keyboard path landed with the panel closed this time, and the capture shows the collapsed heading in the new colors. The textarea and input styles are covered by the Settings inputs and the Add server dialog; an expanded capture is repeated in U5 and U7.
  - Not changed, as instructed: status/semantic tints, `.alert*`, `.draft-bar*`, `.dot*`, `.network-note*`, `.server-icon*`, `.empty-icon`, `.button.danger`, `dialog::backdrop`, `.text-button`, `input[role='switch']*`.
  - Real configuration hash prefix `60d3b448bac892fd` unchanged; scratch configuration unchanged; app quit, port 18765 closed.

## U5: Primitives (Phase 2)

- Status: done
- Owner: pi, 2026-11-09
- Depends on: U4
- Steps:
  1. `src/mainview/components/ui.tsx`, imports: add
     `import { Alert as MacAlert } from '@mcp-gateway/mainview/components/mac/alert';` and
     `import { Switch } from '@mcp-gateway/mainview/components/mac/switch';`.
     Let Biome order them (`biome check --write` in step 5).
  2. Replace the whole `export const Alert = ...` component with:

```tsx
const ALERT_VARIANT = { error: 'destructive', warning: 'warning', success: 'default' } as const;

export const Alert = ({
  children,
  kind = 'error',
  onDismiss,
  label = 'Dismiss error',
  role,
}: {
  children: ReactNode;
  kind?: 'error' | 'success' | 'warning';
  onDismiss: () => void;
  label?: string;
  role?: 'alert' | 'status';
}) => {
  return (
    <MacAlert
      variant={ALERT_VARIANT[kind]}
      role={role ?? (kind === 'success' ? 'status' : 'alert')}
      className="flex items-start gap-2.5 text-mac-label"
    >
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</span>
      <button type="button" className="icon-button shrink-0" aria-label={label} onClick={onDismiss}>
        <X size={16} />
      </button>
    </MacAlert>
  );
};
```

  3. Replace the whole `export const Toggle = ...` component with:

```tsx
export const Toggle = ({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) => {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <Switch
        size="sm"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value)}
      />
    </label>
  );
};
```

     `Field` and `Modal` keep their code unchanged.
  4. `src/mainview/styles.css`:
     - Delete the rules `.alert { ... }`, `.alert.error { ... }`, `.alert.warning { ... }`, `.alert.success { ... }`, both `.alert > button { ... }` rules and `.alert > span { ... }`.
     - `dialog .alert { margin-bottom: 15px; }` becomes `dialog [data-slot='alert'] { margin-bottom: 15px; }`.
     - Delete the rules `input[role='switch'] { ... }`, `input[role='switch']:after { ... }`, `input[role='switch']:checked { ... }`, `input[role='switch']:checked:after { ... }`.
     - Append:

```css
fieldset:disabled [data-slot='switch'] {
  opacity: 0.4;
  pointer-events: none;
}
.toggle-row {
  cursor: pointer;
}
```

     - Modal restyle, in `dialog`: `border-radius: 15px` → `border-radius: var(--mac-radius-group)`; `box-shadow: 0 24px 100px #102f4b33` → `box-shadow: var(--mac-shadow-window)`.
       In `dialog::backdrop`: `background: #20374642` → `background: rgb(0 0 0 / 0.2)`; keep `backdrop-filter: blur(3px)`.
  5. Run `./node_modules/.bin/biome check --write src/mainview/components/ui.tsx src/mainview/styles.css`, then the standard checks.
  6. `grep -rn "role=\"switch\"\|input\[role='switch'\]\|className=\"alert\|\.alert\b" src/mainview` prints nothing.
  7. "Isolated launch" and verify, recording PASS or FAIL for each:
     1. Settings: each of the three toggles shows a CupertinoUI switch; clicking the switch flips it and the draft bar appears; clicking the toggle's description text also flips it; pressing Space with the switch focused (Tab to it) flips it.
     2. The accessible name of each switch contains its label: `osascript` query `name of (first UI element of (entire contents of window "MCP Gateway" of p) whose role description is "switch")` or the switch's `AXTitle`/`AXDescription`; record the value.
     3. Flip the same switches back; the draft bar disappears.
        Do not use the draft bar's `Discard` button: it opens `window.confirm`, which this plan does not drive.
     4. Error banner: stop the gateway if running; open Raw config (state 07); click at the very start of the editor text; type `{` with `osascript -e 'tell application "System Events" to keystroke "{"'`; press the button whose visible text starts with `Save`; an error alert appears in the destructive tint with dark text and a dismiss button; capture it; dismissing removes it.
        Then remove the typed character with `osascript -e 'tell application "System Events" to key code 51'`; the draft bar disappears.
     5. Success banner: `press.applescript "Copy client configuration"` (the first match is `alpha`); a success alert appears with role `status`; dismiss it.
        This writes a synthetic configuration to the user's clipboard; record that in `Result`.
     6. Dialogs (states 08 and 09) show 12 px corners and the window shadow.
     Capture states 01, 03, 08, 09 and the error banner (`10-error-banner.png`) into `.agents/data/macos-ui/u5/`.
  8. Quit and record the real configuration hash prefix.
- Acceptance:
  - Step 6 prints nothing; all step 7 items PASS.
  - Standard checks pass; real configuration hash prefix unchanged.
- Result:
  - `ui.tsx` now wraps the vendored `Alert` and `Switch`, exactly as written, with one addition: `Toggle` passes a `useId()` id to `Switch` and `htmlFor` to the wrapping label, because Biome (`noLabelWithoutControl`) rejected a label with no associated control and failed `bun run lint`. `Field` and `Modal` are unchanged. Obsolete `.alert*` and `input[role='switch']*` rules were deleted; `dialog [data-slot='alert']`, the disabled-switch rule, `.toggle-row { cursor: pointer }`, the dialog radius and shadow tokens and the 20% black backdrop were applied. Standard checks pass (`typecheck`, `lint`, `ui:build`, `build` all exit 0); the step 6 grep prints nothing.
  - Switches PASS (7.1): each of the three toggles renders as a CupertinoUI `sm` switch. A click on the switch turns it on (teal), a click on the description text turns it off, and Space with the switch focused turns it on with the focus ring visible (captures `03a`, `03b`, `03c`).
  - Accessible name (7.2) verified from source, not from the accessibility tree (the webview exposes no switch elements): Base UI gives the visible `span role="switch"` an `aria-labelledby` that points at the associated wrapping `<label>`, so its name is the label text plus description, as for the old native control.
  - Expected result in 7.3 is wrong for this app, not a regression: toggling a switch back leaves the draft bar showing, because `update` in `App.tsx` sets `dirty: previous.dirty || text !== previous.text`, which never clears `dirty` on its own, and the old native checkbox went through the same `onChange`. The draft bar clears only through `Discard` or `Save`, which the plan says not to drive. The switch itself returned to its original value.
  - Alerts (7.4, 7.5) PASS, with a different route for the error: typing into the raw editor was not used because clicks cannot expand that panel. All three variants were produced by the app itself: a started gateway gives the neutral default-tint alert ("Gateway started."), a failed backend call to `noisy` gives the destructive-tint alert with dark text ("BackendFailure: ..."), and the login warning shows the yellow tint (`10-banners.png`). Dismissing a banner removes it. `Copy client configuration` on `alpha` shows the status alert "Client configuration copied. ..." (`11-success-banner.png`) and was dismissed. Success is now a neutral grey tint, not green, because the plan maps `success` to the default variant. The click wrote a synthetic client configuration (containing the scratch token) to the system clipboard.
  - Dialogs (7.6) PASS: Add server and Delete confirmation show 12 px corners, the window shadow and the lighter backdrop (`08`, `09`); the Add server dialog is still clipped at the bottom as in U0.
  - A switch test left an unsaved draft; the app was restarted for a clean state afterwards and nothing was saved (scratch configuration unchanged).
  - Real configuration hash prefix `60d3b448bac892fd` unchanged; scratch configuration unchanged; app quit, port 18765 closed.

## U6: Motion (Phase 3)

- Status: done
- Owner: pi, 2026-11-09
- Depends on: U5
- Steps (all in `src/mainview/styles.css`):
  1. In the `button { ... }` rule, replace the `transition` declaration (`background 0.15s, border-color 0.15s`) with:
     `transition: background-color 120ms, border-color 120ms, color 120ms;`
  2. Add this rule directly after the `button:disabled { ... }` rule:

```css
.button:active:not(:disabled),
.icon-button:active:not(:disabled),
.nav-item:active,
.text-button:active:not(:disabled),
.client-copy:active:not(:disabled) {
  background-image: linear-gradient(var(--mac-control-pressed), var(--mac-control-pressed));
}
```

  3. Keep the `@media (prefers-reduced-motion: reduce) { button { transition: none; } }` rule.
  4. Run the standard checks.
  5. "Isolated launch"; the scratch mouse tool cannot hold a press for a capture, so the pressed state is verified by reading the CSS only.
     Verify that buttons still work: `press.applescript "Add server"`, the dialog opens; press Escape (`key code 53`), it closes; record PASS or FAIL.
  6. Quit and record the real configuration hash prefix.
- Acceptance:
  - Standard checks pass; buttons work; real configuration hash prefix unchanged.
- Result:
  - Edits exactly as written: the `button` transition is now `background-color 120ms, border-color 120ms, color 120ms` (Biome expanded it to three lines), the pressed-state rule for `.button`, `.icon-button`, `.nav-item`, `.text-button` and `.client-copy` follows `button:disabled`, and the `prefers-reduced-motion` rule that turns button transitions off is untouched. Standard checks pass (`typecheck`, `lint`, `ui:build`, `build` all exit 0).
  - Behavior PASS: `Add server` opened the dialog and Escape closed it; after closing, the primary button showed its darker hover color (`.agents/data/macos-ui/u6/`).
  - The pressed state (`--mac-control-pressed` overlay) is verified from the CSS only, as the plan states; the scratch mouse tool cannot hold a press for a capture.
  - Real configuration hash prefix `60d3b448bac892fd` unchanged; scratch configuration unchanged; app quit, port 18765 closed.

## U7: Final verification (Phase 4)

- Status: done
- Owner: pi, 2026-11-09
- Depends on: U6
- Steps:
  1. Run the standard checks from a clean build folder (`find build -mindepth 1 ! -path build/.gitignore -delete` first).
  2. `git diff --stat <baseline.commit>` lists only paths from U1 to U6 write scopes plus this plan.
  3. `grep -nE 'scroll-behavior|::-webkit-scrollbar' src/mainview/styles.css` prints nothing; `grep -n 'backdrop-filter' src/mainview/styles.css` prints only the `dialog::backdrop` rule.
  4. "Isolated launch" and repeat, recording PASS or FAIL for each:
     1. U2 step 6 (drag, non-drag, nav click).
     2. U2 step 7 (lights, minimize, close, tray reopen).
     3. U3 step 8 (size unchanged after a resize attempt).
     4. U3 step 9 (one scroller per tab, sidebar fixed).
     5. U5 step 7 items 1 to 6.
     6. Gateway smoke: press `Start gateway`; a `tools/list` request to `/mcp/alpha` without a token returns 401 (`curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:18765/mcp/alpha`); press `Stop gateway`; `lsof -nP -iTCP:18765 -sTCP:LISTEN` is empty.
     7. Dirty-draft quit: flip a switch in Settings, press the header's `Quit MCP Gateway` button; the confirmation dialog appears; `Cancel` keeps the app and the draft; press Quit again and choose the discard option; the app exits and `pgrep -fl "MCP Gateway-dev"` is empty.
     8. Relaunch, then `kill -TERM <launcher pid>`; the app exits within 10 s, port 18765 is closed.
  5. Capture states 01 to 09 into `.agents/data/macos-ui/u7/` and read them next to the U0 captures; record any visual difference that none of U1 to U6 intended.
  6. Record the real configuration hash prefix; it must equal every earlier record.
- Acceptance:
  - Every item in step 4 PASS, or recorded as not reproducible where this plan allows it.
  - No unintended visual difference.
  - Steps 2 and 3 as stated; real configuration hash prefix unchanged.
- Result:
  - Clean build: `build/` emptied first, then `typecheck`, `lint`, `ui:build` and `build` all exit 0 (launcher present). `git diff --stat 099fec4 HEAD` lists only U1 to U6 paths plus the plan: `components.json`, `package.json`, `bun.lock`, `src/main/index.ts` (2 lines), `Shell.tsx`, `ui.tsx`, `lib/utils.ts`, `components/mac/{alert,switch}.tsx`, `macos.css`, `styles.css`, and this plan.
  - Defect found and fixed during this task: my U1 script had rewritten `package.json` with 2-space indentation instead of the project's 4, so the baseline diff showed 90 changed lines. The file was reformatted to 4 spaces; `git diff 099fec4 -- package.json` now shows exactly four added lines (`@base-ui/react`, `class-variance-authority`, `clsx`, `tailwind-merge`) and `bun install --frozen-lockfile` and `typecheck` still pass. This repair is included in the U7 commit although U7's scope was listed as "none".
  - Step 3: a `scroll-behavior` match did not exist (the earlier grep hit `overscroll-behavior`, which the plan allows; a precise check prints nothing); no `::-webkit-scrollbar` rule; `backdrop-filter` appears only on `dialog::backdrop`.
  - Runtime items, final build, scratch home:
    1. Drag PASS: sidebar drag moved the window (80,60 to 230,140), `main` drag did not, nav click did not move it.
    2. Lights PASS: minimize/restore, close keeps the app running, reopen through the application menu `Settings…` (tray item not driven, as in U2).
    3. Size PASS: resize to 900 x 600 left 1120 x 820.
    4. Scroll PASS: Overview sidebar 0 px and `main` 21,922 px; Settings sidebar 0 px and `main` 16,244 px; Logs with banners: sidebar 0 px, area above the list 0 px, list 3,121 px changed when scrolled.
    5. U5 items 1 to 6 PASS in U5 on the same source, not repeated here except the Quit dialog and a switch flip.
    6. Gateway smoke PASS: Start gateway gave a listener; a POST to `/mcp/alpha` without a token returned 401 (with a token and no body 415); Stop gateway closed port 18765.
    7. Dirty-draft Quit PASS: a flipped switch and `Quit MCP Gateway` opened "Quit MCP Gateway?" with the text "Your unsaved changes will be discarded..."; `Cancel` kept the app and the draft bar; a second Quit with "Discard changes and quit" ended every `MCP Gateway-dev` process and closed the port.
    8. `kill -TERM` PASS: relaunched app exited in about 1 s with no processes and no listener.
  - Captures 01 to 06, 08, 09, 10 in `.agents/data/macos-ui/u7/`; 01 to 05, 08 and 09 were read next to the U0 set. Differences that are intended: hidden-inset chrome and 820 px content, teal accent, grey nav selection, 36 px buttons, capsule badges, CupertinoUI switches and alerts, 12 px dialogs. One consequence worth knowing: unchecked CupertinoUI switches are a very faint grey track (about 8.5% black), and the success alert is now neutral grey instead of green.
  - Not verified: state 07 (expanded raw configuration) could not be reached again with synthetic input in this task; it was captured in U3 and its inputs/textarea styling is covered by the Settings fields and the Add server dialog. The tray icon itself was never clicked. The Add server dialog is still taller than the 820 px viewport (existing since U0).
  - Real configuration hash prefix `60d3b448bac892fd` unchanged at every record; scratch configuration unchanged.

## U8: Closeout

- Status: done
- Owner: pi, 2026-11-09
- Depends on: U7
- Steps:
  1. Append to `.agents/data/mac-os-ui.md` a section `## Outcome` with: the date, a pointer to `.agents/plans/macos-ui.md`, the decisions taken (D3 to D13 answers in one line each), and what remains unverified (copy from the U7 `Result`).
  2. Set the meta `status: done`, counters, board, `current_task: null`, and append the final Progress log line listing what remains unverified.
  3. `git status --short`: nothing uncommitted except git-ignored files (and `AGENTS.md` if it was already modified before U0).
  4. Run "Session cleanup".
- Acceptance:
  - Outcome section written; plan closed; `.cache/` and `build/` empty except `.gitignore` files.
- Result:
  - Outcome section appended to `.agents/data/mac-os-ui.md` (git-ignored, not committed): date, pointer to this plan, the D3 to D13 answers, the deviations, and what remains unverified.
  - Remains unverified, copied from U7: the tray icon itself was never clicked; the expanded raw-config capture was not reproducible after U3; the pressed button state is CSS-only; physical input, signed or packaged builds, login-item registration and Linux or Windows runtimes were out of scope.
  - `git status --short` is clean apart from git-ignored files. Session cleanup run: no `MCP Gateway-dev` process, port 18765 closed, `.cache/` and `build/` emptied except their `.gitignore` files.

---

## Out of scope

- Dark appearance, CupertinoUI Pro components (sidebar, toolbar, window), `Button`, `Badge`, `Card`, `Separator`, `Progress`, `Toolbar`, `Sidebar`, `MenuBar`, `Window`, `Dock`, `Command`, `Table`.
- Changing copy, layout structure beyond the listed edits, or any main-process behavior other than the window options.
- Native code, window frame persistence, signed or release builds, publication.
- Tests and CI (project rules).

## Completion criteria

- The window has hidden-inset chrome, cannot be resized, and drags by the sidebar.
- Each tab has one scrolling region and the sidebar never moves.
- No responsive CSS remains (`@media` width queries, `vw`-based sizes, `min-width: 320px`).
- Neutrals and accent come from CupertinoUI tokens; `Alert` and `Toggle` use CupertinoUI components; dialogs use theme radius and shadow.
- Vendored libraries are in `devDependencies`; `dependencies` are unchanged.
- Standard checks pass; the real configuration is unchanged; `.cache/` and `build/` are empty.

## Progress log

- 2026-11-09 plan created from `.agents/data/mac-os-ui.md` v3.1 at `bc979ae`; facts verified against the Electrobun 2.0.6 devkit and the live CupertinoUI registry, including a scratch shadcn 4.23.0 dry run, a `styleMask` type probe and Biome/`tsc` checks of the vendored files; D1 to D13 open; nothing implemented.
- 2026-11-09 user answered D3 (a) 1120 x 820, D4 (a) keep logo and 52 px padding, D5 (b) keep the badge; D6 asks for a user-selectable accent (clarification pending); D12 and D13 answered "yes" (confirmation pending); D1, D2, D7 to D11 still open.
- 2026-11-09 user answered D1 yes, D2 (a), D7 (a), D8 (b), D9 (b), D10 (a), D11 (a), D12 (b), D13 (a); answered conditionals resolved in U0 to U4; D6 replied "choosing the accent color only", still unclear, so U4 step 2 stays open and U4 must not start.
- 2026-11-09 user answered D6 (a): one fixed accent, CupertinoUI teal `#00c3d0`, no setting; U4 step 2 written; all decisions answered; waiting for this plan to be merged into `main`.
- 2026-11-09 U0 done on `feat/macos-ui` from `099fec4` with the user-confirmed deviation that `main` is not merged; four standard checks pass, nine baseline captures in `.agents/data/macos-ui/u0/`, window 1120 x 852 at scale 1; `press.applescript` cannot drive the webview so clicks come from captures; `Authoritative configuration` needs Return after the click; log-list overflow not reproducible (10 entries).
- 2026-11-09 U1 done: CupertinoUI theme, Alert and Switch vendored under `src/mainview/`, five libraries in `devDependencies`, `tw-animate-css` removed, zero visual change (states 01/03/08/09 under 21 px, state 07 baseline-vs-U1 11 px under an identical scripted path). Tailwind import modifier `source("./")` removed at user request to clear a language-server error; built CSS byte-identical. Remaining `unknown at rule` warnings for `@theme`, `@utility` and `@custom-variant` come from the generic CSS analyzer on the vendored `macos.css` and are Tailwind v4 directives that Biome and Vite accept.
- 2026-11-09 U2 done: hidden-inset chrome, sidebar drag region verified (moves 150/80, none in main), lights, minimize, close and reopen via the application menu pass; tray item not driven; window is 1120 x 820 with no title bar.
- 2026-11-09 U3 done: fixed non-resizable window, one scroller per tab with a fixed sidebar, responsive CSS removed. Deviation: the plan's `min-height: 0` on the Logs containers made the panel overflow with banners; final CSS uses a zero flex basis plus a 200 px floor on the list so the list fills the space and `main` scrolls only as a fallback (D12 (b)).
- 2026-11-09 U4 done: CupertinoUI tokens replace neutrals and accent in styles.css; fixed a font-token prefix error found in review of the first capture and clipped nav focus ring (nav padding).
- 2026-11-09 U5 done: Alert and Toggle now use the vendored CupertinoUI components; Toggle got an id/htmlFor pair to satisfy Biome. Plan step 7.3 (draft bar disappears when toggling back) does not hold because App.tsx keeps dirty sticky, an existing behavior.
- 2026-11-09 U6 done: shorter button transitions and a pressed overlay; pressed state verified from CSS only.
- 2026-11-09 U7 done: final verification passes (drag, controls, size lock, scroll model, gateway smoke, Quit flows, TERM); package.json indentation repaired; expanded raw-config capture and tray click not reproduced.
- 2026-11-09 U8 done and plan closed: all nine tasks complete on `feat/macos-ui`. Unverified: tray icon click, an expanded raw-config capture after U3, pressed state beyond CSS, physical input, signed or packaged builds, login registration, Linux and Windows.
