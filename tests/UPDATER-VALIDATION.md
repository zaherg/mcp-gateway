# Updater validation: 2026-11-05

Overall outcome: **FAIL**.
The required signed `late-start` replacement test failed twice; whether the cause is application code or the test fixture remains unresolved.
The signed artifacts from this run are not accepted for publication or installation.

## Scope

This record preserves the validation results formerly in `IMPLEMENTATION-PLAN.md`.
The run tested app `0.3.1` with Electrobun `2.0.5`, Hutch `0.28.2`, Bun `1.4.4`, and macOS `27.2` arm64.
Application source matched commit `b01bde6`; HEAD advanced during validation to README-only commit `b7e333b`.
These results do not certify later source changes, including the removal of session-based MCP support.

## Results

| Layer | Outcome | Evidence and limits |
| --- | --- | --- |
| Source | PASS | 692 unit/integration tests, 5,424 assertions; 64 component tests; 22 browser tests; 32 supplementary audit tests; types, lint, and scoped LSP diagnostics. |
| Unchanged SDK | PASS | 32 contract cases, 451 assertions; five existing SDK helper tests, 223 assertions; patch-only requests and output digests checked. |
| Native checks | PASS | Four development and four signed smoke scenarios; four dirty/unresponsive signal cases; six executable-permission cases; 11 signed-small-app helper cases, including post-swap rollback and an isolated 8 MiB disk-full test. |
| Signed artifacts | PASS | Wrapper, payload, and DMG signatures, notarization, tickets, Gatekeeper, complete DMG inventory, build identity, and credential scan. |
| Private replacement | FAIL | Success, interrupted download, and cleanup-failure/retry passed; delayed renderer startup failed twice; HTTP-503 results remain flaky. |
| Public delivery | BLOCKED | At inspection, the latest release was `0.3.0` with only a DMG; updater assets initially returned 404, and the final manifest probe returned 504. |
| Electrobun 2.0.6 | VERSION GAP | Archive recipes, native streamed preparation, v2 manifests, paired Hutch, redirect rules, and bridge/subsequent-update acceptance were not validated. |

## Unresolved failures

Both `late-start` attempts reached the intended 6,002 ms renderer delay but produced neither a completed-startup marker nor an update-trigger receipt within 120 seconds.
Both preserved the original app inventory and settled owned resources; the second also proved unchanged configuration bytes.
The first attempt did not persist its initial configuration digest.
Investigation must distinguish startup-marker fixture behavior from application/native RPC readiness before attributing the failure or changing product code.
No timeout or assertion was relaxed.

The original HTTP-503 fixture failed twice while waiting for an update result.
A newly signed fixture with finer failure-stage reporting then passed three runs without changes to product behavior, timeouts, or assertions.
Those passes do not explain the original failures.

## Evidence and limits

Detailed evidence is local and ignored by Git: `.cache/updater-documentation-validation/20261105T052930Z/`.
It includes `contract-matrix.json`, `summary.json`, `preservation.json`, `cleanup.json`, `late-start-failure.json`, and the `private-runs/` records.
The matrix records 56 PASS, two FAIL, three BLOCKED, and six VERSION GAP rows.
The maintained [acceptance operator guide](native/update-acceptance/README.md) documents how to run the checks; a fresh checkout does not contain the historical evidence or signed inputs.

Normal application preparation uses full archives because it removes cached TARs and prepared records before a new attempt.
SDK delta tests therefore do not establish delta use by the packaged application.
A native helper's successful launch request does not prove healthy application startup.
Helper rollback and separate manual restoration passed, but they do not override the failed product test.

No installed app, external configuration, real Bear data, or login registration changed during validation; no release was published.
Minimum macOS, physical input, actual login, native Linux/Windows, second-device LAN, prolonged load, full-size disk/memory pressure, power loss, installer-wrapper execution, arbitrary delayed Launch Services behavior, and live GitHub updater delivery remain unverified.
