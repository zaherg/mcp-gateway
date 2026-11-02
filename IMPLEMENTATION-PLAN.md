# MCP Gateway implementation plan

## Status and scope

F1-F5 are implemented and locally verified as of 2026-11-02.
The user separately authorized F4-F5 with the implementer agent; the approved handoff is recorded in `.cache/review-f4-f5/IMPLEMENTER-BRIEF.md`.
Finding numbers below match the latest `src/` review report, not earlier versions of this plan.
Shipping, signing, installation, and Git changes remain unauthorized.
The combined five-fix independent review and final isolated native verification passed.

Assumed load: one desktop user with a few simultaneous LAN clients.
Preserve the existing authentication, network restrictions, configuration formats, credential isolation, and cleanup ownership contracts described in `README.md`.
Use synthetic backends and project-local test data; do not access real Bear notes or expose private diagnostics in test output.
Dependency upgrades, vendor edits, platform ports, signing, installation, publishing, and Git changes are outside this plan.

## Issue list

| Finding | Issue | Review group | Status |
| --- | --- | --- | --- |
| F1 | Copied connection settings can use an obsolete endpoint | Must fix | Complete locally |
| F2 | Valid streamed backend replies fail | Must fix | Complete locally |
| F3 | Settings remain editable after Quit starts | Must fix | Complete locally |
| F4 | Stalled hostname checks block shutdown | Should fix | Complete locally |
| F5 | Connection limits do not bound unfinished backend work | Should fix | Complete locally |

F1-F3 were fixed first; F4-F5 followed under separate authorization, retaining the report's order.
One implementation writer handled the shared controller, adapter, and regression-test changes.

## F1: Copied connection settings can use an obsolete endpoint

Source: `src/core/controller.ts:88-108` and `260-273`; clipboard consumers in `src/main/service.ts:185-209`.
Tests: `tests/core/controller.test.ts`, `tests/main/service.test.ts`, and existing shutdown regressions.

After a listener error closes ingress internally, the controller retains that object for cleanup.
Saving another port updates the configuration, but stopped snapshots still prefer the old listener's server list.
The review reproduction saved a new port and added server; copying returned the old port and the added server was absent from the snapshot.

- [x] Add a failing regression that starts the gateway, triggers a synthetic listener self-close, and saves changed connection settings while stopped.
- [x] Derive stopped server metadata from the current configuration, using ingress snapshots only while the listener is running.
- [x] Preserve ownership of any outstanding ingress cleanup; changing snapshot selection must not discard the cleanup reference.
- [x] Cover changed port/token, added and removed servers, both clipboard actions, and subsequent restart.
- [x] Rerun cleanup-retry tests to confirm that replacement listeners remain blocked until old resources finish closing.

Done when stopped snapshots and copied settings exactly match the saved configuration after listener self-closure, without losing cleanup ownership.

Implemented by restricting ingress snapshot selection to a running listener; cleanup references remain untouched.
Both controller and clipboard regressions failed before the correction, and delayed-cleanup coverage now includes listener self-closure.

## F2: Valid streamed backend replies fail

Source: `src/core/adapter.ts:202-228` and its pinned `UpstreamModernChild` integration.
Tests: `tests/core/ingress.test.ts`, `tests/regressions/adapter.test.ts`, and the synthetic HTTP fixture.

Ordinary modern HTTP replies use an inherited server-sent event (SSE) parser that does not recognize carriage-return-only event boundaries.
Through the real loopback gateway, a valid CR-only reply returned `MCP server process failed`, while equivalent LF and CRLF replies succeeded.
Discovery already uses the installed event-stream parser, but ordinary tool replies do not.

- [x] Add a failing HTTP integration test with identical modern tool results encoded using LF, CRLF, and CR-only event boundaries.
- [x] Use the existing event-stream parser at the ordinary upstream reply boundary without adding a dependency or modifying vendor files.
- [x] Cover multiline data, split network chunks, empty priming events, and malformed or truncated replies.
- [x] Preserve JSON replies, discovery behavior, response flow control, cancellation, continuation handling, and sanitized errors.
- [x] Verify that configured upstream credentials remain isolated from incoming client authorization.

Done when equivalent valid JSON and SSE replies produce the same exact tool result through the gateway, and invalid replies fail without leaking diagnostics or retaining resources.

Only `LeasedUpstream.events()` is overridden, using the installed parser with incremental newline normalization and UTF-8 decoding.
Inherited JSON/message validation, header handling, read ownership, cancellation, and per-chunk flow-control waits remain in place.
Tests cover completed and held-open streams, byte-split UTF-8, empty priming events, malformed JSON/messages, unterminated events, disconnect/shutdown cleanup, exact results, and CR-only continuations.

## F3: Settings remain editable after Quit starts

Source: `src/mainview/App.tsx:406-428` and `706`; save refusal in `src/main/service.ts:159-162`.
Tests: `tests/components/quit-editing.component.tsx`, existing `tests/components/App.component.tsx` regressions, `tests/main/service.test.ts`, and `tests/e2e/app.e2e.ts`.

Quit changes lifecycle state without setting the workspace's `busy` flag.
A component reproduction changed the port while Quit was pending, then reached Save, which the native service refused because cleanup had started.
Editing remains available after cleanup failure even though the controller cannot accept further configuration saves.

- [x] Add failing tests that attempt settings, raw-document, and server-dialog changes while Quit is pending and after cleanup fails.
- [x] Prevent configuration mutations once shutdown begins, including actions in dialogs already open when native Quit is requested.
- [x] Keep Logs, existing draft selection/copying, and Retry Quit available.
- [x] Preserve dirty-draft confirmation and cancellation before shutdown begins; a refused Quit request that leaves lifecycle state idle must not permanently disable editing.
- [x] Verify delayed cleanup, failed cleanup, retry, and renderer recreation without a gateway snapshot.
- [x] Inspect rendered desktop and narrow layouts, keyboard access, focus, and disabled/read-only states.

Done when no new unsavable edits can be created during shutdown, while users can still inspect diagnostics, copy retained drafts, and retry failed cleanup.

Text controls remain selectable and read-only; mutating actions, selectors, and switches are disabled and mutation handlers are guarded.
Open dialogs retain their fields, close/cancel stays available, and focus returns to configuration recovery when the opener is disabled.
Logs remain accessible without a gateway snapshot, and Retry Quit does not repeat the pre-shutdown dirty-draft confirmation.
Initial or unacknowledged Quit state stays locked until a fresh lifecycle response establishes whether editing is allowed.
Independent review found the lost-acknowledgement case; both component and real-service browser regressions now cover it, including rejection of stale idle polls.

## F4: Stalled hostname checks block shutdown

Source: `src/core/network.ts:70-79`; serialized validation and shutdown in `src/core/controller.ts` and `src/main/service.ts`.
Tests: `tests/core/network.test.ts`, `tests/core/controller.test.ts`, and `tests/core/shutdown.test.ts`.

Self-proxy validation awaits hostname resolution without an application deadline while holding the controller's operation queue.
Stop and Quit wait behind that validation.
With one injected stalled resolver during a save, Quit remained pending and the listener remained running after 8.5 seconds.
This reproduction used a controlled resolver, not a real network outage.

- [x] Add a failing stalled-resolver regression through the controller save and shutdown paths.
- [x] Bound the overall validation wait rather than multiplying an unrestricted wait across configured servers.
- [x] Allow Stop and Quit to cancel pending validation instead of waiting for hostname resolution to return.
- [x] Reject timed-out or cancelled validation without writing configuration, replacing listeners, or applying a late resolver result.
- [x] Test successful resolution, timeout, cancellation, delayed completion, and multiple same-port upstreams.
- [x] Preserve rejection of actual self-targets, wildcard destinations, mapped addresses, empty answers, and failed lookups.

Done when hostname resolution cannot indefinitely delay shutdown, late results cannot change state, and self-proxy checks remain fail-closed.

Implemented with a cancellable `SelfProxyOptions` boundary (`resolve`, `signal`, absolute `deadline`) and `SELF_PROXY_DEADLINE_MS = 5_000`:

- One deadline bounds every relevant same-port upstream lookup in an operation, instead of an unrestricted timeout per hostname.
  It starts when the operation begins validating, so queue waiting is not charged to the DNS budget.
  Cancellation and an expired deadline are refused at operation entry, including stdio-only, disabled and different-port configurations that need no lookup.
- A lookup is raced against the operation deadline and its cancellation signal.
  Timers and abort listeners are removed on every outcome; a late fulfillment or rejection is observed even when the wait is already cancelled, and cannot change an invocation that already refused.
  The signal and shared deadline are checked again after the awaited lookup before any candidate is accepted.
- Timeout stays fail-closed as `NetworkPolicy`.
  Cancellation uses the additive `Cancelled` code, does not become a configuration error, and does not stop the listener by itself.
- Controller operations capture their validation lifetime when requested, so a Stop cancels validation queued before it, while a later explicit Start or save may start a fresh lifetime; close remains terminal.
  `stop()` and `close()` cancel before waiting for the controller queue.
- An external refresh validates the candidate before publishing its document/revision.
  A cancelled refresh leaves document and config consistent, so the next Start revalidates the external candidate instead of reopening the previous token/routes; non-cancellation parse/network errors still publish the raw source for UI repair.
- A watcher event captures its validation lifetime when the watch callback admits it, before debounce and the controller queue.
  A pre-Stop event cannot obtain a fresh uncancelled lifetime later; a genuinely delivered later event may validate anew.
- `AppService` captures a controller operation when a save/start/restart request is admitted, before it waits on the service queue.
  Work requested before Stop cannot capture a fresh lifetime when its turn arrives; work requested after Stop can.
  Invalid parameters still cause no cancellation.
- `AppService` runs validated `stop`, `quit`, and `quitStatus` on a narrow nonserialized lifecycle lane.
  Invalid parameters are rejected before any cancellation or native Quit.
  Normal save/start/restart serialization remains, and a save that persisted just before Quit began does not touch a login library native cleanup may have released.
- Controller, ingress open/reconcile/restart all use the same per-operation control, including the injected test resolver.

Expected red results are in `f4-red-controller.log` and `f4-red-service.log`: Stop and Quit waited behind a stalled resolver.
The recovery regressions are `f4-gap-network-red.log`, `f4-gap-controller-red.log`, and `f4-gap-service-red.log`: no-hostname cancellation was not refused, an already-cancelled rejected lookup was unobserved, a deadline was not rechecked after the wait, a queued stdio-only save persisted after Stop, and queued service work persisted or reopened the listener.
Review corrections are red in `review-fix-refresh-watcher-red.log` (a cancelled external refresh reopened the old token/routes; a queued watcher started a fresh lookup, delaying Stop or validating after it).
Green runs are `review-fix-refresh-watcher-green.log`, `f4-gap-network-green.log`, `f4-gap-controller-green.log`, `f4-gap-service-green.log`, `f4-f5-recovery-focused.log`, `review-fixes-focused-final.log`, `f4-green-focused.log`, `f5-green-focused.log`, and `unit-review-fixes-final.log`.
Limits: DNS lookup itself is not cancellable, so the application abandons the wait and ignores later settlement.
A Stop does not roll back an atomic save that committed after validation.
The 5-second production deadline was exercised end to end once; other timeout tests use a shorter injected deadline.

## F5: Connection limits do not bound unfinished backend work

Source: `src/core/ingress.ts:299-308` and established-session handling in `src/core/adapter.ts`.
Tests: `tests/core/ingress.test.ts`, `tests/core/resource-admission.test.ts`, `tests/core/backend-work.test.ts`, `tests/regressions/backend-work.test.ts`, and `tests/regressions/adapter.test.ts`.

The ingress limits open HTTP requests to 32 and releases each request slot when its response finishes or closes.
An established-session backend call can continue after that response closes.
One synthetic session accepted 40 disconnected calls and reported all 40 still running.
The existing backend-resource limit bounds processes and transports, not unfinished calls inside a session.

- [x] Add a failing integration test that disconnects response streams while synthetic backend calls remain outstanding.
- [x] Add a shared bound on unfinished backend calls, separate from the existing HTTP-request and backend-resource limits.
- [x] Retain each work slot until a reply, explicit protocol cancellation, or session cleanup confirms that the call has ended.
- [x] Do not interpret every network disconnect as cancellation; preserve supported session and continuation behavior.
- [x] Keep cancellation and cleanup reachable at capacity so clients can release outstanding work.
- [x] Test multiple sessions/endpoints, admission at the limit, rejection above it, renewed admission after completion, and cleanup after backend failure or shutdown.

Done when repeated disconnects cannot accumulate unbounded unfinished calls, while existing process ownership, sibling isolation, cancellation, and continuation tests remain passing.

Implemented with `MAX_BACKEND_CALLS = 16` and one authoritative ledger in the new `src/core/backend-work.ts`:

- One `BackendCalls` ledger per ingress is shared by every endpoint and session, separate from the unchanged 32-open-HTTP-request and 16-backend-resource limits.
- Legacy sessions admit at the validated `PeerFactory` boundary, before dispatch.
  A duplicate in-flight client id is rejected before inherited `StatefulSessions.post`/SDK dispatch, using the installed SDK request validation and the pinned session transport map, with HTTP 400 and the standard `-32600` error, so its progress token cannot enter session bookkeeping.
- Per established transport, bounded in-dispatch request-ID claims close the batch and concurrent-post race: the complete single or legacy batch is parsed with the installed `JSONRPCMessageSchema`; request IDs are collected; active wire IDs, existing claims and duplicates within the payload are checked synchronously; any collision rejects the whole HTTP payload with HTTP 400/`-32600` and dispatches none.
  Otherwise all IDs are claimed with no intervening await, inherited `sessions.post` runs, and only this invocation's claims are released in `finally`.
  Notifications and client responses consume no claims; malformed bodies and unknown sessions/initialization keep the inherited SDK paths.
  The peer-level fallback remains a fail-closed safety net, not the normal race path.
- Each admitted request receives a monotonic backend-facing wire id from `BackendWireIds`; only active client-id/wire-id mappings are retained.
  Replies are translated back to the client id, and a late reply for a cancelled or reused id is dropped rather than settling newer work.
  Wire ids are never reused and allocation refuses explicitly at its bound.
- Nonduplicate capacity and wire-id-exhaustion refusals are delivered through the inherited `owner.message` path using the original client id, so the session settles its pending request/progress entry without touching unrelated admitted work; a raw `transport.send` bypassed that settlement.
- A forwarded `notifications/cancelled` translates its `requestId`, forwards first, and releases its own mapping and slot only after the forward succeeds.
  A failed forward keeps the charge.
  An id this peer never forwarded is not forwarded unchanged, because it could name a different wire id.
- Server-originated requests, client responses to them, progress tokens, and result/argument data pass through untouched.
- Legacy terminal output is validated with the installed SDK result/error response schemas and a numeric wire-id match before its mapping or work slot is consumed.
  Malformed objects, null, primitives, no-result/no-error and both-shape envelopes are ignored with a fixed payload-free local diagnostic; the reservation remains until a valid reply, explicit cancellation, or confirmed cleanup.
  Valid late/unmapped replies are still ignored.
- The synthetic fixture now records the backend-facing wire id separately from the test marker.
  Regression assertions check that legacy wire ids differ from original ids, are unique, are never 0, distinguish number `0` from string `"0"`, use a new wire id for a reused original id, and leave modern ids unremapped.
  Assertions were strengthened, not weakened.
- Modern requests admit at the HTTP admission boundary (HTTP 429 with the fixed application error) and own one reservation each.
  A terminal reply for that request releases it; otherwise only its own child's confirmed cleanup does.
  A retained continuation handle is not consumed by a refusal, and a disconnected request keeps its slot until its child cleanup fulfils.
- Cleanup release uses `releaseAfterCleanup`, so a pending or rejected owned stop keeps its work charged.
- The capacity error is application code `1001`, outside the legacy reserved server-error range; the duplicate error is `-32600`.
  Tests assert the literal codes and messages, not only equality to the imported constants.

These supervisor-approved refinements are recorded here: narrow legacy remapping at the existing `PeerFactory` seam rather than a broad protocol rewrite, duplicate-ID refusal before dispatch, application code `1001` with HTTP 429 where the HTTP boundary still owns the response, and the documented protocol-outstanding limit below.

Expected red results are in `f5-red.log` (the old code dispatched the seventeenth disconnected call), `f5-remap-red.log` (a duplicate received a capacity error instead of `-32600`), and `f5-remap-late-red.log` (a cancelled request's late reply released work that reused its id).
Review corrections are red in `review-fix-adapter-red.log` (a duplicate returned HTTP 200, capacity refusals left session state that broke later server-originated routing, and malformed no-result/both envelopes released work).
Closure corrections are red in `duplicate-closure-red.log` (one-element batch duplicate admitted with 200; within-batch duplicates dispatched; concurrent duplicate passed the single-object gate before wire registration).
Green runs are in `duplicate-closure-green.log`, `duplicate-closure-focused.log`, `duplicate-closure-focused-final.log`, `review-fix-adapter-green.log`, `review-fix-refusal-green.log`, `review-fix-f5-regressions-green.log`, `f5-green-focused.log`, `review-fixes-focused-final.log`, and `unit-duplicate-closure-final.log`.
Limits: cancellation and replies bound protocol-outstanding calls; an upstream that ignores cancellation may still run physically until confirmed cleanup, which is not treated as a protocol violation or correlated here.
A hard process-cleanup rejection was not injected at the peer boundary; the release-only-after-confirmed-cleanup policy is covered by `releaseAfterCleanup` unit tests and delayed-cleanup integrations.
Modern traffic is deliberately not remapped: per-request owners and discarded children already isolate it.

## Verification and completion

The review baseline passed type checking, lint, 15 browser tests, 33 component tests, and 136 unit/integration tests with 1,658 assertions.
The five findings came from separate targeted reproductions; these passing suites do not establish that the issues are fixed.
The review itself added no permanent regression tests or implementation changes.
The following results cover the subsequent authorized F1-F3 implementation only.

- [x] Demonstrate failing F1-F3 regressions before correction and passing results afterward.
- [x] Run focused tests incrementally, then `bun run test:e2e`, `bun run test:components`, and `bun run test:unit` on the final source.
- [x] Run `bun run typecheck`, `bun run lint`, and applicable LSP diagnostics.
- [x] Inspect rendered F3 behavior and verify keyboard, focus, draft-copying, Logs, and Retry Quit access.
- [x] Verify native lifecycle behavior using separately rooted project-local development builds, isolated data, and synthetic MCP sessions; keep actual login registration disabled.
- [x] Obtain bounded independent review of F1-F3, their lifecycle boundaries, and regression assertions; resolve the lost-acknowledgement finding and obtain closure review.
- [x] Record checks, failures, skipped checks, and remaining limits before marking F1-F3 complete.
- [x] Stop owned test processes and verify protected release artifacts, assets, and dependency files remain byte-identical.
- [x] Demonstrate failing F4-F5 regressions, then passing focused and full local suites after authorization.
- [x] Complete parent-owned isolated native verification of the combined source.
- [x] Obtain the combined five-fix independent review and resolve all findings.

### F1-F3 verification record

Evidence is retained under `.cache/review-f1-f3/`.

| Check | Final result | Evidence |
| --- | --- | --- |
| Playwright real-service browser tests | 20 passed | `e2e-accepted.log` |
| React component tests | 41 passed across 3 files | `components-accepted.log` |
| Bun unit/integration/regression tests | 152 passed, 1,828 assertions | `unit-accepted.log` |
| Type checking | Passed | `typecheck-accepted.log` |
| Biome lint | Passed across 78 files | `lint-accepted.log` |
| Biome LSP diagnostics | Zero across 13 affected files; zero on the final 3-file correction | Tool results |
| Isolated macOS development build | Passed | `build-accepted.log` |
| Native runtime smoke | Fresh, JSON synthetic, JSONC synthetic, and SIGTERM scenarios passed | `native-accepted.log` |
| Independent closure review | No remaining F1-F3 issues found | `independent-closure.md` |

The final development bundle is `build/review-f1-f3-final/dev-macos-arm64/MCP Gateway-dev.app`.
Native evidence is under `.cache/review-f1-f3/native-final/dev-1793633314752/`.
Native checks covered real renderer RPC, retained state/logs and synthetic sessions across window recreation, app-local Cocoa Cmd+W/Cmd+Q, SIGTERM, and owned-process cleanup.
Desktop and 390-pixel-wide screenshots were inspected, including selectable drafts, disabled actions, dialog scrolling, Cancel, and Retry Quit.
Browser copying was verified through the keyboard copy event without replacing the user's system clipboard.
A fresh narrow viewport and DOM bounds check confirmed one application shell and one brand after resized captures showed repeated image regions; evidence is `fresh-mobile-viewport.png` and `visual-layout.json`.

Expected red failures are retained in `f1-red.log`, `f2-red.log`, `f3-red.log`, and `f3-lost-ack-red.log`.
During test development, role-query typing and synthetic opener focus were corrected.
An added end-of-dialog Tab-wrap assertion failed in three browser cases; an isolated native Chrome dialog reproduced focus moving to browser chrome before returning to the dialog.
The tests now assert exact internal forward/reverse focus order, disabled-control skipping, Escape, and fallback focus rather than imposing a different browser wrap policy.
All final suites passed without retries; no unresolved test flakiness was observed.
The first closure-review resume call rejected a misplaced output parameter before launching; the corrected call completed normally.

No physical keyboard/trackpad, actual login registration, second-device LAN, native Linux/Windows, prolonged-load, or signed-release checks were performed for the F1-F3 change.
Delayed/failed cleanup UI and lost acknowledgements were exercised through component and real-service browser tests, not injected into the packaged native runtime.
Vendor files, package versions, lockfile, release artifacts, external configuration, user applications, and real Bear data were not changed by that work.
Generated browser evidence was kept in the local evidence directory; pre-existing tracked browser screenshots were restored after testing.
An unrelated staged deletion of `RELEASE.md` appeared during execution and was left untouched.
No commit, push, signing, installation, or publication was performed.

### F4-F5 verification record

Focused runs were performed for each implementation, and the combined focused set and full suites were rerun after the approved legacy ID remapping.
Evidence is retained under `.cache/review-f4-f5/`.

| Check | Final result | Evidence |
| --- | --- | --- |
| Combined focused F4/F5/ingress/regression tests after duplicate closure | 112 passed, 1,245 assertions | `duplicate-closure-focused-final.log` |
| Duplicate-admission closure regressions | 4 adapter tests red then green; 35 focused tests, 548 assertions | `duplicate-closure-red.log`, `duplicate-closure-green.log`, `duplicate-closure-focused.log` |
| Combined focused F4/F5/ingress/regression tests after review corrections | 108 passed, 1,206 assertions | `review-fixes-focused-final.log` |
| Review-correction red evidence | External refresh reopened old routes; queued watcher escaped Stop; duplicate returned 200; refusals broke routing; malformed envelopes freed work | `review-fix-refresh-watcher-red.log`, `review-fix-adapter-red.log` |
| Review-correction focused red/green | 5 adapter tests, 3 controller tests, plus full F4/F5 focused set | `review-fix-*-green.log`, `review-fix-f5-regressions-green.log` |
| Combined focused F4/F5/ingress/regression tests after recovery | 100 passed, 1,129 assertions | `f4-f5-recovery-focused.log` |
| F4 recovery gap tests | Network 3, controller 1, service 1 red then green | `f4-gap-*-red.log`, `f4-gap-*-green.log` |
| F5 remapping verification | 13 passed, 169 assertions; wire-vs-original assertions strengthened | `f5-remap-verified.log` |
| F4 focused unit/integration/regression tests (first pass) | 63 passed, 577 assertions | `f4-green-focused.log` |
| F5 focused unit/integration/regression tests (first pass) | 71 passed, 825 assertions | `f5-green-focused.log` |
| Bun unit/integration/regression tests (duplicate closure) | 190 passed, 2,196 assertions across 21 files | `unit-duplicate-closure-final.log` |
| React component tests (duplicate closure) | 41 passed across 3 files | `components-duplicate-closure-final.log` |
| Playwright real-service browser tests (duplicate closure) | 20 passed | `e2e-duplicate-closure-final.log` |
| Bun unit/integration/regression tests (review corrections) | 186 passed, 2,157 assertions across 21 files | `unit-review-fixes-final.log` |
| React component tests (review corrections) | 41 passed across 3 files | `components-review-fixes-final.log` |
| Playwright real-service browser tests (review corrections) | 20 passed | `e2e-review-fixes-final.log` |
| Bun unit/integration/regression tests (recovery) | 178 passed, 2,080 assertions across 21 files | `unit-recovery-final.log` |
| React component tests (recovery) | 41 passed across 3 files | `components-recovery-final.log` |
| Playwright real-service browser tests (recovery) | 20 passed | `e2e-recovery-final.log` |
| Type checking | Passed | `bun run typecheck` |
| Biome lint | Passed across 81 files | `bun run lint` |
| F4 red evidence | Stop/Quit blocked behind a stalled resolver; no-hostname cancellation was not refused; rejected pre-cancelled lookup was unobserved; no post-wait deadline recheck; queued stdio-only save persisted; queued service work persisted/reopened; cancelled external refresh reopened old routes; queued watcher escaped Stop | `f4-red-*.log`, `f4-gap-*.log`, `review-fix-refresh-watcher-red.log` |
| F5 red evidence | The old code dispatched the seventeenth disconnected call; remapping probes failed; duplicate returned 200; capacity refusals broke later routing; malformed envelopes freed work; batch and concurrent duplicates bypassed the single-object gate | `f5-red.log`, `f5-remap-*.log`, `review-fix-adapter-red.log`, `duplicate-closure-red.log` |
| Protected inputs | Release artifacts, assets, dependency files, vendor files, and the staged `RELEASE.md` deletion unchanged | `baseline-sha256.json` comparison |
| Parent type checking and lint (accepted source) | Passed; lint checked 81 files | `typecheck-accepted.log`, `lint-accepted.log` |
| Parent Biome LSP diagnostics | Zero across 16 affected files, with all subsequent source/test corrections rechecked | Tool results |
| Parent isolated macOS development build (pre-review source) | Passed | `build-parent.log` |
| Parent native runtime smoke (pre-review source) | Fresh, JSON synthetic, JSONC synthetic, and SIGTERM scenarios passed | `native-parent.log` |
| Parent isolated macOS development build (accepted source) | Passed | `build-accepted.log` |
| Parent native runtime smoke (accepted source) | All four scenarios passed | `native-accepted.log` |
| Combined independent closure review | No remaining issues found; prior findings closed | `independent-accepted.md` |
| Final verification integrity | Source unchanged during checks; 20 protected files byte-identical; no owned test processes remain | `acceptance-integrity.json` |

The final combined development bundle is `build/review-f4-f5-accepted/dev-macos-arm64/MCP Gateway-dev.app`.
Native evidence is under `.cache/review-f4-f5/native-accepted/dev-1793641894738/`.
The packaged checks used isolated data and synthetic MCP sessions, kept login registration disabled, and verified renderer RPC, state/log retention, window recreation, app-local Cocoa Cmd+W/Cmd+Q, SIGTERM, and owned-process cleanup.
The initial implementer run reached its 30-minute limit with partial changes retained; recovery resumed the same agent after source, artifact, and process checks.
The recovery completed the ID-remapping refinements and additional F4 queue/cancellation regressions before rerunning its full suites.
Independent review identified four F4/F5 gaps, which received failing regressions before correction.
Closure review then identified the remaining batch/concurrent duplicate-admission gap; per-transport claims and controlled-race regressions corrected it.
Final closure review found no remaining issues.
The accepted source passed the complete local suites, parent static/LSP checks, a separately rooted development build, and all four isolated native scenarios.
Earlier native evidence remains labelled as pre-review source.
No source changes occurred during final verification, and all 20 protected artifact, asset, package, and lock files remain byte-identical.
The unrelated staged deletion of `RELEASE.md` was preserved.

The implementation added `src/core/backend-work.ts`, `tests/core/backend-work.test.ts`, and `tests/regressions/backend-work.test.ts`; the synthetic fixture gained opt-in call markers and a late-reply-on-cancel mode.
Tracked browser screenshots were restored byte-for-byte from the starting baseline after the browser run, and the retained F1-F3 evidence directory was restored from a local copy.
One existing HTTP-admission regression was updated to fill the 32-request limit with 16 in-flight calls plus one listening stream per session, because backend work is now independently bounded at 16; the HTTP limit itself is unchanged and still asserted.

F4-F5 limits and unverified areas:

- DNS resolution remains uncancellable; only the application's wait is bounded and late settlement is ignored.
- Protocol cancellation bounds protocol-outstanding work, not physical work inside an upstream that ignores cancellation; confirmed cleanup remains the ownership gate.
- A hard process-cleanup rejection was not injected at the peer boundary.
  The ledger policy is covered by `releaseAfterCleanup` unit tests, delayed-cleanup integrations, backend-failure release, and shutdown cleanup.
- Wire-ID exhaustion is effectively unreachable at the production bound; it is covered by a small-limit unit test.
- The per-transport in-dispatch claims close duplicate admission across single posts, batches and concurrent posts before SDK state changes; the peer-level fallback remains only as a fail-closed safety net.
- No dedicated socket-disconnect regression was added for the new in-dispatch claims.
  Review inspected their unconditional `finally` and pinned transport cleanup; existing disconnect/cancellation regressions remain passing.
- No signed build, physical input, actual login cycle, second-device LAN, native Linux/Windows, or prolonged-load verification was performed for F4-F5.
- Native macOS smoke covered normal packaged lifecycle paths; injected DNS stalls and capacity/failure cases were covered by local integration tests.
- No commit, push, signing, installation, or publication was performed.
