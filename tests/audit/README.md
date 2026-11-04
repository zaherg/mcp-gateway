# Audit remediation reproduction suite

This directory holds deterministic reproductions for the A1-A13 findings from
the src audit at HEAD `9bcb74a`.
A1 was fixed in `ad4722a`.
A2-A6 plus prerequisite A12 completed their earlier source and packaged verification.
A13 is locally source-verified and independently reviewed; signed packaged acceptance remains pending.
These audit cases supplement the maintained regressions in the default core/main suites.
The `pending/` directory retains its original layout; the directory name does not indicate current status.
A7-A11, including `a9-attempt-numbering.test.ts`, are implemented, locally verified and independently reviewed; signed packaged acceptance remains pending.
The earlier A13 run's A11 fixture failure was corrected without weakening its expected size refusal.
The combined-source review run passed 591 unit/integration tests and all 32 explicit audit tests.
Its two new pipelined cancellation regressions are in the default core suite.
No production correction was needed; the suspected dispatch-window finding was withdrawn after pinned-source tracing and runtime probes.
That combined review is historical: a later direct review found native-signal and executable-access gaps.
Their direct corrections and current acceptance limits are recorded in `IMPLEMENTATION-PLAN.md` and `.cache/review-boundary-fixes/20261104T184453Z/`.
The A8 fixture here tests JavaScript wiring, not OS signal delivery.
Actual dirty/blocked-window signals and signed permission mutations are separate explicit suites documented in `tests/README.md`.

Run in-scope tests:

```sh
bun test tests/audit/a1-login-lifetime.test.ts \
         tests/audit/a12-bounded-inspection.test.ts \
         tests/audit/gates.test.ts
bun test tests/audit/pending -t 'A([23456]|13):'
```

Run the other audit cases explicitly:

```sh
bun test tests/audit/a9-attempt-numbering.test.ts
bun test tests/audit/pending -t 'A(7|8|10|11):'
```

Do not mark findings green by weakening assertions, skipping, or accepting the defective behavior.
Each reproduction asserts the intended contract.
A passing targeted case does not establish independent source review or packaged acceptance.
