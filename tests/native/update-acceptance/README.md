# Packaged update acceptance

These maintained helpers exercise replacement between private macOS arm64 app versions `0.3.1` and `0.3.2`.
Those are fixture identities, not release-version choices.
The builder changes copied source only; production source, installed apps, and published artifacts remain separate.
Generated source, apps, credentials, and evidence must not be committed.
Default outputs live under ignored `.cache/update-acceptance/`.
The older `.cache/auto-update-0.3.1/` directories are historical evidence, not source dependencies.

## Source checks

Run commands from the repository root with the pinned Bun and Node versions documented in the root README.
A fresh checkout needs the ordinary dependencies and prepared Electrobun SDK, not an earlier acceptance run:

```sh
bun install --frozen-lockfile --ignore-scripts --cache-dir .cache/bun
bun run prepare:sdk
bun test tests/native/update-acceptance
```

The same tests run in `bun run test:unit` and the existing CI unit step.
They check both generated source variants, renderer RPC timing, failure evidence, path restrictions, and owned process/helper cleanup.
Three tests require macOS, including the Xcode command-line compiler, and are skipped elsewhere.
These tests do not sign apps, contact the update feed, or replace an application.

## Prepare a private pair

This stage creates source copies but does not build or launch the private apps.
First populate the ordinary development-build inputs that the builder copies: `.hutch`, `.hutch-home`, `.cache/research`, and `.cache/runtime-deps`.
The bootstrap build uses separate output directories:

```sh
MCP_GATEWAY_BUILD_ROOT=.cache/update-acceptance/bootstrap-build \
MCP_GATEWAY_ARTIFACTS_DIR=.cache/update-acceptance/bootstrap-artifacts \
  bun run build

export MCP_GATEWAY_FIXTURE_BUILD_ROOT="$PWD/.cache/update-acceptance/builds/success"
export MCP_GATEWAY_ACCEPTANCE_ROOT="$PWD/.cache/update-acceptance/runs/success"
mkdir -p "$PWD/.cache/update-acceptance/runs"
bun tests/native/update-acceptance/prepare-fixture-apps.ts
```

Both destinations must be fresh project-local paths below `.cache`; symlinked directories are refused.
An existing source-copy destination is not overwritten.
The generated apps embed the absolute acceptance root before SDK initialization so that a Launch Services relaunch uses the same isolated home, data, and temporary directories.
Keep that root unchanged through preparation, signing, and execution.
The private feed is fixed to `http://127.0.0.1:47831/releases/latest/download`.

## Signed packaged execution

This stage requires separate authorization for signing, notarization, and replacement of the private app copy.
Do not run it as part of a source-only check.
It requires macOS arm64, Xcode command-line tools, the existing Developer ID signing setup, and `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_PASSWORD` supplied through the approved environment.
Do not put credential values in source, command examples, or generated fixtures.

Build and verify each private version inside its copied project.
Each copy's `artifacts/` must be absent or empty before building.
Explicit output overrides keep these artifacts inside the copy even if the caller has other build variables set:

```sh
for variant in a b; do
  (
    cd "$MCP_GATEWAY_FIXTURE_BUILD_ROOT/$variant" || exit 1
    MCP_GATEWAY_BUILD_ROOT=build MCP_GATEWAY_ARTIFACTS_DIR=artifacts \
      bun run release &&
    MCP_GATEWAY_BUILD_ROOT=build MCP_GATEWAY_ARTIFACTS_DIR=artifacts \
    MCP_GATEWAY_VERIFICATION_OUTPUT=artifacts/release-verification.json \
      bun scripts/verify-release.ts
  ) || exit 1
done
```

The verifier extracts a separate signed runtime payload and records its absolute location as `payloadPath`.
Use that verified A payload, not the self-replacing installer wrapper:

```sh
MCP_GATEWAY_FIXTURE_A_APP="$(bun -e '
  const file = process.env.MCP_GATEWAY_FIXTURE_BUILD_ROOT + "/a/artifacts/release-verification.json";
  const record = await Bun.file(file).json();
  if (record.ok !== true || typeof record.payloadPath !== "string") throw new Error("A payload is not verified");
  console.log(record.payloadPath);
')" || exit 1
export MCP_GATEWAY_FIXTURE_A_APP
export MCP_GATEWAY_FIXTURE_B_ASSETS="$MCP_GATEWAY_FIXTURE_BUILD_ROOT/b/artifacts"
export MCP_GATEWAY_ACCEPTANCE_CASE=success
bun tests/native/update-acceptance/product-update-flow.ts
```

B assets must contain `stable-macos-arm64-update.json` and `stable-macos-arm64-MCPGateway.app.tar.zst`.
No release is uploaded by these commands.
The driver binds loopback port 47831, copies A into the isolated acceptance root, and serves B through the private feed.
It requires completed startup/RPC evidence, one confirmed target startup, pre-handoff backend absence, unchanged configuration, and checked cleanup before reporting success.
The two-second duplicate-startup observation window does not prove that no later restart can occur.

## Failure cases and retained state

Supported cases are `success`, `offline`, `interrupted`, `cleanup-failure`, and `late-start`.
They cover a manifest HTTP 503, an on-disk partial download, cleanup refusal followed by explicit retry, and six-second delayed renderer readiness.
Use fresh build and acceptance roots for each case, repeating preparation and signing because the root is embedded in both apps.
Changing only the runtime environment does not relocate an already signed fixture.

The driver refuses an existing acceptance directory and retains `evidence.json` plus synthetic logs.
Failure evidence includes the initial app inventory/configuration digests and the last attempted driver stage; the app fixture separately identifies failure-state, renderer, and MCP probe failures.
After interruption or cleanup failure, inspect that directory and confirm all owned processes and native helpers have settled before removing anything.
Unconfirmed cleanup is a failed run, not permission to delete its app, transaction journal, or recovery evidence.

## SDK contract and helper checks

The opt-in SDK suite uses the unchanged Electrobun `2.0.5` projection, copies signature-verified runtime helpers, and routes the fixed feed to loopback.
Its 20 cases cover full downloads, malformed metadata, version policy, network/archive failures, cancellation, and an actual SDK `before-quit` veto.
Exact target TAR bytes, prepared records, request paths, configuration preservation, and worker cleanup remain checked.
The application's safety boundary prunes cached TARs and prepared records before preparation, so delta/fallback and cache-reuse cases are not maintained.
Unused SDK metadata aliases, history APIs, direct development-channel discovery, and apply-without-preparation cases are also excluded.
Restore the corresponding coverage before enabling any of those paths in the application.

```sh
MCP_GATEWAY_SIGNED_PAYLOAD="$MCP_GATEWAY_FIXTURE_A_APP" \
  bun test ./tests/native/updater-sdk-contract.native.ts
```

`native-failures.ts` exercises the signed input's unchanged native helper using small signed app fixtures.
It checks parent-exit waiting, publisher and incompatible-host refusal, rollback after a post-swap integration failure, moving-payload refusal, read-only destinations, manual restoration, file limits, literal ENOSPC, and signature tampering.
The small apps are signed locally but are not notarized product releases; the full product pair remains the startup/RPC acceptance test.
A successful `/usr/bin/open` spawn does not establish application startup or health.
The disk-full case requires explicit authorization and the opt-in below; it fills only an isolated 8 MiB image and checks detachment.
The output directory must be fresh and below the project's `.cache` directory.

```sh
MCP_GATEWAY_MATRIX_APP="$MCP_GATEWAY_FIXTURE_A_APP" \
MCP_GATEWAY_MATRIX_ROOT="$PWD/.cache/update-acceptance/helper-run-1" \
MCP_GATEWAY_ALLOW_ENOSPC_IMAGE=1 \
  bun tests/native/update-acceptance/native-failures.ts
```

Update rendering, progress, and retry states are covered by `bun run test:components`.
`bun run test:e2e` checks the restart confirmation's keyboard cancellation, focus, and desktop/narrow layout with synthetic update status; it does not install an update.

These commands retain project-local evidence and do not contact the public feed, register login startup, or change installed apps.
Missing prerequisites fail explicitly; the native `.native.ts` suite and these scripts are not part of default unit-test discovery.
