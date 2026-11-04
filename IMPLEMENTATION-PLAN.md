# MCP Gateway audit issues

Status: issues 1-3 are fixed and locally verified; issues 4-7 remain open.
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

### 5. Backend response buffers have no size limit

Paths: `src/core/adapter.ts:L504-525`, `node_modules/supergateway/dist/lib/lineSplitter.js:L15-25`.

- **What this is:** The gateway collects complete streaming events or stdout lines before parsing them.
- **Problem:** Neither path bounds an unfinished message.
  A real loopback gateway accepted one 16 MiB streaming event; the 30-second deadline does not limit memory consumption.
- **Fix:** Bound backend message buffers and JSON response bodies.
  Use the installed event parser's `maxBufferSize` option and add oversized, multi-chunk regressions without editing installed dependency files.
- **If we skip it:** A faulty backend can exhaust the desktop app's memory despite the connection limits.
  Actual memory exhaustion was not tested.

### 6. Critical update acceptance tools are absent from a fresh checkout

Path: `tests/README.md:L180-186`.

- **What this is:** Private fixture builders and a driver test replacement between two packaged app versions.
- **Problem:** Those tools and their tests live only under ignored `.cache/auto-update-0.3.1/tests/`.
  A fresh checkout cannot reproduce that acceptance path.
- **Fix:** Track the reusable builders, driver, and tests under `tests/native/`.
  Keep signing credentials, generated bundles, and run evidence ignored.
- **If we skip it:** Future updater changes can pass the maintained suites without exercising actual replacement.

## Nice to have

### 7. Remove unused updater helpers

Paths: `src/main/updater/archive.ts:L486-501`, `src/main/updater/recovery.ts:L234-238`, `src/main/updater/preferences.ts:L5`.

- **What this is:** Four exported helpers and one constant remain without callers.
- **Problem:** Repository-wide reference checks found only their declarations, including searches through tests and configuration.
- **Fix:** Delete `listArchiveTopLevel`, `isSafePreparedHash`, `readDirectoryNames`, `retainedRecoveryEntries`, and `_MAX_PREFERENCE_BYTES`, plus unused imports.
- **If we skip it:** Maintenance retains unused code and a preference-size constant that enforces nothing.

Estimated reduction: 25 lines and zero dependencies.

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

Issues 4-7 remain open.
