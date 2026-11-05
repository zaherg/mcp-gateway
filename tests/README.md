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

`bun test tests/core/backend-output.test.ts tests/regressions/backend-output.test.ts` checks backend output limits through the shared readers and authenticated loopback gateway.
The matrix covers modern stdio, SSE, and JSON; exact limits, oversized complete and unfinished messages; and streams whose total exceeds the per-event limit.
Reader checks cover split UTF-8 and CR/LF framing, metadata/comment fields, deceptive content-type parameters, cancellation, cleanup failures, and backpressure.
These tests use synthetic output and do not attempt process memory exhaustion.

## Updater documentation validation

The 2026-11-05 run validates Electrobun `2.0.5`, not the newer `2.0.6` recipe/streaming contract.
Current results are in [the validation record](../IMPLEMENTATION-PLAN.md#validation-results-2026-11-05), with the full matrix under `.cache/updater-documentation-validation/20261105T052930Z/`.
The audit checkpoints below are historical snapshots, not the current source's acceptance status.

`tests/native/updater-sdk-contract.native.ts` adds unchanged-SDK patch, fallback, metadata, status-history, veto, cancellation, and failure cases.
The maintained [operator guide](native/update-acceptance/README.md#sdk-contract-and-helper-checks) documents its signed-input prerequisites and the native-helper and rendered-UI checks.
The helper matrix includes automatic rollback after a post-swap integration failure, separate manual restoration, and an explicitly authorized 8 MiB ENOSPC image.
These tests do not upgrade the SDK or publish a release.

Source checks pass, but the required signed `late-start` product flow failed twice after reaching its six-second renderer delay.
The original HTTP-503 fixture failed twice; a fixture with finer failure-stage reporting then passed three runs without changing product behavior, timeouts, or assertions.
Those failures remain recorded; neither the exact cause nor a product-versus-fixture attribution is established.
Private failure evidence now records the initial app inventory/configuration digests and the last attempted driver stage.

## Current audit remediation

A2-A6 and prerequisite A12 are locally verified and independently source-reviewed.
The default suite includes the shared command owner, confirmed backend-process cleanup, pinned batch cancellation, compiled build identity, guarded startup cancellation, and crash-residue tests.
The original user-facing audit cases remain explicit supplements:

```sh
bun test tests/audit/a1-login-lifetime.test.ts tests/audit/a12-bounded-inspection.test.ts
bun test tests/audit/pending -t 'A[23456]:'
```

Source and packaged acceptance statuses are tracked individually in `IMPLEMENTATION-PLAN.md`; the audit directory retains its original names after corrections.
Do not use an unfiltered `bun test` run as the green-suite command.
The A2-A6/A12 source checks passed with 504 unit/integration tests, 54 component tests, 20 browser tests, four isolated development-native scenarios, five pinned SDK helper tests, and eight private-hook tests.
Evidence is under `.cache/src-audit-a2-a6/20261104T085208Z/`.
The development bundle is `build/a2-a6-accepted/dev-macos-arm64/MCP Gateway-dev.app`.
Its compiled identity and generated/copied resource match, including the final rollback-race correction.
These checks do not constitute signed packaged replacement acceptance.
Earlier signed `0.3.1` evidence below predates this remediation and does not certify the changed source.

### Direct-review boundary corrections

The later direct review reopened source closure for native signal provenance and executable access.
The corrections have local verification and focused self-review only; no Kimi, subagents, workflows, or new independent review were used.
Current acceptance and evidence are recorded in [the current ledger](../IMPLEMENTATION-PLAN.md#current-acceptance-criteria) and `.cache/review-boundary-fixes/20261104T184453Z/`.

Two explicit macOS suites require project-local inputs and fail if prerequisites are missing:

```sh
MCP_GATEWAY_NATIVE_BUNDLE="$PWD/.cache/review-boundary-fixes/20261104T184453Z/development-final/dev-macos-arm64/MCP Gateway-dev.app" \
  bun test ./tests/native/native-quit.native.ts
MCP_GATEWAY_SIGNED_PAYLOAD="$PWD/.cache/src-audit-a2-a6/20261104T104310Z/packaged-acceptance/extracted-payload/MCP Gateway.app" \
  bun test ./tests/native/updater-executability.native.ts
```

The native Quit suite copies the supplied development bundle and adds exact-match private hooks to main-process source; production gate/lifecycle code, SDK and renderer remain real.
It creates an unsaved server draft through WKWebView, verifies Cocoa Cmd+Q opens the discard prompt without cleanup, and sends actual SIGTERM/SIGINT to the runtime with a live synthetic MCP session.
Two cases block the renderer and require an unanswered RPC before signalling.
All four cases require native signal intent, exactly one cleanup, no extra renderer decision, backend absence and unchanged saved bytes.
`MCP_GATEWAY_TEST_IGNORE_SIGNAL=1` is a test-only negative control that disables the gate's intent read and causes the dirty SIGTERM case to time out.
The pinned SDK's second SIGINT remains a forced process-group kill and is not used as a graceful-cleanup test.

The executable suite copies a retained signed payload, changes each required executable to 0600, verifies codesign still passes and file bytes remain identical, then requires both candidate and recovery verification to refuse it.
Restored-permission controls pass full verification.
Archive admission rejects a signed payload's 0600 launcher, while the restored archive extracts with exact modes and passes verification.
These six checks do not sign, launch, install or replace the signed input.
The default suite also covers the shared pinned layout, owner-execute archive policy, and AppService preflight refusal with a live gateway and unchanged saved configuration.

### Combined-source review checkpoint

The earlier independent combined-source review of A7-A11/A13 and connected ownership/lifecycle behavior reported no remaining findings.
That blanket conclusion is superseded by the direct-review corrections above.
Evidence is under `.cache/src-audit-combined-review/20261104T173332Z/` and [the source-closure record](../IMPLEMENTATION-PLAN.md#independent-combined-source-closure).
One suspected A13 cancellation race was withdrawn after pinned-source tracing and 40 natural runtime cases; no production correction was needed.
The final unit suite passes 591 tests with 4,704 assertions; 62 components, 22 browser tests, 32 audit tests, five SDK helper tests, eight private-hook tests and four development-native scenarios passed on unchanged production bytes in the same run.
Type checking, lint and scoped LSP diagnostics pass.
Signed packaged acceptance on this source remains separately gated.

### A7-A11 source verification

At this checkpoint A7-A11 were implemented, locally verified and independently source-reviewed; the later native-signal finding and direct correction are recorded above.
New signed packaged acceptance remains pending.
The final local run passed 589 unit/integration tests with 4,695 assertions, 62 components, 22 browser tests, 32 audit tests, type checking, lint and scoped LSP diagnostics.
A separately rooted development build passed fresh, synthetic MCP, JSONC and SIGTERM native smoke scenarios.
Five unchanged-SDK helper tests and eight private acceptance-hook tests also passed.
Evidence is under `.cache/src-audit-a7-a11/20261104T163458Z/`.

`updater-verify.test.ts` covers generic and architecture-specific plist requirements, host versions, every detected Mach-O runtime/helper, malformed evidence, unavailable commands and cancellation.
Boundary regressions repeat authenticated compatibility checks at preparation, restart preflight and handoff; an AppService test preserves a running listener and saved bytes after refusal.
Retained signed-bundle admission uses native metadata tools, while an unchanged 277,858,816-byte release TAR verifies archive compatibility without installing it.
`interactive-quit.test.ts`, renderer tests and native-event audit fixtures separate delivery acknowledgement from discard consent, cover unavailable/lost acknowledgement and preserve signal/SDK paths.
Desktop and narrow browser tests inspect nested confirmation, Escape, focus, retained dialog values and unchanged saved configuration.
`terminal-order.component.tsx` feeds real lifecycle and service attempts through the renderer after two failed Quits.
Discovery tests cover matching IDs, notification-first SSE, invalid UTF-8, timeout and cancellation; archive numeric tests preserve exact refusal codes and valid output bytes.
The earlier A11 boundary fixture failure is corrected by using a valid file path, without changing the expected size refusal.

```sh
bun test tests/main/updater-verify.test.ts tests/main/updater-boundary.test.ts
bun test tests/main/interactive-quit.test.ts tests/main/lifecycle.test.ts
bun test tests/core/discovery.test.ts tests/main/updater-archive-numbers.test.ts
bun test tests/audit/a9-attempt-numbering.test.ts tests/audit/pending
```

These earlier checks received focused self-review, followed by the historical combined-source review above.
They did not establish the native signal path: the audit fixture manually invokes JavaScript listeners.
The later native Quit suite above verifies actual signals with dirty and blocked WKWebView windows.
New signed incompatible-candidate and malformed-archive replacement fixtures require separate authorization.

### Session protocol and reserved control admission removed

The pre-2026-07-28 session protocol and its reserved control admission (A13's 28 ordinary plus 4 reserved HTTP slots and 224/16 rate split) have been removed.
The gateway now serves only the stateless 2026-07-28 protocol and refuses session clients and GET/DELETE with 400/405.
The historical A13 record remains under `.cache/src-audit-a13/20261104T155056Z/`.

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

The maintained two-version builder, driver, helper settlement, and tests are under `tests/native/update-acceptance/`.
Their source checks run in `bun run test:unit` and the existing CI unit step; three macOS-specific cases are skipped elsewhere.
They patch copied source trees with exact-match anchors, fix isolated home/data/temp roots before SDK imports, write markers outside the signed bundle, and await a private renderer RPC confirmation receipt before forwarding the real restart request.
Both generated source variants typecheck.
The source tests do not sign apps or perform replacement.
[Packaged acceptance instructions](native/update-acceptance/README.md) document fresh-checkout prerequisites, private build/run paths, signing gates, and the opt-in driver commands.
Generated artifacts and evidence remain ignored; the old cache source copies are historical and are not imported by the maintained flow.

Earlier signed/notarized/stapled private-pair evidence covers successful replacement, manifest HTTP 503, interruption after an on-disk partial download, injected cleanup failure with explicit retry, and six-second delayed renderer readiness.
It does not certify subsequent production changes or the relocated driver through a new packaged run.
Failure assertions require the intended fault, unchanged complete app inventory and configuration, no handoff, no remaining transaction and checked shutdown.
The maintained hook tests cover exact source patches, process/helper cleanup, fault prerequisites, transaction absence, destination and symlink refusal, and the pinned RPC deadline.
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
- Session-protocol POSTs return 400 while the endpoint remains mounted and usable; GET/DELETE are refused with 405.
- The global 16-resource cap includes retained modern children across endpoints.
- The shared 16-call backend-work bound spans endpoints, retains work until a reply, protocol cancellation or confirmed cleanup, and releases only the affected call.
- Duplicate in-flight IDs are refused before SDK dispatch; late replies cannot release work that reused an ID.
- A completed modern response releases its protocol work reservation on the terminal reply; its backend-resource lease remains until that child cleanup is confirmed.
- Capacity refusals settle request state, and upstream continuation and credential isolation remain covered.

Core, main, and dedicated regression suites are included in the default unit command.
Audit reproductions and native helper acceptance retain the explicit commands above.
Current results and limits are recorded in [A2-A6 and A12 source completion](../IMPLEMENTATION-PLAN.md#a2-a6-and-a12-source-completion).
The earlier signed acceptance and F1-F5 records remain historical.
