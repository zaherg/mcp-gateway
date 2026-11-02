# MCP Gateway implementation

## Review remediation plan

Status: F1-F7 completed and locally verified on 2026-11-02; the final V1 combined-review gate remains pending.
This section covers the seven findings from the 2026-11-02 source review; task numbers match the finding numbers.
The first implementation request authorized F1, F3, and F2; the subsequent request authorized F4-F7 with local verification and bounded independent review.
Actual login registration changes, release rebuilds, installation, publishing, and Git operations remain outside these requests.
Earlier release permissions and completed milestones below do not authorize new shipping work.

### Priorities and order

P1 means the first implementation wave; P2 means the required second wave, not optional work.
Importance describes the affected user workflow, while priority determines execution order.
No P0 emergency is established: the review did not demonstrate credential exposure, irreversible data loss, or an authentication bypass.

| Task | Fix | Priority | Importance | Reason |
| --- | --- | --- | --- | --- |
| F1 | Normalize upstream header names | P1 | Medium | Header casing alone breaks otherwise valid HTTP connections. |
| F3 | Parse complete SSE discovery events | P1 | High | Valid discovery responses select the wrong protocol and block modern requests. |
| F2 | Distinguish normal session cleanup from failure | P1 | High | Ordinary disconnects create persistent false backend alarms. |
| F4 | Accept the canonical Host header on port 80 | P2 | Medium | A supported listener configuration rejects standard clients. |
| F5 | Restrict self-proxy rejection to the actual listener | P2 | Medium | Distinct local services cannot share a port despite separate bind addresses. |
| F6 | Recover login registration state and retries | P2 | High | Native approval and failed unregister operations do not recover correctly. |
| F7 | Preserve open editor actions after invalid external changes | P2 | High | Users cannot apply entered values while the authoritative file is invalid. |
| V1 | Combined verification and independent review | Required completion gate | High | Individual fixes must preserve transport, security, persistence, and UI contracts together. |

Recommended order: **F1, F3, F2, F4, F5, F6, F7, V1**.
F1 and F3 share upstream discovery coverage; run them together before the transport regressions.
F6 and F7 overlap `src/mainview/App.tsx`; complete F6 before F7 rather than using concurrent writers.
The remaining tasks have no hard implementation dependency; V1 depends on all seven fixes.
Use one implementation writer in this checkout and bounded read-only reviewers for independent checks.

### F1: Normalize upstream header names

Source: `src/core/config.ts`; consumers include `src/core/discovery.ts` and the HTTP adapter.
Tests: `tests/core/config.test.ts`, `tests/core/discovery.test.ts`, and `tests/core/ingress.test.ts`, reusing the synthetic HTTP fixture.

- [x] Add a failing regression where configured `Content-Type` reaches a strict synthetic upstream as a duplicate value, alongside the working lowercase case.
- [x] Normalize validated, expanded runtime header keys to lowercase in the shared configuration boundary, retaining case-insensitive duplicate detection and prohibited-header checks.
- [x] Preserve source-document spelling, comments, environment references, and no-op bytes; keep equivalent header casing equivalent in endpoint fingerprints.
- [x] Verify mixed-case and lowercase configurations both complete modern discovery and a tool request, with unchanged upstream credential isolation and legacy HTTP behavior.

Done when both cases send one valid transport-owned header value, and equivalent casing no longer changes runtime behavior.

### F3: Parse complete SSE discovery events

Source: `src/core/discovery.ts`.
Tests: `tests/core/discovery.test.ts`, with an HTTP integration case in `tests/core/ingress.test.ts` or the existing regression suite.

- [x] Add failing discovery and modern-request cases using the same valid JSON response split across multiple server-sent event (SSE) `data:` lines.
- [x] Decode complete event boundaries and join data fields before JSON parsing, reusing an existing suitable parser if available without adding a dependency or editing vendor code.
- [x] Cover single-line and multiline events, split network chunks, line endings, comments, and malformed or truncated responses; preserve ordinary JSON responses.
- [x] Retain the current byte cap, timeout, cancellation, cache/coalescing behavior, and legacy fallback for genuinely unsupported responses.

Done when equivalent JSON and SSE responses select the same protocol, a modern tool request succeeds, and cancellation cannot start a late backend.

### F2: Distinguish normal session cleanup from failure

Source: `src/core/adapter.ts` and its pinned Supergateway lifecycle integration.
Tests: `tests/core/ingress.test.ts`, `tests/core/logs.test.ts`, and `tests/regressions/adapter.test.ts`.

- [x] Add a failing regression that initializes a synthetic stdio session, terminates it normally, waits for child cleanup, and checks that no new server or operational error was created.
- [x] Track intentional closure at the session or child lifecycle boundary rather than treating the whole mount as closing or filtering every SIGTERM message.
- [x] Keep the full diagnostic entry in local logs; preserve unexpected-exit reporting, sanitized summaries, and failures belonging to sibling sessions.
- [x] Verify normal DELETE, cancellation cleanup, endpoint stop, unexpected child exit, sibling isolation, and shared resource admission through actual cleanup.

Done when ordinary cleanup produces no false failure, while an unexpected synthetic exit still reports a new failure and all owned resources are released.

### F4: Accept the canonical Host header on port 80

Source: `src/core/ingress.ts`.
Tests: `tests/core/ingress.test.ts`.

- [x] Add a failing boundary regression for an authenticated request whose configured port is 80 and whose Host header omits `:80`.
- [x] Accept only the configured host's canonical default-port form and explicit `:80` equivalent; retain exact host and port checks for nondefault ports.
- [x] Test both accepted forms and reject missing or unrelated hosts, incorrect ports, malformed authorities, invalid Origin, and invalid credentials.
- [x] Exercise the existing dispatch boundary without binding occupied port 80 or changing Herd, firewall, router, or LAN settings.

Done when canonical port-80 requests pass the Host check and all existing negative authentication, Origin, route, and subnet cases remain rejected.

### F5: Restrict self-proxy rejection to the actual listener

Source: `src/core/network.ts`; callers in `src/core/controller.ts` and `src/core/ingress.ts`.
Tests: `tests/core/network.test.ts` and relevant controller validation cases.

- [x] Add a failing case for a gateway bound to an assigned private address and a distinct loopback upstream using the same port.
- [x] Compare resolved, normalized destinations against the actual configured listener address and port instead of rejecting every local address on that port.
- [x] Preserve refusal of true self-targets, wildcard destinations, matching DNS aliases, IPv4-mapped equivalents, and unresolved same-port destinations that cannot be checked safely.
- [x] Verify that distinct bound addresses are accepted without weakening assigned-interface, private-network, startup, or save validation; use synthetic resolution/boundary tests rather than exposing a real LAN listener.

Done when separate local sockets are allowed and every tested route back to the gateway itself remains refused.

### F6: Recover login registration state and retries

Source: `src/main/login.ts`, `src/main/service.ts`, and the existing save/recovery controls in `src/mainview/App.tsx`.
Tests: `tests/main/login.test.ts`, `tests/main/service.test.ts`, `tests/components/App.component.tsx`, and the synthetic browser bridge where needed.

- [x] Add failing cases for pending approval becoming enabled and for retrying a refused unregister operation while approval remains pending.
- [x] Reconcile the requested operation with actual native registration state, distinguishing not registered from pending approval; clear obsolete errors only when the requested state is satisfied.
- [x] Let an explicit same-value save retry an unresolved registration operation, and make that retry reachable through the existing save controls even when the configuration is clean.
- [x] Verify that polling never changes native registration, stale or invalid saves never invoke native mutation, errors remain dismissible by occurrence, and startup preferences remain separate from gateway exposure.

Done when approval clears the stale warning and a retry performs the previously refused operation without requiring an unrelated configuration edit.
Use native test doubles only; actual login registration and a real login cycle require separate authorization.

### F7: Preserve open editor actions after invalid external changes

Source: `src/mainview/App.tsx`.
Tests: `tests/components/App.component.tsx` and `tests/e2e/app.e2e.ts`.

- [x] Add the failing browser case: open Add server, enter values, introduce invalid external configuration, await polling, then apply the dialog.
- [x] Apply an already-open editor to its retained original document rather than the live error-suppressed form configuration, preserving entered fields and the original revision.
- [x] Cover Edit server and check the delete confirmation for the same invalidation path; retain cancel/focus behavior and explicit recovery feedback.
- [x] Verify that the resulting draft stays available, stale saves are refused, invalid external files still stop exposure, and initially invalid configuration does not enable structured editing.

Done when external invalidation cannot turn Apply into a silent no-op or overwrite newer disk contents.

### V1: Combined verification and independent review

The review baseline passed 7 browser tests, 21 component tests, 87 unit/integration tests, typecheck, and lint.
The seven additional reproductions were separate review probes; F1-F7 now have permanent regression coverage.
Those baseline results do not verify any future fixes.
Both implementation waves passed bounded independent review; the final combined seven-fix review remains open.
The completed verification items below use the final F4-F7 source and do not cover subsequent Linux work.

- [x] For each task, establish that its new regression fails on the reviewed behavior, make the smallest complete correction, then pass the focused tests before proceeding.
- [x] Run `bun run test:e2e`, `bun run test:components`, and `bun run test:unit` in that order, followed by `bun run typecheck`, `bun run lint`, and applicable LSP diagnostics.
- [x] Inspect rendered UI for F6/F7, including keyboard access, focus, clean-state retry, error dismissal, stale drafts, and narrow layout.
- [x] Build into a separate project-local development output directory and run the existing isolated native smoke against that build, keeping real login registration disabled and using synthetic MCP backends only.
- [ ] Obtain a bounded independent review of the changed lifecycle, Host/self-proxy boundaries, header handling, registration retries, editor recovery, and regression assertions; resolve findings before marking the plan complete.
- [x] Record results and remaining limits in this section, stop owned test processes, and confirm that no user app, real Bear data, existing release artifact, or external configuration was changed.

Completion requires all seven task acceptance checks, passing combined verification, and resolved independent-review findings or an explicitly disclosed verification blocker.
No dependency upgrade, general refactor, persistence-format change, native-platform port, or release rebuild is part of this plan.
Actual login changes, second-device LAN testing, signing/notarization, installation, publishing, and Git operations remain outside this authorization.

### F1/F3/F2 verification, 2026-11-02

- Each fix has a recorded failing regression followed by passing focused checks.
- F1 normalizes runtime headers without changing source text or casing-equivalent fingerprints; strict synthetic upstreams accept both header spellings for modern discovery, tool calls, and legacy sessions.
- F3 reuses the installed, locked SSE parser without a dependency or vendor change, accepts complete multiline events and empty priming events, and rejects truncated events.
- F3 checks cover UTF-8 bytes split across network writes, LF/CRLF/CR endings, comments, BOM, the exact 64 KiB boundary, the existing 10-second timeout, coalescing, caching, and cancellation before headers or during the response body.
- F2 tracks transport closure per session before child shutdown; full exit logs remain local, unexpected same-signal exits still report failures, and ordinary cleanup preserves concurrent sibling failure occurrences.
- Independent source review found an empty-SSE-event regression; added unit and HTTP integration tests reproduced it before correction, and the closure review found no remaining issues.
- Final verification passed in order: 7 Playwright E2E tests, 21 Vitest component tests, and 111 Bun unit/integration tests with 1,369 assertions, followed by typecheck, lint across 70 files, and zero LSP diagnostics across nine changed files.
- An initial cancellation-test response-body rejection was corrected before recording the F2 reproduction; final reruns showed no observed flakiness.
- The separate development build at `.cache/remediation-f1-f3-f2/build/dev-macos-arm64/MCP Gateway-dev.app` passed fresh, JSON stdio, and JSONC stdio native smoke scenarios, including rendered RPC, Cmd+W state retention, and Cmd+Q cleanup with an open synthetic session.
- Synthetic desktop/mobile Logs screenshots were inspected; no UI source changes were needed for these tasks.
- Evidence and before/after source copies are under `.cache/remediation-f1-f3-f2/`; native reports are under `.cache/native-check/dev-1793614796712/`.
- Owned test processes exited; checksums confirmed existing release artifacts and assets unchanged, and `package.json` and `bun.lock` remained byte-identical.
- The independent reviewer inspected source and captured results without rerunning tests; the parent executed the verification commands.
- Real login registration, Bear data, second-device LAN access, signed-release runtime, installation, and publishing were not exercised; existing user applications and external configuration were not changed.
- A separate Linux-platform session held overlapping build/test writes during these checks; these results cover the verified first-wave source, not subsequent platform edits.

### F4-F7 verification, 2026-11-02

- Each task has a recorded failing regression followed by passing focused checks.
- F4 tests canonical and explicit port-80 Host values through the existing HTTP dispatch boundary on an ephemeral loopback socket; port 80 was never bound.
- F5 uses literal and injected DNS answers for distinct sockets, mixed answers, mapped self-targets, wildcards, and failed or empty resolution.
- The private-address case exercises the validation boundary without opening a LAN listener; separate controller tests retain assigned-interface checks, reject invalid saves without changing bytes, and refuse recursive auto-start.
- F6 tracks the requested native state, shares one retry predicate between the service and renderer, and exposes clean-state retries through existing save controls.
- Native doubles verify approval recovery, pending unregister retries, stable error occurrences, unchanged bytes/revisions on retry, and no native mutations from polling or invalid/stale saves.
- F7 retains Add/Edit/Delete drafts and their original revisions after invalid external changes, including JSONC comments; browser saves refuse stale overwrites and leave invalid disk bytes unchanged.
- A further browser regression reproduced lost focus after invalidation removed or disabled the opener; dialogs now fall back to the existing configuration recovery button.
- Two bounded read-only reviewers found no correctness, security, regression-coverage, or simplification issues in F4/F5 and F6/F7.
- A subsequent feedback-only clarification distinguishes an editable retained draft from paused structured editing; it received focused self-review and a component assertion before the final rerun.
- Final verification passed in order: 12 Playwright E2E tests, 27 Vitest component tests, 117 Bun unit/integration tests with 1,468 assertions, typecheck, lint across 70 files, and zero LSP diagnostics across 14 changed files.
- Synthetic desktop/mobile login-retry and editor-recovery screenshots were inspected; browser checks cover keyboard retry, dismissal, focus, cancellation, and narrow layout.
- The separate development build at `.cache/remediation-f4-f7/build/dev-macos-arm64/MCP Gateway-dev.app` passed fresh, JSON stdio, and JSONC stdio smoke scenarios, including rendered RPC, Cmd+W retention, and Cmd+Q cleanup with an open synthetic session.
- Evidence, source baselines, test logs, screenshots, and review reports are retained under `.cache/remediation-f4-f7/`; final native reports are under `.cache/native-check/dev-1793617392109/`.
- Test development corrected parser-level missing-Host expectations, the existing invalid-start error classification, test typing, and a Bun asymmetric-matcher side effect; final reruns showed no observed flakiness.
- Owned test processes exited; checksums confirmed release artifacts, assets, `package.json`, and `bun.lock` unchanged.
- The Linux session paused shared source writes and build/test runs during this work; its separate plan updates were preserved.
- Actual login registration, a real login cycle, physical input, second-device LAN access, signed-release runtime, installation, and publishing were not exercised.
- No real Bear data, user application, external configuration, dependency version, or Git state was changed.
- V1 still requires its final combined seven-fix independent review; the implementation reviews here cover F4-F7 only.

## Agreed scope

- Build a macOS menu-bar desktop app using Electrobun, Bun, React, TypeScript, Effect, and Tailwind CSS v4.
- Electrobun explicitly replaces the ambiguous Electron wording in the implementation request.
- Use one editable `mcp.json` or `mcp.jsonc` as the authoritative configuration.
- The user selected strict JSON for `.json`; only `.jsonc` accepts comments.
- Discover the sole existing file at app startup, keep `mcp.json` as the empty-directory default, and refuse ambiguous two-file setups.
- Preserve JSONC comments during structured UI edits and exact bytes for no-op saves; changing the filename requires reopening the app.
- Expose independently routed Streamable HTTP endpoints at `/mcp/<server-name>` on one LAN-only listener.
- Support local stdio MCP processes and existing Streamable HTTP MCP upstreams.
- Bear is an ordinary configured server using `/Applications/Bear.app/Contents/MacOS/bearcli mcp-server`.
- Bear may expose its full tool set and all accessible notes, as requested.
- Keep the gateway running when the settings window closes, with menu-bar access and explicit graceful Quit.
- Provide functional add, edit, and delete controls for both server types, gateway address/port/token editing, and gateway start/stop with visible status.
- Disable page-edge and dialog elastic overscroll without disabling normal scrolling.
- Bind native Cmd+Q explicitly to the same graceful cleanup path as Quit.
- Bind native Cmd+W to close only the current window while preserving the menu-bar app, gateway, and in-memory log history.
- Implement actual macOS login registration, launching the app in the background.
- Keep login startup separate from the explicit “Start gateway when the app opens” setting.
- Build, sign with the existing Developer ID Application identity, notarize using environment credentials, and verify the resulting macOS arm64 release.
- No Git operations, installation into `/Applications`, public exposure, router changes, or modification of the existing Pi/Herd configuration are authorized.

## Architecture and security

- Working product name: MCP Gateway.
- React manages the local UI through validated Electrobun RPC, not an HTTP administration endpoint.
- Effect provides schema validation, typed operational failures, serialized configuration operations, and scoped lifecycle cleanup.
- Reuse the pinned Supergateway 4.2.1 protocol implementation through a version-coupled adapter around exported lifecycle primitives.
- The original top-level mount hides retained-child ownership; independent review and reproductions required moving admission to actual resource acquisition and cleanup, without changing protocol implementations.
- The adapter is an explicitly version-coupled boundary and must have protocol, isolation, and shutdown integration tests before release.
- One mount per server preserves session isolation and permits independent stop/restart and configuration reconciliation.
- A shared HTTP ingress validates the configured local interface, client subnet, Host, Origin, method, route, and bearer token before dispatch.
- Never accept wildcard/public listener addresses, unauthenticated MCP requests, network configuration changes, shell command strings, or upstream credentials supplied by incoming clients.
- HTTP is unencrypted, including on the LAN; the UI and documentation must disclose this without describing the service as public.
- Authentication credentials belong in an owner-only configuration file or environment references; status summaries, LAN error responses, build output, and release evidence remain sanitized.
- On 2026-11-02 the user explicitly requested full local backend diagnostic text, including emitted values, instead of structured/redacted-only logs.
- That permission applies only to the app-local Logs view: use bounded in-memory retention and local native RPC, with no automatic log files, console mirroring, or LAN log endpoint.
- Warn that local diagnostic entries can contain credentials or note data; never use real private data in tests, screenshots, coding-tool output, or review reports.
- Configuration writes require validation, stale-write detection, an exclusive lock, atomic replacement, and file/directory synchronization.
- Invalid external configuration changes stop exposure and produce a visible error rather than silently accepting broken policy.
- A new app starts with the gateway stopped; explicit user action is required to expose endpoints.
- Closing the UI must not stop the gateway; explicit Quit stops network ingress and owned backend processes/sessions.
- Optional login startup is controlled locally and is never enabled automatically by the build.

## Logs and notification update

- Add a Logs navigation item immediately below Settings.
- Capture all upstream logger levels and stderr diagnostic text with timestamps, server identity, source/channel, and occurrence IDs.
- Keep small sanitized status summaries separate from full diagnostic records; provide meaningful failure summaries such as OS error codes, HTTP status, and process exit information when available.
- Treat stderr as a stream, not proof of failure; normal startup chatter must not create a false BackendFailure banner.
- Use a separate bounded rolling log buffer and incremental validated native RPC instead of resending raw logs with every status snapshot.
- Provide level/server/text filtering, explicit clear, empty/error states, visible retention/truncation limits, and plain-text rendering.
- Make success and error notification banners dismissible without changing configuration, backend failure state, or log history.
- Stable issue IDs must prevent dismissed occurrences from reappearing on polling while allowing a new occurrence of the same error to appear.
- Keep dismissal state within the current renderer; no cross-restart acknowledgement persistence was requested.
- Extend E2E, Vitest component, and unit/integration tests, then inspect rendered output and obtain independent review.
- Extend the isolated Cocoa key-event smoke probe to verify Cmd+W window closure/reopening without stopping the gateway, separately from Cmd+Q cleanup.
- Deliver the new feature as local version 0.2.0, using a new build output folder and leaving running older apps untouched.
- Implementation worker `efaa1eea-4387-4f0b-9d0e-600436b657d8` timed out after 30 minutes near final verification.
- Partial source/test state was captured in `.cache/checkpoints/logs-timeout-efaa1eea.tar.gz`; its SHA-256 is `5dfd33e7621517e2a0bd17c1516a42f170c5708a37af3f4bdf72e3c771b64670`.
- The worker recorded 6 E2E, 19 component, and 79 unit tests passing before final notification-ID edits; those edits were not yet fully verified at that checkpoint.
- Parent TypeScript and lint checks pass on the captured final source.
- The orphaned project-local headless test browser and its helpers were stopped; no user browser or native app was terminated.
- The bounded same-worker retry completed without source changes: 7 E2E, 20 Vitest component, and 79 unit/integration tests passed, with passing types and lint.
- Synthetic desktop Logs and mobile notification screenshots were inspected; the final worker reported no remaining synthetic test processes.
- Parent development-native smoke passed all three scenarios, including Cmd+W preserving gateway/log history and Cmd+Q cleaning an open synthetic session.
- Independent review identified a dismissal race after a snapshot-free action and a Logs referral for an unrecorded local exception; both were reproduced with failing regressions.
- Acknowledgements now retire only on authoritative snapshot updates, and unexpected local boundary exceptions are recorded in the private log buffer without changing sanitized status/failure state.
- The final repaired suite passes 7 E2E, 21 component tests across 2 files, and 79 unit/integration tests across 15 files with 1,193 assertions, plus types and lint.
- Independent closure review accepted both fixes with no remaining findings; reviewers inspected current source/tests without a Git baseline and did not independently rerun the tests.
- Rebuilt development-native and final signed-native checks passed fresh, JSON stdio, and JSONC stdio scenarios, including Cmd+W state retention and Cmd+Q cleanup with a live synthetic session.
- The 0.2.0 runtime, wrapper, and DMG were Developer ID signed, accepted by Apple, and stapled; separate signature, ticket, Gatekeeper, embedded-payload identity, and DMG checksum checks passed.
- The final wrapper is `build/release-0.2.0/stable-macos-arm64/MCP Gateway.app`; the package, release report, and signed payload bundle version all report 0.2.0.
- Current deliverable: `artifacts/macos-arm64-MCPGateway.dmg`, 49,061,773 bytes, SHA-256 `e74fb03a01a2b167e8e7bab6fce15402921f529f1ec8519a7244f446f94efbcd`.
- Final applicable LSP diagnostics reported zero diagnostics across ten changed files.
- `artifacts/native-verification.json` was regenerated from the three completed reports under `.cache/native-check/stable-1793608675864`, retaining metadata and source-report hashes only.
- `artifacts/SHA256SUMS` was regenerated from the five current artifact files and verified; the DMG/archive hashes also match `artifacts/release-verification.json`.
- `RELEASE.md` and `tests/README.md` record the current acceptance results, coverage, and verification limits; no implementation, rebuild, notarization submission, or full test rerun was needed for documentation closeout.
- Owned native smoke processes exited and their synthetic children stopped; the identified orphan test browser was stopped without terminating user applications.
- Physical input, actual login registration, second-device LAN access, sleep/wake, minimum-OS runtime behavior, installer-wrapper execution, and power-loss durability remain unverified.
- No real Bear mutations, Git operations, installation into `/Applications`, or changes to existing Pi/Herd/network configuration were performed.

## Linux and Windows source builds

- On 2026-11-02 the user requested `build:linux` and `build:windows` for source users without a Mac, initially selecting runnable builds including portability and secure-storage adaptations.
- After the native-verification discussion, the user narrowed the request to “I just want the commands” and declined Linux/Windows testing.
- That later decision supersedes the full runtime-port plan: add experimental packaging commands only, without provisioning native runners, adding CI, or redesigning platform security.
- Build natively on the requested operating system and architecture; Electrobun does not cross-compile these applications.
- Keep the existing macOS arm64 development and signed-release commands compatible, and do not rebuild or replace the verified 0.2.0 macOS artifacts for this work.
- Linux and Windows source builds are unsigned and do not require Apple credentials or invoke Xcode, Swift, Keychain, or notarization tools.
- Use pinned Electrobun/Hutch host toolchains with project-local caches rather than macOS-only runtime overrides on other hosts.
- The read-only portability review identified remaining runtime blockers: unconditional macOS login-library loading, POSIX-only configuration protections, and unreliable Windows descendant cleanup in the upstream adapter dependencies.
- Leave runtime code and security checks unchanged under the narrowed command-only scope; README must distinguish packaging entry points from runnable platform support.
- Add host-routing and toolchain-environment regression coverage, then run local TypeScript/lint checks and focused self-review without claiming native builds were tested.
- Current verification host is macOS arm64; no Linux/Windows build, execution, GUI, or security-boundary verification is requested or claimed.
- The separate user request removed `build/` and `artifacts/` from the root `.gitignore` without changing their contents; `dist/` remains ignored.
- Command-only implementation is complete: `bun run build:linux` and `bun run build:windows` select unsigned stable packaging, require their matching host, and skip macOS native compilation and signing.
- Both commands use host-selected pinned SDK preparation; PNG package icons and conditional copying avoid macOS-only build inputs on Linux/Windows.
- Local TypeScript, Biome lint across 70 files, and applicable LSP checks across six changed files passed; eight routing/environment tests passed with 55 assertions.
- Both package commands were exercised on macOS and correctly refused the wrong host before toolchain preparation; no native Linux/Windows build was attempted.
- An initial environment-return typing error and formatter/import-order findings were corrected before those passing checks; the user's absolute Vite output path was preserved.
- Focused self-review found no remaining command-routing or credential-handling issues; runtime portability findings remain explicitly out of scope, not fixed or independently re-reviewed.
- No full application suite, UI build, macOS rebuild, signing, or notarization was rerun for this command-only change; existing release artifacts remain untouched.
- No remote infrastructure, native runner provisioning, installation, Git operations, dependency upgrades, or publishing is authorized.

## Linux runtime and native CI

Status: source implementation and available macOS checks completed; actual Linux execution remains unverified pending a hosted run.
The user requires Linux desktop runtime and native tests, superseding the historical Linux packaging-only scope above and the initial macOS-only CI choice.
Windows runtime support remains out of scope.

- Explicit desktop selection precedes login-library loading; Linux never loads the macOS dylib and reports native login registration/Cocoa probes as unavailable.
- Linux uses absolute XDG_CONFIG_HOME or ~/.config with an MCP Gateway child; the absolute data override and isolated-mode requirement remain enforced.
- macOS configuration location, login registration, Cmd+W close-only behavior, and graceful Cmd+Q remain unchanged.
- Linux close requests veto destruction and minimize the real native window; restoration preserves the gateway/logs and taskbar access without a tray host.
- A visible local Quit RPC validates empty input and acknowledges only the request; shared QuitCoordinator waits for cleanup before native exit.
- Independent review reproduced acknowledged Quit followed by delayed failure leaving the control disabled; centralized attempt-numbered lifecycle status now provides sanitized failure/retry feedback through a validated local status RPC, independently of gateway/native-login reads after partial cleanup, and restores a visible retry window even if the tray was already removed.
- Component, lifecycle, service-boundary, and browser regressions cover delayed failure, retry, stale prior-failure reads before/after acknowledgement, unrelated gateway errors, partial cleanup, and preserved native veto.
- Follow-up review reproduced actual controller/ingress timeout retries reusing rejected completion while raw cleanup remained outstanding; the authorized shutdown-only core changes retain stopped ingress, removed mounts, and raw cleanup completion across bounded waits, and never approve terminal unconfirmed rejection.
- Five controlled controller/ingress regressions cover repeated deadlines, immediate listener stop, eventual real cleanup, admission ownership, child cleanup, replacement blocking during stop/reconfiguration, and terminal refusal.
- A fresh renderer now permits authoritative failed-status Retry Quit without gateway snapshot data; component/browser tests preserve stale-attempt protection, dirty-draft confirmation, and honest completion-unknown feedback when status reads fail.
- Unavailable desktop metadata uses a neutral label; desktop/mobile unavailable-snapshot retry screenshots were captured and inspected.
- Only shutdown ownership/completion paths changed in controller/ingress and the adapter deadline helper; adapter protocol/diagnostic code, ingress request policy, controller configuration APIs, network/login policy, and closed fixture-identity code/tests remain byte-identical.
- Dirty Quit cancellation restores focus and preserves drafts; F1-F7 login-retry, retained-editor, transport, network, and Modal recovery invariants remain intact.
- Gateway autoStart remains available on Linux; unsupported login settings cannot hide its initial window, and the Bear preset is explicitly macOS-only.
- Native smoke requires real renderer RPC, fresh/JSON/JSONC selection, minimize/restore on Linux, actual destruction/recreation, live synthetic MCP calls across transitions, graceful Quit, and a separate SIGTERM scenario.
- Linux reports shortcuts as not tested; Electrobun 2.0.5 ApplicationMenu accelerators are stubs, not Ctrl-based shortcuts.
- Owned launcher sessions and uniquely marked detached fixtures receive bounded SIGTERM-first cleanup; forced cleanup cannot target unrelated app groups.
- A macOS zombie-only-group EPERM was reproduced and corrected using positive same-UID zombie evidence or ESRCH, never permission-error suppression; forced-cleanup and unrelated-process-survival assertions pass.
- Independent review also reproduced sleeping-to-stopped fixture cleanup refusal; identity now compares stable PID/group/start/command fields and uses ps stat only to classify zombies, with deterministic stopped-child cleanup coverage and directly owned finally cleanup.
- Both review findings failed behavioral tests while TypeScript still passed before fixes; retained fail-first logs distinguish reproductions from compile failures.
- TypeScript, Biome, actionlint, ShellCheck/bash syntax, 15 Playwright E2E, 33 component, and 136 Bun tests/1,658 assertions passed locally.
- A separately rooted macOS development build passed fresh, JSON, JSONC, and SIGTERM native scenarios with live synthetic sessions and Cocoa probes.
- Synthetic Linux-control desktop/mobile screenshots were captured and inspected; actual WebKitGTK rendering, desktop taskbar interaction, XWayland, tray hosting, and installed Linux packaging remain unverified.
- Earlier review evidence remains under `.cache/linux-runtime/review-fixes/`; latest fail-first logs, shutdown-only diff, protected-byte checks, screenshots, and separately rooted native build/data/reports are under `.cache/linux-runtime/shutdown-fixes/`.
- The native smoke harness accepts an optional project-local evidence-root argument and refuses roots outside the project; its default path and acceptance behavior are unchanged.
- No actual login registration, Bear access, installation, signing, publishing, Git operations, or workflow dispatch occurred.
- Focused self-review does not replace the required independent review, and the separate top-level V1 combined-review gate is unchanged.

## GitHub Actions tests

- `.github/workflows/test.yml` now targets Ubuntu 24.04 x64 with pinned Node 26.13.0, Bun 1.4.4, and the existing action SHAs.
- Push/PR/manual triggers, read-only permissions, persist-credentials:false, concurrency cancellation, and the 30-minute timeout are preserved.
- All existing check layers remain, followed by `MCP_GATEWAY_BUILD_ROOT=build/linux-native-ci bun run build` and mandatory native smoke of the development launcher, never a stable installer wrapper.
- Distro GTK3/WebKitGTK/AppIndicator/librsvg packages and Xvfb/Xauth/DBus/Openbox/x11-utils are installed explicitly.
- The headless helper isolates home/XDG/temp, bus, display, and window-manager resources under the project and cleans owned processes; it does not disable the WebKit sandbox.
- Playwright uses installed Chrome through `channel: chrome`, without a macOS executable path.
- Workflow/static checks and available macOS equivalents pass; actual Linux dependency resolution, native execution, and GitHub-hosted behavior remain pending.
- No remote infrastructure, workflow dispatch, push, signing, release publication, or Windows runtime work was performed.

## Verified environment and constraints

- Project was empty at inspection.
- Host architecture is arm64; Bun 1.4.4, Node 26.13.0, notarytool, stapler, and a Developer ID Application identity are available.
- Required Apple account, team, and app-password environment variables are present; their values must never be printed or committed.
- Electrobun 2.0.5 is paired with Hutch 0.28.2 and supports a project-local `HUTCH_HOME`.
- Build caches, temporary files, SDKs, generated files, test configuration, and release artifacts must stay under this project.
- The current LAN address is DHCP-assigned `192.168.68.130/22`; port 8765 had no observed listener.
- Herd uses loopback ports 80 and 443 and remains unchanged.
- Actual reachability from a second device, router forwarding policy, sleep availability, and future DHCP leases are not established by same-host checks.

## Execution stages

1. Pin dependencies and prepare the project-local Electrobun SDK and build tools.
2. Implement configuration, gateway security, protocol adaptation, resource lifecycle, and regression tests.
3. Implement the React dashboard, server editing, configuration editor, client configuration copying, and native menu-bar/window lifecycle.
4. Add the user-requested test layers in order: end-to-end tests, React component tests using Vitest, then remaining library/unit coverage.
   Browser E2E uses the real application service/controller through an isolated test-only loopback bridge; native RPC/window behavior is verified separately against the built app.
   No test administration transport is packaged or exposed by the production app.
5. Run unit, integration, type, lint, production-build, and rendered UI checks; fix introduced defects.
6. Perform an independent security/correctness review and resolve applicable findings.
7. Produce the arm64 app and distribution artifact; sign, notarize, staple, and independently verify signatures and Gatekeeper acceptance.
8. Record exact verification results and remaining limits without claiming unperformed checks.

## Acceptance checks

- Local stdio and remote HTTP backends initialize, list tools, and execute synthetic test tools at the exact requested routes.
- Concurrent clients and endpoints do not share protocol responses or sessions.
- Missing/wrong authentication, invalid Host/Origin, disallowed network clients, malformed routes, and oversized requests are rejected.
- Remote clients cannot modify configuration or select an arbitrary upstream/command.
- Configuration round trips preserve intended fields and reject malformed, truncated, stale, and symlinked inputs.
- Changed endpoints restart independently; stopped or removed endpoints are unreachable.
- Restart, disconnect, cancellation, and Quit do not leave owned child processes running.
- UI keyboard interaction, labels, focus/error states, responsiveness, and rendered layout are checked.
- No real Bear notes are created, edited, or deleted during verification; synthetic fixtures cover writes.
- Signed/notarized delivery requires actual successful Apple submission and stapling, not only build settings.

## Implementation history through 0.1.0

These entries preserve earlier checkpoints, not current pending work.
The 0.2.0 results are recorded in the Logs and notification update above and in `RELEASE.md`.

- Requirements and available signing prerequisites inspected.
- Official framework and gateway release sources inspected.
- Dependencies and the project-local Electrobun SDK are prepared.
- Backend worker `874971c2-8f44-4099-a542-9783f0e024aa` timed out after 30 minutes.
- Its 17 partial source/test files were inspected and preserved in `.cache/checkpoints/core-timeout-874971c2.tar.gz` before a bounded same-lane retry.
- The worker log records 29 passing tests before subsequent incomplete controller watch-hardening edits; those final edits are not verified.
- No leftover test processes were observed at continuation.
- The generated devkit configuration's removed TypeScript 7 `baseUrl` option was bypassed with explicit application aliases; generated files remain unchanged.
- Backend recovery completed: 30 core tests passed.
- React UI and native shell are implemented; the combined 36-test suite, strict TypeScript, lint, and six-screenshot browser verification passed.
- The development bundle passed real renderer RPC, window close/reopen, initial stopped state, packaged synthetic MCP, and graceful shutdown checks.
- Native/UI/build independent source review found no issues; actual login registration remains deliberately untested.
- Backend independent review found two release blockers, both reproduced: malformed initialization returns 400 and retires the endpoint; 17 sequential modern continuation requests retain 17 children despite the claimed 16-resource cap.
- Correcting global admission requires expanding the version-coupled adapter beyond the top-level mount, which exposes no ownership hooks, while preserving Supergateway's actual protocol implementations and existing modern/legacy behavior.
- The user requested additional E2E, Vitest React component, and unit tests in that order before release work proceeds.
- Both backend release blockers are corrected with shared resource leases; malformed requests preserve sibling sessions, and continuations reuse admitted resources at capacity.
- Obsolete endpoint-retirement and fixed-grace expectations were replaced with stronger per-child cleanup, sibling-isolation, and fixture-gated cleanup checks.
- Independent test review identified two weak assertions; both now check exact error or protocol-result values, and pending cleanup is established deterministically.
- All 2 E2E tests, 10 Vitest component tests, and 53 unit/integration/regression tests pass, with passing TypeScript, lint, rebuilt development bundle, and native smoke.
- Final independent adapter review closed both blockers and a subsequently reproduced discovery-shutdown issue.
- Cancellable, bounded upstream discovery now has seven additional tests; 60 unit/integration/regression tests, 2 E2E tests, and 10 Vitest tests pass.
- The pre-JSONC macOS arm64 app, wrapper, and DMG were Developer ID signed, accepted by Apple notarization, stapled, and separately accepted by Gatekeeper.
- Its signed payload passed isolated native smoke checks; the installer wrapper itself was not launched because it replaces itself on first run.
- The user then requested `.json`/`.jsonc` support and selected JSONC-only comments.
- JSON/JSONC selection and comment-preserving UI edits are implemented, with 5 E2E, 12 Vitest, and 70 unit/integration tests passing.
- The user also requested page-edge overscroll suppression and Cmd+Q; CSS boundaries and explicit native menu routing are implemented.
- Native startup exposed a bundled JSONC-parser relative-import failure; externalizing the pinned runtime module corrected it without modifying vendor files.
- Development-native checks verified JSONC selection, actual WKWebView policy, and Cocoa shortcut routing; an app-local key-event probe now checks Cmd+Q while a synthetic session remains open.
- A non-test older stable launcher remains running and is not terminated or overwritten; the supported buildFolder override will place the final stable build under `build/release-final`.
- Final independent review found no remaining issues across JSONC persistence/editing, overscroll, native Cmd+Q routing/probe isolation, and packaging.
- The final release was rebuilt under `build/release-final`, Developer ID signed, accepted by Apple for runtime/wrapper/DMG, and stapled.
- Separate signature, ticket, Gatekeeper, embedded-payload identity, and DMG checksum checks passed.
- The final signed runtime passed fresh, JSON, and JSONC scenarios, including actual WKWebView policy and app-local Cocoa Cmd+Q shutdown with an open synthetic MCP session.
- All 5 E2E, 12 Vitest component, and 70 unit/integration/regression tests pass; TypeScript, lint, and applicable LSP checks pass.
- The 0.1.0 DMG had SHA-256 `78a0e537aa5521ae470958b24eee488ac9d51a1389f7a0c8402795e87d271a87`; 0.2.0 has superseded it at `artifacts/macos-arm64-MCPGateway.dmg`.
- Release evidence, acceptance receipts, operational details, and remaining verification limits are recorded in `RELEASE.md` and `artifacts/*verification.json`.
- No test processes remain; the older non-test app stays running and untouched.
- Physical input gestures, actual login registration, second-device LAN access, installer-wrapper execution, minimum-OS runtime behavior, and power-loss durability remain unverified.
- No Git operations, installation into `/Applications`, real Bear mutations, or existing Pi/Herd/network configuration changes were performed.
