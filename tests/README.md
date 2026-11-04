# Test layers

Run in order:

1. `bun run test:e2e`: Playwright and installed Google Chrome exercise the real React App through a test-only authenticated loopback bridge to AppService, controller, config store and synthetic stdio/HTTP MCP servers.
2. `bun run test:components`: Vitest, React Testing Library and jsdom exercise App rendering, typed form validation, modal cancel/focus restoration, polling/CAS drafts, repair, token controls, Logs filtering/clear/error states and dismissible operation banners with explicit AppClient doubles.
3. `bun run test:unit` (also `bun run test`): Bun exercises core libraries and injected native-service/login/lifecycle boundaries, including the blocking adapter regressions.

`*.e2e.ts` and `*.component.tsx` are deliberately outside Bun's test filename patterns, and Playwright and Vitest use explicit include patterns.
`bun scripts/check-ui.ts` builds the synthetic UI harness, captures desktop/narrow screenshots under `tests/ui/artifacts`, and checks keyboard focus and horizontal overflow; the current Updates screenshots are retained under `.cache/auto-update-0.3.1/acceptance-direct/ui/`.
Neither unit nor component commands launch a browser or Electrobun.
All fixtures are synthetic; no Bear, Apple account or actual login registration is used.
The login double is injected below AppService through MacLoginManager's native interface.

## Current audit remediation

A2-A6 and prerequisite A12 are locally verified and independently source-reviewed.
The default suite includes the shared command owner, confirmed backend-process cleanup, pinned batch cancellation, compiled build identity, guarded startup cancellation, and crash-residue tests.
The original user-facing audit cases remain explicit supplements:

```sh
bun test tests/audit/a1-login-lifetime.test.ts tests/audit/a12-bounded-inspection.test.ts tests/audit/gates.test.ts
bun test tests/audit/pending -t 'A[23456]:'
```

A7-A11 and A13 remain outside this source scope and have intentionally failing reproductions.
Do not use an unfiltered `bun test` run as the green-suite command.
Final checks passed with 504 unit/integration tests, 54 component tests, 20 browser tests, four isolated development-native scenarios, five pinned SDK helper tests, and eight private-hook tests.
Evidence is under `.cache/src-audit-a2-a6/20261104T085208Z/`.
The development bundle is `build/a2-a6-accepted/dev-macos-arm64/MCP Gateway-dev.app`.
Its compiled identity and generated/copied resource match, including the final rollback-race correction.
These checks do not constitute signed packaged replacement acceptance.
Earlier signed `0.3.1` evidence below predates this remediation and does not certify the changed source.

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
It also runs the updater boundary, strict `updates.json`, scheduler/coordinator, sanitized update RPC and normal-quit/restart-to-update lifecycle tests.
These cover default-on checks/downloads, single-flight scheduling, invalid preference suppression, stable-version gating, failed cleanup/handoff retry, draft configuration locking and unsupported-platform behavior.
Those tests use synthetic bundles and injected command boundaries.
Final signed project-local evidence is under `.cache/auto-update-0.3.1/final-acceptance/`.
Earlier sibling evidence directories contain intermediate builds and do not certify the final source.
Local acceptance is not a hosted CI substitute.
Component tests cover the Updates settings view, automation toggle, available/error/progress states, draft-discard confirmation, restart locking, menu-to-Settings signaling, focus, and window recreation.
The synthetic UI visual check covers desktop/narrow update states and keyboard restart-confirmation cancellation; the 20 real-service browser tests protect existing gateway behavior, not native updater replacement.

`release-inventory.test.ts` rejects changed launcher/signature bytes, modes, types, symlink targets, missing entries and extra files even when metadata and payload match.
`release-dmg.test.ts` covers settled cleanup, late attach after cancellation, exact mount identity, forced-detach restrictions and unknown cleanup ownership.
Read-only checks of the retained DMG exercise success, verification failure and cancellation without generating a new release.
`update-acceptance.test.ts` requires exactly one completed initial and target startup, a functional renderer RPC response, expected isolated roots, an exact confirmed transaction, checked renderer confirmation, old-backend exit and unchanged configuration.
Malformed, truncated, extra and duplicate startup records fail rather than being filtered out.
Acceptance also requires one attempt-bound backend-absence observation immediately before apply; it neither waits for nor kills the backend.
The live-backend negative control remains rejected even after that process exits before final collection.

The private source hooks at `.cache/auto-update-0.3.1/tests/prepare-fixture-apps.ts` and `product-update-flow.ts` are checked separately with `acceptance-hooks.test.ts`; CI does not import ignored cache files.
They patch copied source trees with exact-match anchors, fix isolated home/data/temp roots before SDK imports, write markers outside the signed bundle, and await a private renderer RPC confirmation receipt before forwarding the real restart request.
Both generated source variants typecheck; the final signed/notarized/stapled private pair passed five product scenarios.
These cover successful replacement, manifest HTTP 503, interruption after an on-disk partial download, injected cleanup failure with explicit retry, and six-second delayed renderer readiness.
Failure assertions require the intended fault, unchanged complete app inventory and configuration, no handoff, no remaining transaction and checked shutdown.
Eight private-hook tests cover exact source patches, process/helper cleanup, fault prerequisites, transaction absence, destination refusal and the pinned RPC deadline.
A product-flow run retains its directory and refuses reuse until its resources and evidence have been inspected.
The two-second duplicate-startup observation window does not prove that no later restart can occur.

`tests/native/updater-sdk-limits.native.ts` adds opt-in native coverage beyond the SDK doubles and system-zstd unit tests.
Run it on macOS arm64 with an existing signed payload inside this project; the following path is the retained payload used for local acceptance:

```sh
MCP_GATEWAY_SDK_LIMIT_APP="$PWD/.cache/signed-payload-2nUyUK/MCP Gateway.app" \
  bun test ./tests/native/updater-sdk-limits.native.ts
```

The suite verifies the app signature and identifier, checks the pinned Electrobun 2.0.5 source digest, and copies its signed Bun, zig-zstd and native libraries into a private fixture directory.
The production worker loads the unchanged SDK without an injected UpdaterSdk.
Only fixed-feed manifest/artifact fetches are routed to loopback; SDK streaming writes and native decompression are unchanged.
Seven cases cover Content-Length and chunked oversized downloads with same-payload success controls, exact-limit decompression, and one-block-over-limit rejection with a larger-limit control.
Assertions check received HTTP headers, observed download bytes, exact output digests/prepared records, no ready state after refusal, process-group exit, staging cleanup and configuration preservation.
Two unchanged-SDK root cases seed modern and legacy current-hash TARs plus an unobserved native result, then compare the entire rejected legacy directory after scheduled callbacks can run.
The admitted worker leaves it byte-identical without feed requests; an intentionally unsafe getter control produces the observed-result marker and demonstrates the regression's sensitivity.
Six main-adapter cases exercise observed/no-result completion, cancellation, metadata mismatch, same-version refusal and resolver errors under a real transaction lease.
They use synthetic prepared records and copied signed runtime binaries without calling apply or launching an application.
The pinned SDK's first reconciliation callback is drained under ownership only after proving that prepared and running versions differ; no general asynchronous SDK join is claimed.

The explicit command fails rather than silently skipping missing prerequisites.
Its `.native.ts` suffix keeps it outside the default Bun test discovery and CI unit command.
It prints the retained evidence path and removes owned temporary resources only after confirmed process cleanup.
This uses small 64 KiB limits and synthetic HTTP traffic, not physical disk exhaustion, live GitHub delivery or application replacement.
Independent source closure and regenerated signed packaged acceptance passed for the final local `0.3.1` build.
The separate native failure matrix exercises the final bundled helper with signed small applications, including literal ENOSPC on an isolated 8 MiB image and verified manual restoration.
Those helper cases do not establish full-size physical-host exhaustion or every product recovery UI path.

R1-R16 regressions additionally cover different-process transaction retirement, abandoned owner recovery before/after worker grant, surviving descendants, raw ustar path limits, implicit directory admission, preference ancestor symlinks, exactly-once restart dispatch, real candidate ownership through retry and moving-latest refusal, returned SDK settlement state and lost restart acknowledgements.
Transaction/guard/boundary/handoff tests require macOS and are gated separately from portable coordinator/service policy tests.
The portable-import regression compiles the connected graph with a throwing native-acquisition seam and retains the actual boundary so tree shaking cannot conceal eager loading; an eager-load negative control was checked locally.
This is not native Linux execution.
Verification-command cancellation requests termination promptly but waits for actual close; an unconfirmed started child retains operation ownership and keeps Quit pending.
Its deterministic delayed-close fixture and actual spawned-child tests cover both preflight stages and join cleanup before removing owned test trees.
Direct follow-up regressions cover exact payload/overhead totals, unreadable budget roots, queued duplicate failure without implicit retry, persistent unarmed-restoration failure, stale action responses after fresh polling, and gateway startup with inaccessible updater storage.
The direct corrections initially received focused self-review after the user stopped delegation.
The later authorized final review found and closed cleanup-parent admission, deferred-startup and worker-settlement defects, with regression tests for each.
Current evidence is under `.cache/auto-update-0.3.1/final-acceptance/`; the earlier remediation directory remains historical evidence.

- Lifecycle cancellation makes Stop and Quit cancel pending hostname validation; queued refresh, watcher and service work cannot persist or reopen after cancellation.
- Malformed initialize returns 400 while the endpoint remains mounted and usable.
- The global 16-resource cap includes retained modern children across endpoints, alone or mixed with legacy sessions and their asynchronous DELETE cleanup.
- The shared 16-call backend-work bound spans sessions and endpoints, retains work until a reply, protocol cancellation or confirmed cleanup, and releases only the affected call.
- Duplicate in-flight IDs, one-element batch duplicates, within-batch duplicates and concurrent duplicates are refused before SDK dispatch; late replies cannot release work that reused an ID.
- A completed modern response releases its protocol work reservation on the terminal reply; its backend-resource lease remains until that child cleanup is confirmed.
- Malformed legacy replies retain their work, capacity refusals settle session state, and upstream continuation and credential isolation remain covered.

Core, main, and dedicated regression suites are included in the default unit command.
Audit reproductions and native helper acceptance retain the explicit commands above.
Current results and limits are recorded in [A2-A6 and A12 source completion](../IMPLEMENTATION-PLAN.md#a2-a6-and-a12-source-completion).
The earlier signed acceptance and F1-F5 records remain historical.
