# Test layers

Run in order:

1. `bun run test:e2e`: Playwright and installed Google Chrome exercise the real React App through a test-only authenticated loopback bridge to AppService, controller, config store and synthetic stdio/HTTP MCP servers.
2. `bun run test:components`: Vitest, React Testing Library and jsdom exercise App rendering, typed form validation, modal cancel/focus restoration, polling/CAS drafts, repair, token controls, Logs filtering/clear/error states and dismissible operation banners with explicit AppClient doubles.
3. `bun run test:unit` (also `bun test` or `bun run test`): Bun exercises core libraries and injected native-service/login/lifecycle boundaries, including the blocking adapter regressions.

`*.e2e.ts` and `*.component.tsx` are deliberately outside Bun's test filename patterns, and Playwright and Vitest use explicit include patterns.
Neither unit nor component commands launch a browser or Electrobun.
All fixtures are synthetic; no Bear, Apple account or actual login registration is used.
The login double is injected below AppService through MacLoginManager's native interface.

## GitHub Actions

[The test workflow](../.github/workflows/test.yml) runs typecheck, lint, E2E, component, unit/integration, a development build, and native WebKitGTK smoke on Ubuntu 24.04 x64 for pushes, pull requests, and manual dispatch.
Native smoke uses project-local home/XDG/temp directories, an owned DBus socket, Xvfb, and Openbox; no tray host or sandbox bypass is required.
The workflow does not sign, publish, install, or test Windows runtime support.
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
Boundary-scroll, desktop Logs and mobile error-banner screenshots are captured under `tests/e2e/artifacts` and manually inspected; no pixel-baseline visual regression comparison is claimed.
Native smoke checks actual renderer RPC/scroll policy and fresh, JSON, JSONC and SIGTERM scenarios with a synthetic MCP session held across window transitions and shutdown.
macOS retains app-local Cocoa Cmd+W and Cmd+Q probes without global keyboard injection or Accessibility permission.
Linux requires real request-close/minimize/restore, destruction/recreation and the renderer Quit control; it reports shortcuts as not tested and login registration as unsupported.
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

## Regression coverage

`bun run test:unit` runs the controller, service, adapter and backend-work regressions; `bun test tests/regressions` runs only the dedicated adapter and backend-work files.

- Lifecycle cancellation makes Stop and Quit cancel pending hostname validation; queued refresh, watcher and service work cannot persist or reopen after cancellation.
- Malformed initialize returns 400 while the endpoint remains mounted and usable.
- The global 16-resource cap includes retained modern children across endpoints, alone or mixed with legacy sessions and their asynchronous DELETE cleanup.
- The shared 16-call backend-work bound spans sessions and endpoints, retains work until a reply, protocol cancellation or confirmed cleanup, and releases only the affected call.
- Duplicate in-flight IDs, one-element batch duplicates, within-batch duplicates and concurrent duplicates are refused before SDK dispatch; late replies cannot release work that reused an ID.
- A completed modern response releases its protocol work reservation on the terminal reply; its backend-resource lease remains until that child cleanup is confirmed.
- Malformed legacy replies retain their work, capacity refusals settle session state, and upstream continuation and credential isolation remain covered.

All regressions remain included in the default unit command.
Current results, native evidence and remaining limits are recorded in the [implementation-plan verification record](../IMPLEMENTATION-PLAN.md#verification-and-completion).
