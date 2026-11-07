# Consolidate scripts from 13 files to 9

Status: implemented and verified on the current worktree.
See the implementation record at the end of this file for checks, limits, and deviations.

## Goal

Reduce file fragmentation without removing working commands, validation, process cleanup, or release safeguards.
The current directory contains six executable tools and seven helper modules.
The target keeps the six tools and three shared or substantial helpers.
This is a consolidation, not a promise of fewer lines of code.

The earlier cleanup already removed `scripts/test-e2e.ts`, `scripts/update-acceptance.ts`, orphan test configs, and their package and CI commands.
Preserve that pending cleanup rather than repeating or reverting it.

## Target layout

```text
scripts/
  build.ts
  build-config.ts
  toolchain.ts
  icons.swift
  check-native.ts
  check-native-linux.sh
  verify-release.ts
  release-dmg.ts
  release-inventory.ts
```

| Current file | Destination | Result |
| --- | --- | --- |
| `scripts/build-platform.ts` | `scripts/toolchain.ts` | Move host and build-mode validation; delete the old module. |
| `scripts/build-identity.ts` | `scripts/build-config.ts` | Move build identity generation; delete the old module. |
| `scripts/release-output.ts` | `scripts/build-config.ts` | Move output defaults and artifact-directory checks; delete the old module. |
| `scripts/native-process.ts` | `scripts/check-native.ts` | Move private environment and process-ownership helpers; delete the old module. |
| `scripts/native-report.ts` | `scripts/check-native.ts` | Move private report validators; delete the old module. |

Five deletions and one new module reduce 13 files to 9.
Keep `release-dmg.ts` and `release-inventory.ts` separate from the existing 401-line verifier because they handle scoped mount ownership and bundle comparison.
Keep `icons.swift`, the editable source for the app and tray artwork.

## Boundaries

- Preserve all remaining package commands, arguments, environment variables, output paths, and error behavior.
- Preserve Linux CI and the direct native-smoke and release-verification entry points.
- Do not change application code under `src/`, dependency versions, the lockfile, SDK selection, icons, or retained build and release artifacts.
- Do not add compatibility re-export files, a generic utilities module, a new runner, or another script directory to hide the count.
- Do not restore the deleted test suites; add only focused regression coverage for this refactor.
- Preserve unrelated worktree changes, including `.gitignore`, `bun.lock`, `hutch.config.ts`, concurrent toolchain edits, and other `.agents/` contents.
- Do not commit, publish, sign, notarize, install, or replace an application as part of this consolidation.

The inspection baseline is HEAD `162862f`, with uncommitted work already present.
Refresh the baseline before implementation because other local edits may continue.

## Implementation sequence

### 1. Record the baseline

- [x] Inspect Git status and record the bytes of affected files and unrelated pending changes.
- [x] Confirm the 13-file starting layout and recheck references to the five modules being removed.
- [x] Run the available type, lint, workflow, and shell checks before editing.
- [x] Record the existing helper bodies for a before-and-after comparison that ignores formatting and removed export modifiers only.

Treat the current working tree, not HEAD alone, as the preservation baseline.
Ignored historical acceptance copies under `.cache/` are evidence, not maintained callers to rewrite.

### 2. Fold platform selection into the toolchain

- [x] Move `validateBuildHost` and `buildPlan` into `scripts/toolchain.ts`, retaining their signatures, defaults, checks, and messages.
- [x] Update `scripts/build.ts` to import `buildPlan` alongside its existing toolchain imports.
- [x] Remove the old import from `toolchain.ts`, then delete `scripts/build-platform.ts`.

Keep the `import.meta.main` guard on toolchain preparation.
Importing the module must not download, extract, prepare, or launch anything.
Preserve the supported host matrix and refusal of unsupported cross-platform build modes.

### 3. Combine shared build configuration

- [x] Create `scripts/build-config.ts` from the existing identity and release-output functions, deduplicating imports only.
- [x] Update `electrobun.config.ts` to import `prepareBuildIdentity` and `releaseArtifactFolder` from the new module.
- [x] Update `scripts/build.ts` to import `assertEmptyReleaseArtifacts` and `releaseOutputEnvironment` from the new module.
- [x] Update only the corresponding import in `scripts/verify-release.ts`.
- [x] Delete `scripts/build-identity.ts` and `scripts/release-output.ts` after checking their callers.

Keep the module free of top-level filesystem writes and toolchain preparation.
Identity generation must still create a fresh value per call and use that same identity in the bundled definition and resource file.
Preserve private file modes, exclusive creation, version validation, environment overrides, and rejection of unsafe or nonempty artifact destinations.
Preserve the distinction between version-derived release defaults and the standalone `releaseArtifactFolder` fallback.

### 4. Keep native-smoke helpers with their only caller

- [x] Move the functions from `native-process.ts` and `native-report.ts` into `scripts/check-native.ts` as private functions.
- [x] Consolidate their imports, including `DesktopPlatform`, and place helper declarations before the executable flow.
- [x] Remove the two module imports and delete the old helper files.
- [x] Leave `scripts/check-native-linux.sh` and its CI invocation unchanged.

Preserve bundle-path restrictions, isolated environment construction, platform-specific report assertions, and compatibility with older macOS smoke reports.
Keep detached process-group ownership, idempotent cleanup, signal escalation, timeouts, permission-error handling, and confirmed absence checks unchanged.
Do not expose a new test API or change launch order to make the functions importable.

## Verification

Add one compact `tests/scripts.test.ts` using Bun's existing test runner.
Run it directly; do not add package aliases or another test framework.
Use fresh project-local temporary directories and clean up only resources created by the checks.

- [x] Cover the supported host and build-mode matrix, invalid modes, unsupported architectures, and cross-platform refusals.
- [x] Check toolchain imports without executing preparation.
- [x] Assert exact release defaults, preservation of explicit overrides and unrelated environment values, and invalid-version refusal.
- [x] Cover missing and empty artifact directories, plus rejection of nonempty directories, files, and symlinks.
- [x] Verify distinct build identities across calls, matching serialized identity/resource contents, copy-path mappings, and private resource permissions.
- [x] Compare moved native helper bodies against the baseline, allowing only formatting and export removal.
- [x] Run `bun test tests/scripts.test.ts`, `bun run typecheck`, and `bun run lint`.
- [x] Run `actionlint .github/workflows/test.yml`, `bash -n scripts/check-native-linux.sh`, and `git diff --check`.
- [x] Run configured LSP diagnostics for changed TypeScript files and report timeouts or unavailable coverage separately.
- [x] Confirm exactly nine files remain in `scripts/` and no maintained import or executable reference points to the five deleted modules.
- [x] Confirm remaining package commands, application source, unrelated changes, and protected artifacts match the implementation-start baseline.
- [x] Perform a focused self-review of the final diff for scope, import-time effects, validation, and cleanup preservation.

### Native verification limits

Where a compatible project-local development bundle is available, run the existing native smoke command before and after consolidation against that same bundle with separate project-local evidence directories.
Confirm renderer RPC, window recreation, graceful exit, and owned-process cleanup using the runner's existing assertions.
Also exercise its missing-bundle and out-of-project-path refusals without launching an app.
A retained bundle establishes runner equivalence only; it does not certify the current application source or updater replacement.

SDK settings changed independently during planning: `hutch.config.ts` requests Electrobun `^2.0.6`, and the toolchain download URL now names 2.0.6 while its devkit directory and checksum remain unchanged from the 2.0.5 baseline.
Recheck the selected version, download checksum, cached archive, and prepared devkit before attempting a fresh build.
SDK repair is outside this refactor; preserve concurrent toolchain edits rather than replacing them with an older copy.
If no compatible bundle or native host is available, leave the relevant native checks pending and report source-only verification.
Do not claim Linux runtime coverage from macOS checks or release acceptance from unchanged verifier imports.

## Completion criteria

- [x] The target nine-file layout is present, with no replacement helper files elsewhere.
- [x] All five old modules are deleted and their maintained callers are updated together.
- [x] Focused regression, static, reference, and preservation checks pass.
- [x] Native checks are recorded as passed or explicitly pending with a reason.
- [x] Build, release, and native-smoke behavior remains unchanged within the verified scope.
- [x] The completion summary states the file reduction, checks run, unresolved limits, and any deviation from this plan.

## Implementation record

Files: `scripts/` now holds nine files.
Deleted `build-platform.ts`, `build-identity.ts`, `release-output.ts`, `native-process.ts`, `native-report.ts`.
Added `scripts/build-config.ts` and `tests/scripts.test.ts`.
Updated imports in `scripts/build.ts`, `scripts/toolchain.ts`, `scripts/check-native.ts`, `scripts/verify-release.ts`, and `electrobun.config.ts`.

Checks run:
- `bun test tests/scripts.test.ts`: 25 pass, 184 assertions.
- `bun run typecheck`: pass.
- `bun run lint`: pass, 71 files.
- `actionlint .github/workflows/test.yml`, `bash -n scripts/check-native-linux.sh`, `git diff --check`: pass.
- Normalized comparison of the 14 moved function bodies against the pre-edit copies: identical apart from export removal and formatting.
- Native smoke against `build/review-f4-f5-accepted/dev-macos-arm64/MCP Gateway-dev.app` before and after consolidation: both report renderer RPC, window recreation, Cocoa Cmd+W, Cocoa Cmd+Q passed, with evidence in separate directories under `.cache/native-check-consolidation/`.
- Missing-bundle and out-of-project bundle refusals match before and after.
- `bun scripts/build.ts` and `bun scripts/build.ts linux` still refuse before toolchain preparation, and `electrobun.config.ts` still emits the identity copy mapping.

Limits:
- Linux native runtime was not executed; only `bash -n` on the unchanged CI script.
- Signed release signing, notarization, and updater replacement were not exercised.
- The retained development bundle proves runner equivalence only, not current application source.
