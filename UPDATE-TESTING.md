# Testing updates

This runbook rehearses an in-app update between two signed test builds before a release.
For production releases, see [RELEASING.md](RELEASING.md).
Run every command from the repository root unless a step says otherwise.

This procedure uses the existing `mcp-gateway` bucket through the configured `rustfs:` remote.
Anyone can read `test/stable/*` without credentials.
Anonymous listing and writes are denied.
Do not recreate the bucket, replace unrelated policies or change the existing remote credentials.
Anyone who can reach the S3 endpoint can download these test builds.
Do not run two publishers or two update rehearsals against this shared prefix at the same time.

## Set up the test feed

Add these non-secret settings to the project `.env`, which Git ignores, and keep its existing contents:

```dotenv
MCP_GATEWAY_TEST_FEED_REMOTE=rustfs
MCP_GATEWAY_TEST_FEED=https://s3.mac.srvr.dev/mcp-gateway/test/stable
MCP_GATEWAY_TEST_FEED_S3_PATH=mcp-gateway/test/stable
```

`MCP_GATEWAY_TEST_FEED_REMOTE` names an existing rclone S3 remote, without a colon.
The remote keeps its own settings and credentials.
Exported values win over `.env`.

`MCP_GATEWAY_TEST_FEED_S3_PATH` is the `<bucket>/<prefix>` the publisher uploads to.
It has no default and needs a bucket plus at least one prefix segment.
The publisher refuses any other shape before it contacts S3.
If the feed has the same origin as the remote endpoint, the feed path must equal this value.
Otherwise the publisher refuses, because the builds would download from a different place than the one it uploads to.
Anonymous readback works only where the bucket policy allows `s3:GetObject`.
Today that is `test/stable/*`, so another prefix needs a policy change outside this project's scripts.
The publisher needs a plain HTTPS endpoint on the remote and writes only under the configured path.
It never creates a bucket or changes a policy.

The feed is built into the app and cannot change while the app runs.
`bun run release` ignores the test feed, even if a test build-kind variable is inherited, and always uses GitHub.
Test builds use the identifier `dev.srvr.mcpgateway.test` and keep the stable channel.
They are signed with the Developer ID but not notarized.
They store their configuration in `~/Library/Application Support/MCP Gateway Test/`, apart from the production `MCP Gateway` folder.
They need the signing identity in Keychain, but no Apple notarization credentials.
They say nothing about how Gatekeeper treats downloaded or quarantined apps.

## Build and verify two versions

Use the current version as A and a higher stable version as B.
The examples use 0.3.2 and 0.3.3.
B's version changes only in a scratch copy of the source.
Start a throwaway `bash -eu` from the repository root, run every block of this section inside it, and leave it with `exit` at the end.
Never paste the blocks into a login shell, because a failed command or the port check would close that shell.
Variables such as `ROOT`, `A_ARTIFACTS`, `B_ARTIFACTS` and `RUN` exist only in that shell.
If the shell closes, start the section again and set `RUN` by hand to the existing run folder.
A pair you already verified with these versions, identifier and feed can be reused instead of rebuilt.

```sh
ROOT="$PWD"
export MCP_GATEWAY_TEST_FEED=https://s3.mac.srvr.dev/mcp-gateway/test/stable
A_VERSION=$(bun -p 'require("./package.json").version')
NEXT=0.3.3
B_SOURCE="$ROOT/.cache/update-testing/candidate-B"
A_ARTIFACTS="$ROOT/artifacts/test-v$A_VERSION"
B_ARTIFACTS="$B_SOURCE/artifacts/test-v$NEXT"
```

To build a fresh A candidate:

```sh
bun run release:test
bun scripts/verify-release.ts --feed "$MCP_GATEWAY_TEST_FEED" --identifier dev.srvr.mcpgateway.test
```

To make a fresh B source copy, without overwriting an existing folder:

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

Test builds write to `build/test-v<version>/` and `artifacts/test-v<version>/` inside each source folder by default.
If an output already exists, reuse its verified candidate.
Otherwise choose new project-local `MCP_GATEWAY_BUILD_ROOT` and `MCP_GATEWAY_ARTIFACTS_DIR` values for both the build and the verifier.
Never delete kept outputs just to let a build continue.
The test verifier still checks signatures, manifest and payload identity, the expanded archive and every file in the DMG.
Its record states that it skipped the notarization and Gatekeeper checks.
Without the test identifier and feed arguments, the verifier runs the production checks and refuses a test candidate.

## Publish B

```sh
bun scripts/publish-test-feed.ts "$B_ARTIFACTS"
```

Before uploading, the publisher checks both manifests, the expanded TAR digest and size, and the test identity and feed inside the payload.
It uploads the archive first, then the v2 manifest, then the legacy manifest.
It then downloads each file anonymously over HTTPS and compares it with the local copy.
Publishing is not atomic: during an upload, a client can see files that do not match and must try again later.
Keep both manifests so older clients keep working.

The S3 endpoint stores `Cache-Control: no-cache` and returns it on HEAD, but not on GET.
The publisher requires that HEAD header and exact GET bytes.
This does not prove that proxies or caches between the app and S3 will not cache GET responses.
This procedure does not change the shared server's configuration.

The publisher always uploads the archive along with both manifests, and the archive key is shared.
So publishing an older candidate folder restores that version:

```sh
bun scripts/publish-test-feed.ts "$A_ARTIFACTS"
# Restore B before the success case.
bun scripts/publish-test-feed.ts "$B_ARTIFACTS"
```

## Launch an isolated copy of A

Do not launch the installer wrapper or use `open -a` for this rehearsal.
Instead, extract the verified runtime archive and launch its executable directly with an absolute scratch `HOME`.
With the pinned SDK, a directly launched app kept that home and working folder when it relaunched after an update.
Check this again after any toolchain change.
Never back up and restore the real configuration instead of isolating the test.

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
Open Updates in the sidebar and confirm that B is ready.
Before you accept the restart, make an unsaved configuration change, choose Restart to Update, and cancel the confirmation.
The unsaved change, the running app, the saved configuration and the A bundle must stay the same.
Then choose Restart to Update again, confirm, and wait for the new window.
The installed metadata must show B, its signature must pass, and both configuration checks must still match:

```sh
bun -e 'const p = process.env.RUN + "/install/MCP Gateway.app/Contents/Resources/version.json"; const v = await Bun.file(p).json(); console.log(JSON.stringify({version:v.version, identifier:v.identifier, channel:v.channel, feed:v.baseUrl}));'
codesign --verify --deep --strict "$RUN/install/MCP Gateway.app"
shasum -a 256 -c "$RUN/synthetic-config.before.sha256"
shasum -a 256 -c "$RUN/real-config.before.sha256"
```

Check the new window, not only the changed files.
The new process must have finished starting, and the gateway must be listening on the scratch port.
Do not register the test app as a login item.

## Failure cases and cleanup

- Publish A's folder, then choose Check in the running B app.
  The app must report the version as not eligible and must not prepare an update.
  Afterward, publish B again.
- To test a missing feed, remove only the two manifest keys this procedure owns, so the feed looks unpublished again.
  Choose Check in the running app; an error must appear while the gateway keeps running.
  Afterward, publish the verified B folder again, including its archive.
- Test a cleanup failure only in another throwaway source copy of A.
  In the native entry point, add a throw controlled by a flag file just before `await controller.close()`.
  Build and verify that private copy, and use a new scratch home and install.
  With the flag file present, Restart to Update must leave A installed and the app running with a cleanup error.
  Remove the flag file, choose Retry Quit, then reopen the same scratch copy and try the update again.
  Never add this throw to the product source.

Use the app's status text, configuration hashes, listener checks, anonymous downloads and, where available, S3 access logs as evidence.
An object listing or a `curl` download alone does not prove which requests the app made.
The "Rehearse the GitHub redirect shape" section below gives a separate request log without changing the shared S3 service.

Quit the test app from its window.
Confirm that no process command points into `$RUN/install` and that nothing listens on port 18770.
Only then delete the scratch run folder.
Its test updater data lives inside `$RUN/home`, not in your real home folder.
Keep source candidates and evidence if you plan another run.
The optional remote cleanup deletes objects:

```sh
bun scripts/publish-test-feed.ts --cleanup
```

It deletes exactly the three updater keys under the configured `MCP_GATEWAY_TEST_FEED_S3_PATH`.
It leaves the bucket, its anonymous-read policy and the remote alone.
It skips keys that are already gone, then checks that an anonymous GET of each file returns 404.
When run through Bun, it reads the same `.env` settings as publishing, so nothing needs to be exported first.
Do not delete the existing bucket, unrelated objects, or the existing remote and credentials.
This runbook includes no Git operation, GitHub publication, `/Applications` install or production app launch.

## Rehearse the GitHub redirect shape

GitHub answers `releases/latest/download/<file>` with a 302 redirect to a CDN host.
That path cannot be tested without publishing a real release.
To imitate it, build test candidates whose `MCP_GATEWAY_TEST_FEED` is a loopback URL like `http://127.0.0.1:<port>/releases/latest/download`.
Run a loopback server that answers only the three updater file names.
For each, it returns a 302 to the matching object under `https://s3.mac.srvr.dev/mcp-gateway/test/stable/`.
This server is a scratch tool and is not part of the source tree.
Publish B to S3 as above, then update from A exactly as in the previous section.

Results with the pinned SDK on this Mac (2026-11-08):

- The app follows a 302 from the loopback feed to an HTTPS object on another host, first for the manifest and then for the archive, and the update completes.
- When the published version is lower, the app downloads only the manifest and never requests the archive.
- A redirect to a plain `http:` URL that is not loopback is refused with `InsecureUpdateUrl`.
- An HTTPS manifest redirect combined with an `http:` archive redirect is refused the same way.
- An archive redirect to a different loopback port is refused with `UnsafeUpdateRedirect` before any connection to that port.
  The same redirect was followed for the manifest.

In every refusal, the installed version stays the same and the saved configuration stays byte-for-byte unchanged.
This lowers the risk of the first real GitHub update but does not remove it.
GitHub's CDN hosts, headers and redirect chain were not tested.
