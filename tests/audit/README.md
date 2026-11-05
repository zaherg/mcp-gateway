# Audit remediation reproduction suite

This directory holds deterministic reproductions for the A1-A13 findings from
the src audit at HEAD `9bcb74a`.
A1 was fixed in `ad4722a`.
A2-A6 plus prerequisite A12 completed their earlier source and packaged verification.
The remaining cases supplement the default core/main suites with native login-library lifetime, stalled process inspection, update identity refusal, Quit attempt ordering, native plist compatibility and main-entrypoint Quit wiring.
The `pending/` directory retains its original layout; the directory name does not indicate current status.
Compiled build identity and transaction confirmation live in `tests/main/build-identity.test.ts` and `tests/main/updater-transaction.test.ts`.
Startup cancellation and crash recovery live in `tests/main/updater-startup.test.ts` and `tests/main/updater-residue.test.ts`.
Discovery and TAR numeric validation live in `tests/core/discovery.test.ts` and `tests/main/updater-archive-numbers.test.ts`.
The audit retains the boundary-level refusal to confirm an update using replacement metadata alone.
The standalone SDK identity experiment, simpler startup/recovery reproductions and duplicate discovery/archive cases are omitted.
A7-A11, including `a9-attempt-numbering.test.ts`, are implemented, locally verified and independently reviewed; signed packaged acceptance remains pending.
The A13 reserved control admission and its session-protocol cases (formerly `gates.test.ts` and `pending/protocol.test.ts`) were removed with the session protocol itself.
The combined-source review run passed 591 unit/integration tests and all 32 explicit audit tests.
No production correction was needed; the suspected dispatch-window finding was withdrawn after pinned-source tracing and runtime probes.
That combined review is historical: a later direct review found native-signal and executable-access gaps.
Their direct corrections are documented in [the boundary-correction checkpoint](../README.md#direct-review-boundary-corrections), with evidence under `.cache/review-boundary-fixes/20261104T184453Z/`.
The later [updater validation record](../UPDATER-VALIDATION.md) reports unresolved packaged acceptance failures.
The A8 fixture here tests JavaScript wiring, not OS signal delivery.
Actual dirty/blocked-window signals and signed permission mutations are separate explicit suites documented in `tests/README.md`.

Run all remaining audit supplements:

```sh
bun test tests/audit
```

Do not mark findings green by weakening assertions, skipping, or accepting the defective behavior.
Each reproduction asserts the intended contract.
A passing targeted case does not establish independent source review or packaged acceptance.
