# Audit remediation reproduction suite

This directory holds deterministic reproductions for the A1-A13 findings from
the src audit at HEAD `9bcb74a`. The suite is split by authorization status:

- `a1-login-lifetime.test.ts`, `a9-attempt-numbering.test.ts`, and
  `a12-bounded-inspection.test.ts` are in-scope for P1. They must fail on the
  unchanged baseline and become passing maintained regressions after the
  authorized corrections.
- `pending/` contains faithful reproductions for findings that are out of scope
  for the current authorization (A2-A8, A10-A11, A13). These tests stay visibly
  failing when explicitly replayed; they are not part of the default green
  suite.

Run in-scope tests:

```sh
bun test tests/audit/a1-login-lifetime.test.ts \
         tests/audit/a9-attempt-numbering.test.ts \
         tests/audit/a12-bounded-inspection.test.ts
```

Run pending reproductions:

```sh
bun test tests/audit/pending
```

Do not mark pending findings green by weakening assertions, skipping, or
accepting the current behavior. Each pending test documents the exact current
failure and the intended contract in its assertion message and comments.
