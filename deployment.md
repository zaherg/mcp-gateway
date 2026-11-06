# Deployment

This guide covers source builds and signed, notarized releases for macOS arm64.
See the [platform status](README.md#platform-status) for Linux and Windows limitations.
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

The current `hutch.config.ts` requests Electrobun 2.0.6, while `scripts/toolchain.ts` supplies the 2.0.5 macOS devkit.
On macOS arm64, this mismatch stops the build with `ElectrobunDevkitVersionMismatch`.

### Tests

Run the available checks:

```sh
bun run typecheck
bun run lint
```

The test suites and packaged-acceptance fixtures are absent from this checkout.
The test commands in `package.json` cannot run the deleted suites.

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
- `stable-macos-arm64-update.json` is the updater manifest.
- `stable-macos-arm64-MCPGateway.app.tar.zst` is the updater payload.

After the verification and acceptance checks pass, upload all three files to the same GitHub release without renaming them.
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

The updater feed is fixed to `https://github.com/zaherg/mcp-gateway/releases/latest/download` in `src/main/updater/constants.ts`.
Update candidates must match the installed app's identifier and Apple Developer team, so a build signed by a different team cannot update the official build.
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
