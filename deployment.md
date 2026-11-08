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
Both output directories must be absent or empty, stay inside the project, and have no symlink ancestors.
Production and test commands refuse the other kind's versioned output paths.
The output check is not a lock.

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

Production releases use the fixed feed `https://github.com/zaherg/mcp-gateway/releases/latest/download`; `src/main/app-updater.ts` resolves support from the installed channel, version and feed.
Only the separate `release:test` command accepts a build-time feed override, as described below.
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

## Testing updates locally

This procedure uses the existing `mcp-gateway` bucket through the configured `rustfs:` remote.
Only `test/stable/*` is anonymously readable; anonymous listing and writes are denied.
Do not recreate the bucket, replace unrelated policies, or change existing remote credentials.
Anyone who can reach the S3 endpoint can read these test builds.
Do not run two publishers or update rehearsals against this shared prefix concurrently.

### Configure the test feed

Add these nonsecret settings to the ignored project `.env`, preserving its existing contents:

```dotenv
MCP_GATEWAY_TEST_FEED_REMOTE=rustfs
MCP_GATEWAY_TEST_FEED=https://s3.mac.srvr.dev/mcp-gateway/test/stable
MCP_GATEWAY_TEST_FEED_S3_PATH=mcp-gateway/test/stable
```

`MCP_GATEWAY_TEST_FEED_REMOTE` selects an existing rclone S3 remote by name, without a colon; the remote keeps its own settings and credentials.
Exported values take precedence over `.env`.
`MCP_GATEWAY_TEST_FEED_S3_PATH` is the `<bucket>/<prefix>` where the publisher uploads.
It has no default, needs at least a bucket and one prefix segment, and the publisher refuses any other shape before contacting S3.
When the feed has the same origin as the remote endpoint, the feed path must equal this value, otherwise the publisher refuses, because builds would fetch from a different place than where it publishes.
Anonymous readback works only where the bucket policy allows `s3:GetObject`; today that is `test/stable/*`, so another prefix needs a policy change outside this project's scripts.
The publisher requires a plain HTTPS endpoint on that remote and writes only under the configured path.
It never creates a bucket or changes its policy.

The feed is embedded at build time and cannot be changed in a running app.
`bun run release` ignores the test feed, including an inherited test build-kind variable, and remains GitHub-only.
Test builds use `dev.srvr.mcpgateway.test`, retain the stable channel, and are Developer ID signed without notarization.
They keep their configuration in `~/Library/Application Support/MCP Gateway Test/`, separate from the production `MCP Gateway` folder.
They need the signing identity in Keychain, but not Apple notarization credentials.
They do not establish Gatekeeper behavior for downloaded or quarantined apps.

### Build and verify two versions

Use the current version as A and a higher stable version as B.
The examples use 0.3.2 and 0.3.3; B's version changes only in a scratch source copy.
Start a throwaway `bash -eu` from the repository root, run every block of this section inside it, and leave it with `exit` at the end.
Never paste the blocks into a login shell: a failed command or the port check would close that shell.
Variables such as `ROOT`, `A_ARTIFACTS`, `B_ARTIFACTS` and `RUN` exist only in that session.
If the session closes, start the section again and set `RUN` by hand to the existing run directory.
An already verified pair with these versions, identifier and feed can be reused for another run instead of rebuilding it.

```sh
ROOT="$PWD"
export MCP_GATEWAY_TEST_FEED=https://s3.mac.srvr.dev/mcp-gateway/test/stable
A_VERSION=$(bun -p 'require("./package.json").version')
NEXT=0.3.3
B_SOURCE="$ROOT/.cache/update-testing/candidate-B"
A_ARTIFACTS="$ROOT/artifacts/test-v$A_VERSION"
B_ARTIFACTS="$B_SOURCE/artifacts/test-v$NEXT"
```

For a fresh A candidate:

```sh
bun run release:test
bun scripts/verify-release.ts --feed "$MCP_GATEWAY_TEST_FEED" --identifier dev.srvr.mcpgateway.test
```

For a fresh B source copy, refuse to overwrite an existing directory:

```sh
test ! -e "$B_SOURCE"
mkdir -p "$B_SOURCE"
rsync -a --exclude .git --exclude .agents --exclude .pi --exclude .serena \
  --exclude .cache --exclude .hutch --exclude .hutch-home --exclude '.env*' \
  --exclude node_modules --exclude build --exclude artifacts --exclude dist \
  --exclude .cottontail-tmp ./ "$B_SOURCE/"
cp -cR node_modules "$B_SOURCE/node_modules"
cp -cR .hutch-home "$B_SOURCE/.hutch-home"
(
  cd "$B_SOURCE"
  bun -e 'const file = Bun.file("package.json"); const p = await file.json(); p.version = process.argv[1]; await Bun.write("package.json", JSON.stringify(p, null, 4) + "\n");' "$NEXT"
  bun run release:test
  bun scripts/verify-release.ts --feed "$MCP_GATEWAY_TEST_FEED" --identifier dev.srvr.mcpgateway.test
)
```

Test outputs default to `build/test-v<version>/` and `artifacts/test-v<version>/` within each source directory.
If an output already exists, reuse its verified candidate or choose fresh project-local `MCP_GATEWAY_BUILD_ROOT` and `MCP_GATEWAY_ARTIFACTS_DIR` values for both build and verification.
Do not delete retained outputs to make a build proceed.
The test verifier still checks signatures, manifest and payload identity, expanded archive integrity, and the full DMG inventory; its record explicitly excludes notarization and Gatekeeper checks.
Without the explicit test identifier and feed, the verifier retains production checks and refuses a test candidate.

### Publish B

```sh
bun scripts/publish-test-feed.ts "$B_ARTIFACTS"
```

The publisher validates both manifests, the expanded TAR digest and size, and the payload's embedded test identity and feed before uploading.
It uploads the archive, v2 manifest, then legacy manifest, and verifies anonymous HTTPS readback against each local file.
Publication is not atomic: a client can encounter mismatched files during upload and must retry later.
Keep both manifests for compatible clients.

The S3 endpoint stores `Cache-Control: no-cache` and returns it on HEAD, but currently omits the directive on GET.
The approved check requires that HEAD metadata and exact GET bytes, and prints a warning about the missing GET directive.
This does not prove that intermediaries will avoid caching GET responses.
Shared-server configuration is not changed by this procedure.

Publishing an older candidate directory restores it, because the publisher always uploads the archive as well as both manifests and the archive key is shared:

```sh
bun scripts/publish-test-feed.ts "$A_ARTIFACTS"
# Restore B before the success case.
bun scripts/publish-test-feed.ts "$B_ARTIFACTS"
```

### Launch an isolated copy of A

Do not launch the installer wrapper or use `open -a` for this rehearsal.
Extract the verified runtime archive and launch its exact executable with an absolute scratch `HOME`.
The pinned SDK's direct-launch update path was observed to preserve that home and working directory across relaunch; repeat the isolation probe after a toolchain change.
Never back up and restore the real configuration as a substitute for isolation.

```sh
mkdir -p "$ROOT/.cache/update-testing"
RUN=$(mktemp -d "$ROOT/.cache/update-testing/run-XXXXXX")
export RUN
umask 077
mkdir -p "$RUN/install" "$RUN/home/tmp" "$RUN/home/Library/Application Support/MCP Gateway Test"
for folder in "MCP Gateway" "MCP Gateway Test"; do
  for name in mcp.json mcp.jsonc updates.json; do
    file="$HOME/Library/Application Support/$folder/$name"
    if [ -f "$file" ]; then shasum -a 256 "$file"; fi
  done
done > "$RUN/real-config.before.sha256"
# Select a different unused port if this one has a listener.
if lsof -nP -iTCP:18770 -sTCP:LISTEN >/dev/null; then exit 1; fi
bun -e 'const dir = process.env.RUN + "/home/Library/Application Support/MCP Gateway Test"; const config = { gateway: { host: "127.0.0.1", port: 18770, token: crypto.randomUUID().replaceAll("-", ""), autoStart: true, launchAtLogin: false }, mcpServers: {} }; await Bun.write(dir + "/mcp.json", JSON.stringify(config, null, 2) + "\n");'
chmod 600 "$RUN/home/Library/Application Support/MCP Gateway Test/mcp.json"
shasum -a 256 "$RUN/home/Library/Application Support/MCP Gateway Test/mcp.json" > "$RUN/synthetic-config.before.sha256"
tar -xf "$A_ARTIFACTS/stable-macos-arm64-MCPGateway.app.tar.zst" -C "$RUN/install"
codesign --verify --deep --strict "$RUN/install/MCP Gateway.app"
(
  cd "$RUN/install"
  exec env -i PATH="$PATH" HOME="$RUN/home" PWD="$RUN/install" \
    TMPDIR="$RUN/home/tmp/" USER="$(id -un)" LOGNAME="$(id -un)" \
    "$RUN/install/MCP Gateway.app/Contents/MacOS/launcher"
) > "$RUN/app.log" 2>&1 &
printf '%s\n' "$!" > "$RUN/initial-launcher.pid"
```

Wait for the automatic check, about 10 seconds after launch, and then for the download.
In Settings → Updates, confirm that B is ready.
Before accepting the restart, make an unsaved configuration draft, choose Restart to Update, and cancel the confirmation.
The draft, running app, saved config and A bundle must remain unchanged.
Then confirm Restart to Update and wait for the new window.
The installed metadata must show B, its signature must pass, and both config checks must remain unchanged:

```sh
bun -e 'const p = process.env.RUN + "/install/MCP Gateway.app/Contents/Resources/version.json"; const v = await Bun.file(p).json(); console.log(JSON.stringify({version:v.version, identifier:v.identifier, channel:v.channel, feed:v.baseUrl}));'
codesign --verify --deep --strict "$RUN/install/MCP Gateway.app"
shasum -a 256 -c "$RUN/synthetic-config.before.sha256"
shasum -a 256 -c "$RUN/real-config.before.sha256"
```

Check the new window, not just the changed file: the new process must have completed startup and the gateway must be listening on the synthetic port.
Do not register the test app as a login item.

### Negative cases and cleanup

- Publish A's directory, then Check in the running B app.
  Expect the version to be ineligible and no update preparation.
  Restore B with the publisher afterward.
- To rehearse a missing feed, temporarily remove only the two owned manifest keys, returning the feed to its initial unpublished state.
  Check in the running app; an error must be visible while the gateway stays running.
  Republish the verified B directory afterward, including its archive.
- Exercise cleanup failure only in another throwaway source copy of A.
  Add a flag-file-controlled throw immediately before `await controller.close()` in the native entrypoint, build and verify that private copy, and use a fresh scratch home and install.
  With the flag present, Restart to Update must leave A installed and the app alive with a cleanup error.
  Remove the flag, use Retry Quit, then reopen the same scratch copy to retry the update.
  Never add the injection to product source.

Use native status text, config hashes, listener checks, anonymous object readback and, where available, S3 access logs as evidence.
An object listing or curl readback alone does not prove which requests the app made.
The "Rehearse the GitHub redirect shape" section below provides a separate request log without requiring changes to the shared S3 service.

Quit the test app through its window and confirm no process command points into `$RUN/install` and no listener remains on port 18770.
Only then remove that owned scratch run directory; its test updater data is inside `$RUN/home`, not the real home.
Keep source candidates and evidence if another run is needed.
Optional remote cleanup deletes objects:

```sh
bun scripts/publish-test-feed.ts --cleanup
```

It names exactly the three owned updater keys under the configured `MCP_GATEWAY_TEST_FEED_S3_PATH` and leaves the bucket, its anonymous-read policy and the remote untouched.
It skips keys that are already absent, then checks that an anonymous GET of each file returns 404.
Run through Bun, it reads the same `.env` settings as publishing, so nothing needs exporting first.
Do not delete the pre-existing bucket, unrelated objects, or the existing remote and credentials.
No Git operation, GitHub publication, `/Applications` installation, or production app launch is part of this runbook.

### Rehearse the GitHub redirect shape

GitHub serves `releases/latest/download/<file>` as a 302 to a CDN host, and a release cannot be rehearsed without publishing one.
To approximate it, build test candidates whose `MCP_GATEWAY_TEST_FEED` is a loopback URL of the form `http://127.0.0.1:<port>/releases/latest/download`.
Run a loopback server that answers only the three updater file names with a 302 to the matching object under `https://s3.mac.srvr.dev/mcp-gateway/test/stable/`.
The server is a scratch tool and is not part of the source tree.
Publish B to S3 as above, then run the update from A exactly as in the previous section.

Observed with the pinned SDK on this Mac (2026-11-08):

- A 302 from the loopback feed to an HTTPS object on another host is followed for the manifest and the archive, in that order, and the update completes.
- A lower published version fetches the manifest only; no archive request follows.
- A redirect to a plain `http:` non-loopback URL is refused with `InsecureUpdateUrl`.
- An HTTPS manifest redirect combined with an `http:` archive redirect is refused the same way.
- An archive redirect to a different loopback port is refused with `UnsafeUpdateRedirect` before any connection to that port; the same redirect shape was followed for the manifest.

The installed version stays unchanged and the saved configuration stays byte-identical in every refusal.
This narrows the risk of the first real GitHub release but does not remove it: GitHub's CDN hosts, headers and redirect chain were not exercised.

## Release checklists

These checks apply to production releases only.
A test candidate must never be published to GitHub.

### Before tagging

1. Work from a clean checkout at the commit that will carry the tag, with `MCP_GATEWAY_TEST_FEED` unset.
2. Run `bun run release`, then `bun scripts/verify-release.ts` with no arguments.
   Without `--identifier` and `--feed`, the verifier requires the production identifier, the fixed GitHub feed, notarization and Gatekeeper acceptance, and refuses a `release:test` candidate.
3. Read `Contents/Resources/version.json` in the signed payload: the feed, identifier `dev.srvr.mcpgateway`, channel `stable` and the version in `package.json` must agree.
4. Confirm that both manifests name the same version, hash and archive file, and that the artifact folder holds the DMG, both manifests and the archive.
5. Confirm that the tag matches `package.json`, as `release.yml` requires.

### After publishing

Replace `<tag>` with the published tag.

```sh
gh release view <tag> --repo zaherg/mcp-gateway --json assets,isDraft,isPrerelease,tagName,url
curl -sIL https://github.com/zaherg/mcp-gateway/releases/latest/download/stable-macos-arm64-update-v2.json
```

1. The asset list must contain the DMG, both manifests, the archive and `SHA256SUMS`, and the release must be neither a draft nor a prerelease.
2. The `curl` trace must show the 302 to the release asset and end in HTTP 200.
3. Download the v2 manifest and the archive, compare the manifest byte for byte with the local copy, and compare the archive hash with the checksum file.
4. Expand the archive and compare its SHA-256 and size with `tarSha256` and `tarSize` in the v2 manifest.

Checked on 2026-11-08 against the current `v0.3.0` release: it lists only `macos-arm64-MCPGateway.dmg`, and the `latest/download/stable-macos-arm64-update-v2.json` request redirects with 302 to the `v0.3.0` asset URL and ends in 404, because that release has no updater files.
The asset-listing and redirect commands work, and the first updater-capable release is therefore the first point at which they can pass.

### First real update

The live GitHub update path stays unverified until two updater-capable releases exist.
Then start an installed N against the real feed and observe it update to N+1.
Until that happens, release notes and `README.md` must say that the live GitHub update path has not been exercised.

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
