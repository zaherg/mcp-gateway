# Test layers

Run in order:

1. `bun run test:e2e`: Playwright and installed Google Chrome exercise the real React App through a test-only authenticated loopback bridge to AppService, controller, config store and synthetic stdio/HTTP MCP servers.
2. `bun run test:components`: Vitest, React Testing Library and jsdom exercise App rendering, typed form validation, modal cancel/focus restoration, polling/CAS drafts, repair, token controls, Logs filtering/clear/error states and dismissible operation banners with explicit AppClient doubles.
3. `bun run test:unit` (also `bun test` or `bun run test`): Bun exercises core libraries and injected native-service/login/lifecycle boundaries, including the blocking adapter regressions.

`*.e2e.ts` and `*.component.tsx` are deliberately outside Bun's test filename patterns.
Playwright and Vitest also have explicit include patterns.
Neither unit nor component commands launch a browser or Electrobun.
All fixtures are synthetic; no Bear, Apple account or actual login registration is used.
The login double is injected below AppService through MacLoginManager's native interface.

## GitHub Actions

[The test workflow](../.github/workflows/test.yml) requires typecheck, lint, E2E, component, unit/integration, a development build, and native WebKitGTK smoke on Ubuntu 24.04 x64.
It retains pinned Node 26.13.0, Bun 1.4.4, action SHAs, read-only permissions, and the installed Chrome `channel: chrome`.
Pushes, pull requests, and manual dispatch trigger it; duplicate runs are cancelled within a 30-minute job limit.
Native smoke uses project-local home/XDG/temp directories, an owned DBus socket, Xvfb, and Openbox; no tray host or sandbox bypass is required.
It does not sign, publish, install, or test Windows runtime support.
A hosted Linux run has not yet been performed.

## Boundaries and isolation

The browser bridge exists only under `tests/e2e` and is never a production entrypoint.
Its bearer secret is randomly generated per harness, and requests require exact loopback Host and same-origin browser requests.
Browser profiles and temporary directories are under `.cache/tmp`; fixture config directories are owner-only and removed after shutdown.
Bridge and HTTP upstream listeners bind loopback port 0.
The gateway schema refuses port 0, so gateway ports are selected by binding loopback port 0 and releasing it before startup, retaining a small allocation race.

Browser tests do not exercise Electrobun's RPC implementation or native window close/reopen/quit events.
Those remain the separate built-app `scripts/check-native.ts` smoke boundary, not rerun by these commands.
jsdom's test-only dialog shim has no native top layer or Escape handling; browser tests cover dialog keyboard behavior.
Boundary-scroll, desktop Logs, and mobile error-banner screenshots are captured under `tests/e2e/artifacts` and manually inspected; no pixel-baseline visual regression comparison is claimed.
Native smoke checks actual renderer RPC/scroll policy and fresh, JSON, JSONC, and SIGTERM scenarios with a synthetic MCP session held across window transitions and shutdown.
macOS retains app-local Cocoa Cmd+W and Cmd+Q probes without global keyboard injection or Accessibility permission.
Linux requires real request-close/minimize/restore, destruction/recreation, and the renderer Quit control; it reports shortcuts as not tested and login registration as unsupported.
Missing native behavior fails acceptance rather than being skipped.
Launchers get owned POSIX sessions; bounded cleanup first sends SIGTERM, then escalates only to owned runtime and uniquely marked synthetic fixture groups.
Native smoke covers log-history metadata, not every Logs-tab interaction in the native renderer.

```sh
MCP_GATEWAY_BUILD_ROOT=build/linux-native-ci bun run build
bash scripts/check-native-linux.sh build/linux-native-ci/dev-linux-x64/MCPGateway-dev
```

Run these commands on Linux with the distro packages listed in the workflow.
On macOS, pass a separately built development `.app` to `bun scripts/check-native.ts`.
Stable Linux installer wrappers are deliberately refused by the smoke harness.
Physical keyboard/trackpad gestures remain outside automated coverage.

## Backend regression coverage

`bun test tests/regressions` runs six ordinary tests, with no skip or expected-failure conversion:

- Malformed initialize must return 400 while leaving the endpoint mounted and usable.
- The global 16-resource cap must include retained modern children across two endpoints, alone or mixed with legacy sessions and their asynchronous DELETE cleanup.

The original defects were reproduced before correction: malformed initialization retired the endpoint, and excess retained modern children were admitted.
Shared lifecycle leases now preserve endpoint availability and account for legacy, modern, retained, and closing backend resources across endpoints.
The cap tests check exact resumed tool results, hold actual child cleanup behind a synthetic gate, verify PID cleanup, and verify renewed admission after restart.
Additional tests cover ordinary completed modern calls and HTTP upstream continuation/credential isolation.
All regressions remain included in the default unit command.

## Recorded 0.2.0 release verification

The final 0.2.0 run passed 7 Playwright E2E tests, 21 Vitest component tests across 2 files, and 79 Bun unit/integration/regression tests across 15 files with 1,193 assertions.
JSONC coverage includes strict JSON rejection of comments, checked JSONC parsing, byte-preserving no-ops, comment-preserving edits/renames, shared locks, ambiguous paths, and fail-closed external changes.
Logs coverage includes bounded retention, entry truncation, incremental cursors/generations, filtering, clearing, RPC validation/timeouts, and separation of full local messages from sanitized status summaries.
Notification regressions include Start failure, dismissal, then Copy endpoint before polling: the acknowledged occurrence stays hidden, while a new identical occurrence resurfaces.
Unexpected local exception coverage verifies private diagnostic recording without changing operational failure state or exposing raw details in RPC summaries.
Both review findings had failing reproductions before correction; independent closure review found no remaining issues.
Typecheck, lint, and final applicable LSP diagnostics passed, with zero diagnostics across ten changed files.
Rebuilt development-native and final signed-native smoke passed fresh, JSON stdio, and JSONC stdio scenarios.
The signed-release smoke boundary and remaining limits are recorded in `RELEASE.md` and `artifacts/native-verification.json`.
Documentation closeout regenerated the metadata summary and verified artifact checksums without rerunning the test suites.
