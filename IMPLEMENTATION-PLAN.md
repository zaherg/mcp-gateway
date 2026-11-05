# MCP Gateway audit issues

Status: issues 1-7 are fixed and locally verified.
This document replaces the previous implementation plan and historical records at the user's request.
Recording these findings does not authorize work on the remaining issues, signing, installation, or publication.

## Audit scope

Audit baseline: commit `b2cab16ddefc8baebee1aacf1164304ae37a77a6`, package version `0.3.1`.
Assumed load: one desktop app serving a few trusted LAN clients within the documented connection limits.
The audit traced configuration writes, request handling, backend ownership, desktop lifecycle, and updater preparation and recovery.

## Must fix

### 1. A rejected update locks a still-running app

Paths: `src/main/lifecycle.ts:L87-101`, `src/main/service.ts:L250-258`.

- **What this is:** Update preflight checks the downloaded app before stopping the gateway.
- **Problem:** A preflight refusal sets the Quit state to `failed`, even though cleanup never started.
  Reproduction confirmed that the gateway stayed running but subsequent configuration saves were refused.
- **Fix:** Return to `idle` when cancelling an update reservation before shutdown starts.
  Add a connected regression that saves configuration after preflight refusal.
- **If we skip it:** A rejected update forces users to quit and reopen an otherwise working app.

Resolution: preflight cancellation leaves Quit idle, while retry reservations preserve any earlier shutdown failure.
Connected AppService regressions cover incompatible-host and non-executable-candidate refusals, save and read back configuration while the gateway stays running, then complete an ordinary Quit without applying the update.
Lifecycle regressions cover stale cancellation, fresh retries, shutdown admission, pending cleanup, and prior Quit/update cleanup failures.

Local checks passed: 602 unit/integration tests (4,792 assertions), 62 component tests, 22 browser tests, type checking, lint, scoped LSP diagnostics, and the UI build.
Focused self-review found no remaining issue in this change.
Native packaged execution and signed replacement were not rerun for this source-only fix.
Evidence: `.cache/issue-1-preflight/`.

### 2. Recovery cleanup can delete the copy named by its own record

Paths: `src/main/updater/recovery.ts:L197-210`, `src/main/updater/storage.ts:L128-134`.

- **What this is:** The updater retains a verified previous app and publishes its location in `latest.json`.
- **Problem:** The record is renamed into place before directory synchronization finishes.
  Injecting a synchronization failure left `latest.json` pointing to the new recovery bundle after the error handler deleted that bundle.
- **Fix:** Distinguish failure before publication from failure afterward.
  Preserve a bundle whenever the published record might reference it, and test this failure point.
- **If we skip it:** A storage error can leave a broken recovery record.
  The older copy survived the reproduction, but its location was no longer recorded as latest.

Resolution: the synchronous record writer notifies recovery immediately after rename, before validation and directory synchronization.
Cleanup preserves the referenced new bundle if a later step fails; pruning the older copy still requires a successful write.
Failures before publication still trigger cleanup of the unreferenced new bundle.
Record-write errors still fail the operation; publication with uncertain durability is not reported as success.

Regressions cover first and replacement records, file-sync and rename refusals, post-publication validation and directory-sync failures, successful pruning, and a later retry through updater preparation.
Local checks passed: 615 unit/integration tests (4,868 assertions), type checking, lint, and scoped LSP diagnostics.
Recovery and storage tests also passed three consecutive reruns.
Focused self-review found no remaining issue in this change.
UI suites, desktop builds, and native/signed replacement checks were not rerun for this filesystem-only change; power-loss durability remains untested.
Evidence: `.cache/issue-2-recovery/`.

### 3. Malformed upstream text becomes a successful, altered result

Path: `src/core/adapter.ts:L504-525`.

- **What this is:** This code decodes streaming responses from remote MCP servers.
- **Problem:** Its UTF-8 decoder silently replaces invalid bytes.
  A synthetic response containing byte `0xFF` returned HTTP 200 with replacement character `U+FFFD` in the result, rather than a protocol error.
- **Fix:** Use a fatal UTF-8 decoder, matching the existing request and discovery readers.
  Test invalid bytes and valid characters split across chunks.
- **If we skip it:** Corrupted tool output can reach clients as an apparently successful result.

Resolution: ordinary upstream SSE now uses fatal UTF-8 decoding, matching the existing discovery reader.
Malformed bytes produce the existing sanitized JSON-RPC error instead of an altered success result.
Regressions cover an invalid byte, a malformed continuation split across writes, truncated UTF-8 at EOF, and exact valid two-, three-, and four-byte characters, including a correctly encoded replacement character.
The framing matrix retains LF, CRLF, CR, byte-at-a-time writes, and open-stream coverage; repeated failures verify resource release, authentication, and sanitized public diagnostics.
The JSON response path and buffer-limit behavior are unchanged.

Local checks passed: 618 unit/integration tests (4,925 assertions), 91 targeted protocol/lifecycle tests, type checking, lint, and scoped LSP diagnostics.
The 15-test framing selection also passed two consecutive reruns.
Focused self-review found no remaining issue in this change.
UI suites, desktop builds, and native/signed replacement checks were not rerun for this protocol-only change.
Evidence: `.cache/issue-3-utf8/`.

## Should fix

### 4. A failed preference save can change the next launch's setting

Paths: `src/main/updater/preferences.ts:L65-83`, `src/main/updater/storage.ts:L232-237`.

- **What this is:** The Updates switch stores whether background checks and downloads are enabled.
- **Problem:** Every write failure reports that the old setting remains active.
  An injected post-rename synchronization failure returned `false`, while the saved file and a fresh read both returned `true`.
- **Fix:** Read back the published value or return an explicit publication outcome.
  Report uncertain durability instead of claiming that nothing changed.
- **If we skip it:** The displayed setting and the behavior after restarting can disagree.

Resolution: the asynchronous writer signals publication immediately after rename, while later validation and synchronization errors still reject the write.
Preference saves safely read back the published value after such failures and report uncertain durability instead of retaining the old value or claiming success.
Failures before publication still preserve the previous effective setting.
Unverifiable published preferences disable background updates; scheduling follows the adopted value without hiding an available, prepared, or retryable update.

Regressions cover both toggle directions, first writes, pre-publication failures, post-publication validation and synchronization failures, strict readback checks, retries, scheduling, and renderer warnings without success notices.
Local checks passed: 642 unit/integration tests (5,093 assertions), 64 component tests, 22 browser tests, type checking, lint, and scoped LSP diagnostics.
Focused self-review caught and corrected the update-phase preservation case; no remaining issue was found in this change.
Desktop builds and native/signed replacement were not rerun for this preference-storage fix; power-loss durability remains untested.
Evidence: `.cache/issue-4-preferences/`.

### 5. Backend response buffers have no size limit

Paths: `src/core/adapter.ts:L504-525`, `node_modules/supergateway/dist/lib/lineSplitter.js:L15-25`.

- **What this is:** The gateway collects complete streaming events or stdout lines before parsing them.
- **Problem:** Neither path bounds an unfinished message.
  A real loopback gateway accepted one 16 MiB streaming event; the 30-second deadline does not limit memory consumption.
- **Fix:** Bound backend message buffers and JSON response bodies.
  Use the installed event parser's `maxBufferSize` option and add oversized, multi-chunk regressions without editing installed dependency files.
- **If we skip it:** A faulty backend can exhaust the desktop app's memory despite the connection limits.
  Actual memory exhaustion was not tested.

Resolution: a shared 4 MiB limit bounds backend stdout lines, HTTP JSON/error bodies, and SSE event fields before accumulation or delivery.
SSE framing bytes are excluded from its event budget; metadata and comments count, and the budget resets between events rather than limiting the whole session.
The modern event parser also receives `maxBufferSize` and an explicit completed-data check.
Project-owned readers use the pinned spawning, SDK, backpressure, and lifecycle seams without editing installed dependencies.
Oversized output produces a sanitized protocol failure and retains resource ownership until the existing cleanup completes.

Regressions cover legacy and modern stdio/SSE/JSON, exact boundaries, multi-chunk and unfinished overflows, larger aggregate SSE streams, UTF-8 byte counting, framing, metadata, content-type parameters, cancellation, and cleanup.
Local checks passed: 679 unit/integration tests (5,309 assertions), 64 component tests, 22 browser tests, type checking, lint, scoped LSP diagnostics, a development build, and four isolated macOS native smoke scenarios.
Focused self-review caught and corrected bypasses involving content-type parameters and HTTP error bodies labeled as SSE; no remaining issue was found in this change.
Actual memory exhaustion, prolonged load, native Linux/Windows, and signed-release execution were not tested.
Evidence: `.cache/issue-5-buffers/`.

### 6. Critical update acceptance tools are absent from a fresh checkout

Path: `tests/README.md:L180-186`.

- **What this is:** Private fixture builders and a driver test replacement between two packaged app versions.
- **Problem:** Those tools and their tests live only under ignored `.cache/auto-update-0.3.1/tests/`.
  A fresh checkout cannot reproduce that acceptance path.
- **Fix:** Track the reusable builders, driver, and tests under `tests/native/`.
  Keep signing credentials, generated bundles, and run evidence ignored.
- **If we skip it:** Future updater changes can pass the maintained suites without exercising actual replacement.

Resolution: the builder, product-flow driver, helper-settlement utility, and hook tests are maintained under `tests/native/update-acceptance/`.
The default unit command includes their source checks; three macOS-specific cases are gated elsewhere, and packaged execution remains opt-in.
The operator guide documents ordinary fresh-checkout prerequisites and separately authorized signing/replacement commands.
Generated source, apps, and evidence use ignored `.cache/update-acceptance/`; historical cache programs are not dependencies of the maintained flow.
Shared path checks refuse traversal and symlinked directories before source writes or process inspection.

A checkout-isolated projection without the old acceptance cache generated both private versions using ordinary prepared toolchain inputs.
Full-project type checking exposed the old builder's missing test-source dependencies; copying `tests` alongside the other source directories corrected it, with a maintained regression.
Both complete generated projects typecheck, and retrying preparation refuses existing destinations without changing their files.
The generated entrypoint hook bytes remain identical to the previously tested hooks.

Local checks passed: 691 unit/integration tests (5,413 assertions), including 12 maintained acceptance-source tests, type checking, lint, and scoped LSP diagnostics.
Focused self-review found no remaining issue in this change.
No signed builds, notarization, packaged replacement, or publication were performed; source availability is fixed, but this is not new packaged acceptance.
Component/browser suites and desktop-app smoke were not rerun for this test-tooling change; Linux/Windows execution and hosted CI remain unverified.
Evidence: `.cache/issue-6-acceptance/`.

## Nice to have

### 7. Remove unused updater helpers

Paths: `src/main/updater/archive.ts:L486-501`, `src/main/updater/recovery.ts:L234-238`, `src/main/updater/preferences.ts:L5`.

- **What this is:** Four exported helpers and one constant remain without callers.
- **Problem:** Repository-wide reference checks found only their declarations, including searches through tests and configuration.
- **Fix:** Delete `listArchiveTopLevel`, `isSafePreparedHash`, `readDirectoryNames`, `retainedRecoveryEntries`, and `_MAX_PREFERENCE_BYTES`, plus unused imports.
- **If we skip it:** Maintenance retains unused code and a preference-size constant that enforces nothing.

Resolution: removed the four unused exports, `_MAX_PREFERENCE_BYTES`, and the archive imports used only by the deleted helpers.
The change removes 28 production-code lines net and changes no dependencies.
Maintained source, tests, scripts, and configuration contain no remaining references to the deleted names.
Active validation, recovery, and preference behavior is unchanged.

Local checks passed: 146 targeted updater tests (691 assertions), type checking, lint, and scoped LSP diagnostics.
Focused self-review found no remaining issue in this deletion.
The full unit suite, UI suites, desktop builds, and native/signed replacement were not rerun for this unused-code removal.
Evidence: `.cache/issue-7-unused/`.

## Verification and limits

The audit ran these checks successfully:

- 599 unit/integration tests with 4,749 assertions.
- 62 component tests.
- Type checking and lint.
- Shell syntax checking for `scripts/check-native-linux.sh`.
- Targeted reproductions with synthetic data and isolated project-local resources.

The passing suites do not establish that the findings are fixed.
The audit changed no source files, and its temporary resources were cleaned up.

Not checked: fresh browser/native UI runs, signed replacement, Linux/Windows execution, live GitHub delivery, prolonged load, physical disk exhaustion, or power loss.
Not every build/test helper or third-party implementation was read.

Issues 1-7 are locally fixed.
The documentation-validation plan below remains planned and unexecuted.

## Electrobun updater documentation validation plan

Status: planned, not executed.
This section defines validation of the automatic-update feature against Electrobun's documented contract; it does not mark the preceding audit issues resolved.
The request authorizes this plan only, not source changes, dependency upgrades, test execution, signing, application replacement, publication, or Git operations.

### Baseline and documentation

Planning inspection: 2026-11-05, HEAD `2445386d646e109e87a2539d2b4f0fc17e84e381`, app version `0.3.1`, with uncommitted work present.
Capture a new source snapshot when validation starts rather than treating this commit alone as the tested implementation.
The project pins Electrobun `2.0.5`; its toolchain uses Hutch `0.28.2` and Bun `1.4.4`.
The current documentation includes changes introduced in Electrobun `2.0.6`, including native streamed preparation, archive recipes, and v2 update manifests.
Passing the existing implementation's tests cannot establish conformance with those newer behaviors.

Primary sources, inspected on 2026-11-05:

- [Updater API](https://docs.electrobun.dev/electrobun/apis/updater/): API sequence, readiness, quit approval, replacement, metadata, storage, and status reporting.
- [Updates guide](https://docs.electrobun.dev/electrobun/guides/updates/): artifact hosting, GitHub Releases, patch chains, manifest compatibility, and migration.
- [Electrobun 2.0.5 release notes](https://docs.electrobun.dev/electrobun/guides/changelog/v2-0-5/): the installed release and paired toolchain.
- [Electrobun 2.0.6 release notes](https://docs.electrobun.dev/electrobun/guides/changelog/v2-0-6/): changed preparation, integrity metadata, HTTPS rules, and paired Hutch `0.29.0`.

Use the actual prepared SDK source at `.hutch/devkit/api/sdks/main/core/Updater.ts`, its projection metadata, and the verified devkit selected by `scripts/toolchain.ts` to resolve version-specific behavior.
The npm package is a bootstrap, so its version alone does not prove which runtime implementation was bundled.
Capture the documentation, retrieval dates, SDK digests, source hashes, commands, and sanitized results under `.cache/updater-documentation-validation/<run-id>/` during execution.
Keep reusable verification code in maintained test/script paths, not in that evidence directory.

### V1. Establish a version-aware contract matrix

- [ ] Freeze the source/dependency/toolchain baseline, including uncommitted files and the generated SDK projection, before running checks.
- [ ] Record each documented claim with its URL/section, applicable SDK version, implementation location, test case, evidence path, and outcome.
- [ ] Separate shared SDK contracts, application-specific policies, and requirements introduced in 2.0.6.
- [ ] Use outcomes `PASS`, `FAIL`, `BLOCKED`, `VERSION GAP`, and `NOT APPLICABLE`, with an explicit reason for the last three.
- [ ] Record default-on background checks/downloads, explicit Restart to Update, monotonic stable versions, publisher verification, and gateway cleanup as application policies rather than promises made by the SDK example.

Start with this mapping; the rows identify work to verify, not passing results:

| Documentation area | Implementation to trace | Existing verification to reuse |
| --- | --- | --- |
| Release host and generated artifacts | `electrobun.config.ts`, `scripts/toolchain.ts`, `src/main/updater/constants.ts`, `scripts/verify-release.ts` | Release inventory/DMG tests and packaged artifact verification |
| Local metadata, installed root, supported channel | `support.ts`, `worker.ts`, `apply.ts`, `executing-build.ts` under `src/main/updater/` | Support, worker, startup, build-identity, and real-SDK root tests |
| Check, download, readiness, and errors | `worker.ts`, `coordinator.ts`, `boundary.ts` under `src/main/updater/` | Worker, coordinator, candidate, and boundary tests |
| Full download, deltas, and storage | Pinned SDK `Updater.ts`; application `archive.ts`, `budget.ts`, `process.ts`, `candidate.ts` | Archive, budget, process tests and `tests/native/updater-sdk-limits.native.ts` |
| Quit approval and native handoff | `src/main/lifecycle.ts`, `src/main/service.ts`, updater `apply.ts`, `handoff.ts`, `transaction.ts` | Lifecycle, interactive-quit, apply/handoff tests and native Quit suite |
| Replacement, relaunch, and recovery | Updater `verify.ts`, `recovery.ts`, `transaction.ts`; `scripts/update-acceptance.ts` | Boundary/recovery tests and maintained two-version acceptance driver |
| Status and user controls | Updater `coordinator.ts`, `preferences.ts`; `src/mainview/App.tsx` | Component, browser, preference, and native renderer checks |

Exit condition: every relevant API section has a mapped check, and newer-version requirements remain visible instead of being silently omitted.

### V2. Verify configuration, metadata, and artifact delivery

- [ ] Compare `package.json`, `bun.lock`, prepared devkit metadata, build inputs, and packaged runtime identity for the selected validation build.
- [ ] Assert the production identity `dev.srvr.mcpgateway`, channel `stable`, target `macos/arm64`, and feed `https://github.com/zaherg/mcp-gateway/releases/latest/download` agree across configuration, manifest, installed `version.json`, and prepared candidate.
- [ ] Verify the 2.0.5 feed assets retain their generated names: `stable-macos-arm64-update.json` and `stable-macos-arm64-MCPGateway.app.tar.zst`.
- [ ] Verify the manifest's artifact reference, version, routing hash, platform, and architecture match the exact archive and signed runtime payload.
- [ ] Distinguish `macos-arm64-MCPGateway.dmg` and its installer wrapper from the runtime archive consumed by the updater; a DMG alone is not an update feed.
- [ ] Exercise missing/malformed metadata, incorrect identity/channel/architecture, missing archive, stale cached responses, and a moving latest release between manifest and artifact requests.
- [ ] Confirm a mismatched manifest/payload pair is refused without changing the installed app or publishing ready state.
- [ ] Check that packaged `dev` builds never offer updates, as documented, and that the app's narrower macOS arm64/stable support policy refuses unsupported builds without background requests.

Treat the release hash as a routing identifier, not publisher authentication.
Verify application signature, expected publisher, executable permissions, architecture, and minimum host requirements through the existing candidate verifier.
A generated artifact, local archive, and remotely served archive must have separately recorded byte digests.

### V3. Verify API sequencing and application policy

- [ ] Trace `getLocalInfo()` → `checkForUpdate()` → `downloadUpdate()` → `updateInfo()` → `applyUpdate()` through the production worker, safety boundary, coordinator, and service.
- [ ] Assert that `updateAvailable` permits preparation but does not mean ready, and that a resolved `downloadUpdate()` promise is insufficient without `updateReady` and an empty `error`.
- [ ] Exercise check/download failures that return status instead of throwing, plus thrown failures, and require a visible sanitized error with no apply call.
- [ ] Test identical hashes, higher stable versions, older versions, same-version/different-hash offers, prereleases, malformed versions, and stale prepared records.
- [ ] Preserve the application's higher-version requirement while recording that the pinned SDK itself uses hash inequality for availability.
- [ ] Verify default-on checks/downloads, persisted opt-out, explicit manual checks/downloads while opted out, single-flight behavior, startup reconciliation ordering, timer cancellation, and retry after failure.
- [ ] Prove no background task or ordinary Quit installs an update; only an explicit, accepted Restart to Update request can reach apply.
- [ ] Compare `getLocalInfo()`, convenience metadata getters, `channelBucketUrl()`, and `appDataFolder()` with the packaged metadata and SDK-resolved installed workspace in an isolated runtime.
- [ ] Confirm path admission and transaction ownership precede effectful SDK getters and status subscription, including the pinned reconciliation callbacks they schedule.
- [ ] Retain regressions for unsafe roots, symlinks, concurrent instances, cancellation, and a stale executing build after another process replaces the on-disk bundle.

Exit condition: each path reaches the expected public state, and failed or cancelled operations cannot publish readiness, mutate configuration unexpectedly, or release resources before cleanup is confirmed.

### V4. Exercise downloads, patch fallback, and storage with the pinned SDK

Use the unchanged SDK and its bundled native helpers through the production adapter, with synthetic manifests, isolated app copies, and a loopback feed.
SDK doubles establish application branching but do not establish download, patching, decompression, or native behavior.

- [ ] Cover a fresh full download, reuse of a matching prepared candidate, a valid single delta, and a multi-hop delta chain reaching the exact selected target.
- [ ] Record requested patch filenames and native-helper execution so a supposed delta test cannot pass by silently downloading the full archive.
- [ ] Cover missing current TAR, missing patch, corrupt patch, repeated/cyclic hash, interrupted chain, and full-download fallback failure.
- [ ] Verify patch-chain and fallback results have the expected payload bytes and target identity; preserve the installed bundle throughout preparation.
- [ ] Test manifest HTTP errors, offline/timeout, interrupted download, truncated/corrupt archive, content-length and chunked overflows, decompression limits, and cancellation during preparation.
- [ ] Exercise free-space refusal, file-write/sync errors, and literal ENOSPC only on an authorized bounded project-local test image, never by filling the host disk.
- [ ] Check complete app inventories, configuration/preference bytes, staging ownership, child-process settlement, and retry behavior after each refusal.
- [ ] Confirm gateway activity and renderer RPC remain responsive during preparation, including the pinned synchronous helper work isolated in the worker.

Record the 2.0.5 retained-TAR/prepared-record layout as the observed version contract.
Do not label it a recipe-based or fully streaming implementation, and do not extrapolate small-limit tests to full-size storage or power-loss durability.

### V5. Verify quit approval, replacement, relaunch, and recovery

- [ ] Call apply without a valid prepared update and verify no replacement occurs.
- [ ] Exercise an actual SDK `before-quit` veto and require no armed native apply plan/helper, while preserving valid prepared-candidate ownership for retry.
- [ ] Require explicit draft consent and successful preflight before shutdown, then close gateway/listener/backend resources before exactly one update handoff.
- [ ] Cover duplicate clicks, stale/lost acknowledgements, closed/reopened windows, delayed renderer readiness, cleanup refusal, and explicit retry.
- [ ] Retain issue 1 coverage: a failed preflight leaves a still-running app editable and permits ordinary Quit without applying the rejected candidate.
- [ ] Send actual SIGTERM/SIGINT to dirty and unresponsive native windows; verify ordinary cleanup without renderer consent or install-on-quit.
- [ ] Verify the native helper waits for the owned old process to exit before replacement and revalidates the candidate at handoff.
- [ ] Test tampered signatures, wrong publisher/identity, non-executable required files, incompatible host, changed prepared archive, read-only destination, and interrupted replacement through the relevant verifier/helper boundary.
- [ ] Distinguish automatic rollback attempted by the helper, successful restoration, and application-managed/manual recovery; record the complete inventory and recovery journal for each outcome.
- [ ] Retain issues 2 and 4 fault cases so post-publication failures cannot delete a referenced recovery copy or misreport the effective update preference.
- [ ] Require the target process to confirm the exact version/hash/build identity, complete startup, answer renderer RPC, and confirm its native transaction before declaring success.
- [ ] Require an attempt-bound observation of backend absence before handoff, unchanged synthetic configuration, and exactly one target startup within a recorded observation window.

The documented launch operation is not an application health check.
A helper exit, changed files, launch request, or externally started target process does not by itself prove automatic relaunch and healthy startup.
Preserve uncertain ownership and recovery evidence; do not delete them merely to reset a failed test.

### V6. Verify status reporting and user-visible behavior

- [ ] Observe the pinned `onStatusChange` events and `UpdateStatusEntry` fields, then map them to the application's checking, available, downloading, ready, restarting, and error states.
- [ ] Exercise `getStatusHistory()`, `clearStatusHistory()`, and `onStatusChange(null)` in isolated SDK tests without treating unused convenience APIs as missing product features.
- [ ] Verify error/readiness transitions and asynchronous callbacks cannot produce false success or stale ready state after cancellation, opt-out, failed preflight, or shutdown.
- [ ] Verify callbacks cannot mutate state after ownership ends, history remains available according to the pinned SDK contract until cleared, and neither exposes credentials/private diagnostics through renderer summaries or LAN endpoints.
- [ ] Inspect rendered desktop/narrow layouts, keyboard/focus behavior, discard confirmation, retry controls, and window reopening while an update is prepared.
- [ ] Ensure UI progress reflects evidence the pinned SDK actually supplies; do not invent byte percentages or assume newer native preparation emits per-patch progress.

### V7. Run reproducible source and packaged acceptance

First confirm issue 6's maintained helpers and dependencies are available from the source snapshot without historical `.cache` programs.
Use `tests/native/update-acceptance/{prepare-fixture-apps.ts,product-update-flow.ts,settle-product-helper.ts,acceptance-hooks.test.ts}` and its [operator guide](tests/native/update-acceptance/README.md).
The helper relocation was in progress during planning; its presence in a dirty working tree does not establish fresh-checkout reproducibility or packaged acceptance.

After validation execution is authorized, run the existing source checks from the repository root:

```sh
bun run typecheck
bun run lint
bun run test:e2e
bun run test:components
bun run test:unit
bun test tests/main/updater-*.test.ts tests/main/lifecycle.test.ts tests/main/interactive-quit.test.ts tests/main/update-acceptance.test.ts tests/main/build-identity.test.ts
bun test tests/native/update-acceptance
```

Run configured LSP diagnostics on changed validation code and add only missing contract cases alongside existing suites if test changes are authorized.
Do not modify installed SDK files or weaken existing assertions to obtain a passing result.

Run `tests/native/updater-sdk-limits.native.ts`, `tests/native/updater-executability.native.ts`, and `tests/native/native-quit.native.ts` using their documented project-local payload/bundle prerequisites.
Missing prerequisites are blocked checks, not passes or evidence that a feature is unsupported.
Development smoke is supplementary because the SDK disables update discovery on the `dev` channel.

Signed packaged acceptance requires separate authorization for signing/notarization, local app execution, and replacement of private copies.
Follow the maintained guide's isolated build/run roots and build a fresh private stable pair from the exact validated source, keeping production identity and security checks except for explicitly documented fixture routing/instrumentation.
Run `success`, `offline`, `interrupted`, `cleanup-failure`, and `late-start`, plus the missing contract cases identified in V1-V6.
Keep credentials out of commands, logs, fixtures, and reports; use synthetic MCP activity and never target an installed user app.
Record and settle owned processes, listeners, helpers, and mounts before cleanup.
Older signed bundles and earlier CLEAR reports do not certify a changed source snapshot.

### V8. Record newer-version gaps and verify the eventual release feed

The following require a separate SDK-upgrade decision before claiming conformity with the full current documentation:

- [ ] Compare the 2.0.6 native preparation API and record layout with application assumptions about `retained_tar_path`, frozen archives, process ownership, recovery, storage budgets, and helper executables.
- [ ] Validate paired Electrobun/Hutch versions and both manifest generations, including v2 TAR SHA-256/size checks and legacy fallback only on HTTP 404.
- [ ] Validate archive-recipe creation, exact reconstruction, verified old-TAR migration, missing/changed-source fallback, and original signed-byte preservation.
- [ ] Exercise streamed delta/full preparation and memory-allocation fallback with measured limits, rather than inheriting 2.0.5 resource claims.
- [ ] Test HTTPS base URLs without credentials/query/fragment, permitted loopback HTTP, HTTPS downgrade refusal, and same-origin restrictions on HTTP redirects.
- [ ] If an upgrade is approved, test both the old updater installing the bridge release and the upgraded updater installing a subsequent release, plus a fresh installation.

Do not upgrade dependencies, migrate storage, or change the feed merely to complete this plan.
Record unimplemented newer-version behavior as `VERSION GAP`; validation can conclude alignment with the pinned contract while explicitly withholding a full latest-documentation claim.

For release readiness, inspect the production GitHub feed read-only using isolated download storage:

- [ ] Verify the stable latest-release redirect and every required asset are anonymously reachable over HTTPS, preserving safe redirects and the SDK's cache-busting requests.
- [ ] Compare downloaded manifest/archive bytes with the exact accepted build, including publisher, version/hash, platform, architecture, and artifact names.
- [ ] Check that archive/patch assets become available before manifests advertise them, old hash-named patches remain reachable when promised, and missing patches return normal errors that permit fallback.
- [ ] Confirm `/releases/latest` is used only for stable releases and that prereleases cannot become the app's automatic feed.
- [ ] Identify releases without an updater or usable feed that require a manual bootstrap upgrade; do not promise automatic delivery to them.

Feed publication, tag changes, release uploads, and installation remain separate operations requiring explicit authorization.
If no accepted release is published, report live delivery as `BLOCKED` rather than substituting local-feed success.

### Completion criteria

- [ ] Every applicable contract row has a source citation, exact tested SDK/build identity, reproducible procedure, expected result, observed result, and evidence location.
- [ ] Source, unchanged-SDK, signed packaged, and live-feed outcomes are reported separately, with all version gaps, failures, skipped checks, and authorization blockers visible.
- [ ] Negative cases prove the intended fault was reached and preserve the installed app/configuration or the documented recovery state.
- [ ] Any discovered implementation defects are recorded for approval; validation does not silently expand into remediation of audit issues 6-7 or unrelated code.
- [ ] The final report states the supported scope as stable macOS arm64 and lists untested minimum-OS, physical input, actual login, Linux/Windows, prolonged-load, full-size disk/memory, and power-loss behavior where applicable.

No validation outcome is claimed by adding this plan.
