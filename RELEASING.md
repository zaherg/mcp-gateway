# Releasing

This guide covers signed, notarized macOS arm64 releases, the changelog and local update testing.
To build and run from source, see [DEVELOPMENT.md](DEVELOPMENT.md).
Run every command from the repository root.

## Prerequisites

- Everything in the [development prerequisites](DEVELOPMENT.md#prerequisites), with dependencies installed by `bun install`.
- `notarytool` and `stapler` from the Xcode Command Line Tools.
- `gh`, signed in with access to `zaherg/mcp-gateway`.
- A **Developer ID Application** certificate and its private key in Keychain.
  `security find-identity -v -p codesigning` must list exactly one such identity.
- Notarization credentials from the same Apple Developer team as the certificate:
  - `APPLE_ID`: the Apple Account email.
  - `APPLE_TEAM_ID`: the 10-character team ID.
  - `APPLE_APP_PASSWORD`: an app-specific password for that account.

Set the three values as environment variables or in a private `.env` file; exported variables win.
This command creates `.env` from the example and never overwrites an existing file:

```sh
[ -e .env ] || (umask 077; cp .env.example .env)
```

Never commit or share `.env` or the credentials.

## Release

1. Commit the work, with commit subjects written as described in [Changelog](#changelog).
2. Set `version` in `package.json` and commit it.
3. Run `bun run changelog` to fill the Unreleased section from the commits since the last tag.
   Skip this step if you wrote that section by hand, because it replaces the section.
4. Run `bun run changelog --tag <version>` to move the entries under a dated heading, then commit `CHANGELOG.md`.
5. Push the branch.
6. Run `bun run release:all`.

Do not create or push the tag yourself; `release:all` refuses an existing tag and creates it when it publishes.

### What `release:all` does

It stops at the first failure, and nothing is uploaded before verification passes.

1. **Preflight.**
   It requires a macOS arm64 host, `MCP_GATEWAY_TEST_FEED` unset, a clean working tree, `HEAD` on a remote branch, a signed-in `gh` and a dated `CHANGELOG.md` section for the version.
   It refuses a version whose tag exists locally or on any remote, or whose release already exists.
2. **Build** with `bun run release`, which signs and notarizes into `build/v<version>/` and `artifacts/v<version>/`.
3. **Verify** with `bun scripts/verify-release.ts`: signatures, notarization tickets, Gatekeeper, versions, the feed and identifier inside the payload, the manifests, the archive and the DMG.
4. **Publish** with `gh release create`, adding `SHA256SUMS` to the four artifacts.
   The release targets the built commit, so the tag lands there, and its notes are the version's `CHANGELOG.md` section.
5. **Read back** the release and download every file from `releases/latest/download`, comparing each with `SHA256SUMS`.
   A failure here says the release IS published; inspect it on GitHub instead of publishing again.

### When a step fails

The Electrobun signing step writes a redacted log to `.cache/build-stable.log`.
A build refuses output folders that are not empty, and kept artifacts must never be deleted to make room.
To build the same version again, set `MCP_GATEWAY_BUILD_ROOT` and `MCP_GATEWAY_ARTIFACTS_DIR` to new project-relative folders; every step reads the same values.
Builds share intermediate files, so run only one build per checkout at a time.

### Release files

- `macos-arm64-MCPGateway.dmg`: the installer for manual installs.
- `stable-macos-arm64-update.json`: the legacy update manifest.
- `stable-macos-arm64-update-v2.json`: the manifest with the expanded archive's digest and size, which Electrobun 2.0.6 uses.
- `stable-macos-arm64-MCPGateway.app.tar.zst`: the update payload.
- `SHA256SUMS`: checksums of the four files above.

The verifier also writes `release-verification.json` to the artifacts folder, or to `MCP_GATEWAY_VERIFICATION_OUTPUT` when set.
It is local evidence and is not published.

To try a candidate, open its DMG, for example `open artifacts/v<version>/macos-arm64-MCPGateway.dmg`, and copy the app to a writable location before you open it.
The DMG holds an installer wrapper that replaces itself on first launch.

### Updates

Production builds use the fixed feed `https://github.com/zaherg/mcp-gateway/releases/latest/download`; only `release:test` builds use another feed.
An update must match the installed app's identifier, channel and version metadata; the updater does not compare the signing team.
Version `0.3.0` has no updater and must be upgraded by hand with the DMG.
Passing the verifier does not prove that in-app updates work; test them with [UPDATE-TESTING.md](UPDATE-TESTING.md).

## Testing updates

To rehearse an in-app update with signed test builds before a release, follow [UPDATE-TESTING.md](UPDATE-TESTING.md).

## Changelog

`CHANGELOG.md` follows [Keep a Changelog 1.0.0](https://keepachangelog.com/en/1.0.0/).
[git-cliff](https://git-cliff.org), a pinned development dependency, generates it from the commits with the rules in `cliff.toml`.

Write commit subjects as `<type>: <summary>`, because the subject becomes the changelog line:

| Type | Section |
| --- | --- |
| `feat` | Added |
| `fix` | Fixed |
| `deprecat` | Deprecated |
| `remove`, `revert` | Removed |
| `security` | Security |
| `wip`, `docs`, `doc`, `chore`, `test`, `ci`, `build`, `style`, merge commits | Left out |
| Anything else | Changed |

Subjects beginning with the word `wip` are left out regardless of case, including bare `wip` and scoped forms such as `wip(ui):`.
The first match wins, so a `fix:` for a vulnerability lands under Fixed.
A `!` after the type, such as `feat!:`, marks the line as **Breaking:**.

- `bun run changelog` replaces the Unreleased section with entries generated from the commits since the last tag, so hand edits to that section are lost.
- `bun run changelog --tag <version>` requires the version in `package.json`.
  It moves the Unreleased entries under `## [<version>] - <date>`, opens a new Unreleased section and updates the version links.

## First real update

No test of the live GitHub update path is recorded.
Before relying on it, start an installed earlier release against the real feed and watch it update to the new one.
