# Deployment

This guide covers source builds and signed, notarized releases for macOS arm64.
Run the commands from the repository root unless a step says otherwise.

## Prerequisites

- An Apple silicon Mac running macOS 14 or later.
- Git, Bun 1.4.4, and Node.js; the CI workflow uses Node.js 26.13.0.
- Xcode Command Line Tools, including `clang`, `swiftc`, `notarytool`, and `stapler`.
- Network access to install dependencies and download the pinned Electrobun toolchain.

If Command Line Tools are not installed, run `xcode-select --install`.
A signed release also requires an Apple Developer ID and notarization credentials, described below.

## Build from source

Clone the repository, or use an existing checkout of the revision to build:

```sh
git clone https://github.com/zaherg/mcp-gateway.git
cd mcp-gateway
bun install --frozen-lockfile --ignore-scripts --cache-dir .cache/bun
```

Build a development package:

```sh
bun run build
```

Without a `MCP_GATEWAY_BUILD_ROOT` override, the macOS development app is `build/dev-macos-arm64/MCP Gateway-dev.app`.
To build and launch the development app instead, run `bun run dev`.
Running the app can read or change its configuration; see [Configuration](README.md#configuration).

The build prepares the toolchain automatically and writes generated files under `.cache/`, `.hutch-home/`, `dist/`, `assets/`, and the selected build directory.
Use a separate checkout for concurrent builds because these intermediate paths are shared.

`hutch.config.ts` pins Electrobun 2.0.6 and its paired Hutch 0.29.0.
`bun run prepare:sdk` uses the installed Electrobun bootstrap to download and verify the selected toolchain under `.hutch-home/` and project the SDK into `.hutch/devkit/`.
A global `hutch` installation is not required.

### Tests

Run the available checks:

```sh
bun run typecheck
bun run lint
```

`.github/workflows/lint.yml` runs on branch pushes, pull requests, manual dispatches and calls from the release workflow.
It uses checksum-pinned Actionlint 1.7.12, ShellCheck 0.11.0 and Typos 1.52.0.
Actionlint checks the workflows and their inline shell commands; ShellCheck also checks tracked `.sh` and `.bash` files.
Typos checks first-party source and documentation using `_typos.toml`, excluding generated outputs, dependencies, private environment files and vendored skills.
Each check still runs if another linter fails, provided tool installation succeeded.
The workflow reports findings without editing files and does not run test suites.

The unit, component, browser, and packaged-acceptance suites are absent from this checkout.

## Signed and notarized release

### Configure signing

Install a valid **Developer ID Application** certificate and its private key in Keychain.
The build requires exactly one matching Developer ID Application identity in the output of:

```sh
security find-identity -v -p codesigning
```

The signing identity and notarization account must belong to the intended Apple Developer team.
Set `APPLE_ID` to the Apple Account email, `APPLE_TEAM_ID` to the 10-character team ID, and `APPLE_APP_PASSWORD` to an app-specific password for that account.
Provide them as environment variables or in a private `.env` file.
Exported variables take precedence over `.env`.

If `.env` does not exist, create it from the example without overwriting an existing file:

```sh
[ -e .env ] || (umask 077; cp .env.example .env)
```

Edit `.env` locally and fill in the three values.
Do not commit or share the file or credentials.
The script discovers the signing identity and passes the credentials to the pinned Electrobun build.
Notarization requires network access to Apple.

### Build a release candidate

`bun run release` builds, signs, and notarizes the macOS release, using the version in `package.json`.
It does not upload or publish the result.
By default, it writes to `build/v<version>/` and `artifacts/v<version>/`.
The artifact directory must be absent or empty and must not be a symlink.
The artifact check is not a lock.

Build the default candidate from the repository root:

```sh
bun run release
```

For another candidate of the same version, set `MCP_GATEWAY_BUILD_ROOT` and `MCP_GATEWAY_ARTIFACTS_DIR` to fresh relative paths.
Use a separate checkout for concurrent builds because intermediate files are shared.

The signed installer wrapper is `build/v<version>/stable-macos-arm64/MCP Gateway.app`.
The artifacts directory contains:

- `macos-arm64-MCPGateway.dmg` is the installer for manual installation.
- `stable-macos-arm64-update.json` is the legacy updater manifest.
- `stable-macos-arm64-update-v2.json` adds the expanded archive digest and size used by Electrobun 2.0.6.
- `stable-macos-arm64-MCPGateway.app.tar.zst` is the updater payload.

After the verification and acceptance checks pass, upload all four files to the same GitHub release without renaming them.
Their version must match `package.json`.
The existing `artifacts/v0.3.1/` files predate the current dependency changes and do not verify the current checkout.
If the build fails, inspect the command output and use a new candidate directory for the next attempt.
The Electrobun signing step also writes a redacted log to `.cache/build-stable.log`; failures before that step may not produce a current log.
Do not remove retained artifacts to make a build proceed.

### Verify the candidate

After a successful default build, run the verifier:

```sh
bun scripts/verify-release.ts
```

For a candidate built with output overrides, pass the same `MCP_GATEWAY_BUILD_ROOT` and `MCP_GATEWAY_ARTIFACTS_DIR` values to the verifier.
The verifier checks signatures, notarization tickets, Gatekeeper assessment, version and payload consistency, and the DMG contents.
By default, it writes `release-verification.json` in the artifacts directory and extracts a separate signed payload under `.cache/signed-payload-*`.
The verification record is local evidence and is not a required release asset.
Set `MCP_GATEWAY_VERIFICATION_OUTPUT` to choose another record location.
Check the command result and the record before using the candidate.

Verification alone does not establish updater or packaged replacement acceptance.
The recorded `0.3.1` packaged acceptance has not passed: the signed late-start case failed twice, and the original HTTP 503 fixture had unresolved failures.
The packaged-acceptance fixtures and their guides are absent from this checkout, so those checks cannot currently be rerun using the deleted suite.

The updater feed is fixed to `https://github.com/zaherg/mcp-gateway/releases/latest/download` in `electrobun.config.ts` (`release.baseUrl`); `src/main/app-updater.ts` resolves support from the installed channel, version and feed.
Update candidates must match the installed app's identifier, channel and version metadata; the built-in updater does not compare the signing team.
Version `0.3.0` has no updater and requires a manual upgrade using the DMG.

### Install or distribute

After the required verification and acceptance checks pass, open the DMG for the selected version.
For example, for version 0.3.1:

```sh
open artifacts/v0.3.1/macos-arm64-MCPGateway.dmg
```

Copy the app from the mounted DMG to a writable location before opening it.
The DMG contains an installer wrapper that replaces itself on first launch.
Keep a candidate separate from an existing installation unless replacement is intended.
Publishing the release assets is a separate operation from building and verification.

## Automatic releases from tags

`.github/workflows/release.yml` builds a signed, notarized macOS arm64 release when a tag is pushed.
Tags must be `X.Y.Z` or `vX.Y.Z`, with a version matching `package.json` exactly.
Other tags and prerelease versions fail validation without publishing.
The release, lint and test workflow definitions must all be present in the tagged commit.

Do not tag the current source for distribution until packaged acceptance is complete.
The built-in Electrobun updater is wired, but the release workflow verifies build artifacts, not a complete in-app update cycle.

### Required GitHub Actions secrets

Add these repository secrets in GitHub Settings → Secrets and variables → Actions:

- `MACOS_CERTIFICATE_P12_BASE64`: Base64-encoded PKCS#12 export containing the Developer ID Application certificate and its private key.
- `MACOS_CERTIFICATE_PASSWORD`: Password protecting that PKCS#12 export.
- `APPLE_ID`: Apple Account email used for notarization.
- `APPLE_TEAM_ID`: Apple Developer team ID matching the signing certificate.
- `APPLE_APP_PASSWORD`: App-specific password for the notarization account.

Use a consistent signing identity for notarization and Gatekeeper acceptance; the built-in updater does not compare the signing team.
Keep the certificate and its password out of Git and workflow logs.
The runner generates its temporary keychain password; no separate secret is needed for it.
Missing secrets stop the workflow rather than producing an unsigned release.

### Build and publication

The release workflow first calls `lint.yml` and `test.yml` from the same tagged commit.
Both must succeed before the macOS build can start; a failure, cancellation or skipped check blocks signing and publication.
The `test.yml` workflow runs on a `macos-15` arm64 runner with Node 26.13.0 and Bun 1.4.4.
It installs locked dependencies, prepares the SDK, runs typecheck and lint, builds the UI, and builds the unsigned development app.
It does not launch the app or run a native smoke check.
Standalone lint and test runs still cover branch pushes, pull requests and manual dispatches; tag checks run through the release workflow to avoid duplicate runs.
Their concurrency groups are separate so a called workflow cannot cancel its caller.
Signing secrets are not passed to either check workflow.

The build job uses GitHub's `macos-15` arm64 runner, Node 26.13.0 and Bun 1.4.4.
It installs the locked dependencies, prepares the SDK, runs typecheck and lint, then signs, notarizes and verifies the release.
The verifier checks the v2 manifest's expanded archive digest and size; the workflow then generates `SHA256SUMS`.
No unit, component, browser or packaged-update test suites run.

CI uses fresh `build/ci-release/` and `artifacts/ci-release/` directories.
Only the four release files and `SHA256SUMS` pass to the publication job; signing credentials and private build state are excluded.
The temporary signing keychain is removed even when the build fails.

A separate Ubuntu job verifies the transferred checksums and confirms that the tag still points to the built commit.
It uses the repository's `GITHUB_TOKEN` to create the release with generated notes, uploads all five assets, then publishes it.
No personal access token is needed.
Existing releases and their assets are never overwritten.
If an upload failure leaves a draft release, inspect and remove that draft before retrying publication.

After packaged acceptance is ready, update `package.json`, commit the release changes, and push the matching version tag.
Creating this workflow locally does not create or push a tag, configure signing secrets, or publish a release.
