# MCP Gateway 0.2.0

Verified on 2026-11-02 for macOS arm64, targeting macOS 14+.

## Deliverables

- DMG: `artifacts/macos-arm64-MCPGateway.dmg` (49,061,773 bytes).
- Installer wrapper: `build/release-0.2.0/stable-macos-arm64/MCP Gateway.app`.
- Runtime archive: `artifacts/stable-macos-arm64-MCPGateway.app.tar.zst`.
- Checksums: [artifacts/SHA256SUMS](artifacts/SHA256SUMS).

DMG SHA-256: `e74fb03a01a2b167e8e7bab6fce15402921f529f1ec8519a7244f446f94efbcd`.

Quit older instances and copy the app from the DMG to a writable location before launching.
The wrapper replaces itself with the signed runtime on first launch.

## Included behavior

New in 0.2.0: local Logs with filtering/clearing, dismissible banners, and Cmd+W window-only closing that preserves the gateway and logs.
Usage and security guidance: [README.md](README.md).

## Signing and notarization

The runtime, wrapper, and DMG were Developer ID signed, accepted by Apple, and stapled.
Signature, ticket, Gatekeeper, embedded-payload identity, and DMG checksum checks passed.
Bun's framework entitlements allow JIT, unsigned executable memory, and disabled library validation.
Details: [release-verification.json](artifacts/release-verification.json).

## Verification

For the packaged macOS release:

- Passed: 7 E2E, 21 component, and 79 unit/integration tests; TypeScript, lint, and applicable LSP checks.
- Development and signed-native smoke passed fresh, JSON, and JSONC scenarios, including Cmd+W state retention and Cmd+Q cleanup.
- Independent source/test review found no remaining issues.

Evidence: [native-verification.json](artifacts/native-verification.json).
Test coverage: [tests/README.md](tests/README.md).

## Source-only build follow-up

Later source changes add Linux desktop behavior and mandatory native Ubuntu CI; Linux execution is still unverified pending a hosted run.
Windows retains an experimental packaging command only, not a runtime port.
These source changes are not included in the unchanged signed macOS artifacts above.
Commands and limits: [source-build instructions](README.md#linux-source-builds).

## Limits and unchanged state

- Not tested: physical keyboard/trackpad input, real login registration, second-device LAN access, sleep/wake, minimum macOS version, and power-loss durability.
- The installer wrapper was not executed; its exact signed runtime was tested separately.
- Tests used synthetic servers; no real Bear notes were changed.
