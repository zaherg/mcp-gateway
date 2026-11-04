# Audit remediation reproduction suite

This directory holds deterministic reproductions for the A1-A13 findings from
the src audit at HEAD `9bcb74a`.
A1 was fixed in `ad4722a`.
The current source scope is A2-A6 plus prerequisite A12.
Their audit cases supplement the maintained regressions in the default core/main suites.
The `pending/` directory retains its original layout and therefore contains both corrected and still-open findings.
A7-A11 and A13 remain outside scope, including `a9-attempt-numbering.test.ts`.
Those unfixed reproductions remain explicitly failing and are not part of the default green suite.

Run in-scope tests:

```sh
bun test tests/audit/a1-login-lifetime.test.ts \
         tests/audit/a12-bounded-inspection.test.ts \
         tests/audit/gates.test.ts
bun test tests/audit/pending -t 'A[23456]:'
```

Run the still-open reproductions:

```sh
bun test tests/audit/a9-attempt-numbering.test.ts
bun test tests/audit/pending -t 'A(7|8|10|11|13):'
```

Do not mark pending findings green by weakening assertions, skipping, or
accepting the current behavior. Each pending test documents the exact current
failure and the intended contract in its assertion message and comments.
