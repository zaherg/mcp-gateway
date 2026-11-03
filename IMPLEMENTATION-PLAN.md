# MCP Gateway implementation plan

## Next feature: automatic updates and manual checks

Status: both requested local gates are complete; independent source and packaged acceptance reviews are clear.
The implementation is based on release `v0.3.0` at `f96f016`.
The user authorized the application-level updater implementation, project-local signed acceptance, and Apple notarization in `.cache/auto-update-0.3.1/IMPLEMENTATION-RESTART.md`.
The authoritative package version is now `0.3.1`.
The unchanged-SDK storage-limit gate passed local native acceptance on 2026-11-03.
Independent combined-source review completed on 2026-11-03 and blocked source closure with findings R1-R16, recorded below.
The user subsequently authorized all R1-R16 corrections and explicitly selected source fixes, regression tests and independent closure only.
R1-R16 source corrections are implemented locally under `.cache/auto-update-0.3.1/remediation-r1-r16/BRIEF.md`, including SDK path APIs without moving existing configuration.
Seven follow-ups from the first closure review were completed directly after the user stopped delegation.
The final corrections received focused self-review before the current request.
The user now authorizes final independent review, followed by rebuilding, signing, notarizing and stapling `0.3.1` and testing isolated two-version replacement and failure/recovery cases.
Source closure completed before packaged execution.
Earlier signed artifacts predate the latest corrections and are intermediate evidence only.
Git operations, publication, installed-app replacement, and external configuration changes remain unauthorized.
The completed F1-F5 remediation record below remains unchanged.

### Final acceptance run

Evidence is retained under `.cache/auto-update-0.3.1/final-acceptance/`.
Fresh read-only reviewers covered security/storage, transaction/lifecycle, and UI/release acceptance after the direct corrections.
Production source closure is clear in `security-closure.txt`, `closure-review.task-2.txt` and `independent-review.task-3.txt` under this run's evidence directory.
Acceptance-script closure is clear in `acceptance-final-review.txt`.
The final independent evidence review is clear in `artifact-review.txt`, with no issues found and local-only verification limits retained.
The supervisor performs corrections and packaged execution directly; this request does not authorize implementation delegation.
Baseline hashes cover the current source, package/lock, assets and published artifacts.
Builds and fixtures use separate project-local paths; published artifacts, installed applications and external configuration remain untouched.
The earlier native failure matrix requires explicit outcome assertions and checked cleanup before reuse.
A private target version is acceptance-only and does not change the authoritative `0.3.1` package or authorize publication.

The new review found unsafe cleanup through directory symlinks, update admission before startup reconciliation, and stale worker registration after settlement uncertainty.
Corrections share directory admission across preparation, abandoned cleanup and live-owner candidate disposal; reject early update work; complete initialization on eventual renderer readiness; and durably clear absent worker registration before readiness.
Regression tests include external-byte/journal preservation, live-owner Quit, exited-owner cleanup, delayed startup wiring, coalesced initialization, exact worker settlement and failed persistence.
All 439 Bun tests with 3,242 assertions, 54 component tests, 20 browser tests, root/private types, lint and scoped LSP checks pass.
Private-hook regressions cover failed HTTP prerequisites, partial-download evidence, journal absence, helper settlement, destination refusal and the pinned RPC timeout.
Five unchanged-SDK helper tests with 223 assertions pass using the newly signed payload.
An earlier combined unit/SDK command hit its 220-second outer limit during the final SDK case; the SDK suite subsequently completed separately with no remaining verification process.

The production rebuild is retained in `production-build/stable-macos-arm64/MCP Gateway.app`, with its three distribution files under `release-assets/`.
The initial absolute output path was refused by the build tool; project-relative output paths succeeded.
Apple accepted all three notarization submissions, and signature, stapling, Gatekeeper, complete DMG inventory, archive identity and credential-scan checks passed in `release-verification.json`.
The new DMG SHA-256 is `db0f9e6d7ed07afe3a71490d716f4fffec7d451029f464879d091ebb9ffb4c18`.
Four isolated signed-native scenarios passed with real renderer RPC, synthetic MCP traffic, window recreation and graceful cleanup.
The final private pair also passed complete signature, ticket, Gatekeeper and distribution checks in `private-a-rpc-verification.json` and `private-b-verification.json`.
Private A is `0.3.1` hash `167pb63wzaz8i`; private B is `0.3.2` hash `gax9wbr547rz`.
These loopback-feed fixtures are separate from the production distribution and are not publication targets.

All five signed product scenarios passed: normal update, manifest HTTP 503, cancellation after a nonempty partial download, cleanup failure followed by explicit retry, and renderer readiness delayed by six seconds.
Successful replacement cases require one completed startup per version, functional renderer RPC, exact confirmed transaction, an attempt-bound observation that the old backend is absent before apply, and byte-identical configuration.
Failure cases require the intended HTTP/partial-file evidence, no handoff, no active transaction, complete original-app inventory preservation and checked shutdown.
Evidence is retained under `product-success/`, `product-offline/`, `product-interrupted/`, `product-cleanup-failure/` and `product-late-start/`.
Archived run directories retain the original fixed execution paths in their records; those paths are evidence, not active recovery installations.

Seven native-helper cases passed in `native-failures/evidence.json`: successful replacement with verified recovery, moving-release payload mismatch, read-only destination, interrupted swap with manual restoration, file-size limit, literal ENOSPC in an isolated 8 MiB image, and tampered candidate refusal.
These cases use signed small synthetic applications and the helper from the final production payload.
Recoverable failures relaunch the previous version; the assertions reject target launches and preserve exact configuration and expected app inventories.
Recovery inventories explicitly account for owner-only directory modes while checking exact file bytes and modes.
The image was detached through checked mount ownership.

The first product run failed before confirmation.
Inspection found that the private renderer interaction takes longer than the pinned main-side RPC default of one second.
A regression using the unchanged RPC implementation reproduced the timeout; a fixture-only 15-second request limit passed, and the regenerated private A passed all five scenarios.
Earlier private build attempts refused a symlinked `.hutch` directory and diagnosed duplicate Swift modules through a shared-cache alias.
Private builds now copy project state and use separate compiler caches; these test-build corrections do not alter the SDK or production distribution.

`preservation.json` verifies unchanged HEAD, all 14 protected package/lock/assets/artifact files, the historical F1-F5 record, and no remaining owned verification process or mount.
No publication, Git mutation, installed-app replacement, external configuration change, real Bear access or actual login registration occurred.
Live GitHub/CDN delivery, public rollout, full-size storage exhaustion, power loss, minimum macOS, physical input and native Linux/Windows remain outside this acceptance.
Helper-wait tests establish cleanup ordering but do not establish arbitrary delayed Launch Services behavior or a complete product cancellation-after-handoff run.
The private extracted-payload launcher logged a nonfatal bootstrap install-integration `FileNotFound` warning; later handoff, replacement and target initialization were confirmed.
The self-replacing installer wrapper was not executed.

Implementation outline and earlier evidence (2026-11-03):
The component status sections below supersede earlier completion claims.
Source implementation and retained intermediate tests do not establish final release acceptance.

- `package.json` and the Electrobun build metadata now target `0.3.1`; `release.baseUrl` is set to the fixed GitHub stable feed.
- The application-side trust boundary is implemented under `src/main/updater/`: original-archive admission, safe extraction, expected Developer ID publisher and bundle identity verification, exact selected version/hash and arm64 checks, frozen candidate records, owned preparation subprocess with deadlines and process-tree termination, interrupted-staging cleanup, and a verified owner-only previous-app recovery copy.
- The unchanged pinned SDK still performs check/download preparation, but only inside the owned worker. The worker rejects non-stable identities, the wrong feed, invalid versions, and non-increasing versions before download.
- Installation is enabled only for the supported macOS stable path. `INSTALLATION_ENABLED` is `true`; `src/main/updater/apply.ts` revalidates the frozen candidate and calls the pinned SDK through an attempt-scoped handoff while lifecycle intent remains mutable until commitment. Unsupported platforms/builds remain disabled and never acquire the runtime.
- Signed project-local acceptance passed for real Developer ID verification, wrong-publisher/wrong-architecture/tampered rejection, an actual SDK download in the owned subprocess, candidate freezing/revalidation, and retained previous-app recovery.
  Evidence: `.cache/auto-update-0.3.1/updater-safety-evidence.json` and `.cache/auto-update-0.3.1/archive-real-0.3.0.json`.
- Policy and lifecycle implemented in source, pending independent closure: strict owner-only `updates.json` with default-on automatic checks/downloads, the stable-version gate, single-flight scheduling, automatic/manual check and explicit download, sanitized `UpdateStatus`, validated `updatesStatus`/`updatesCheck`/`updatesDownload`/`updatesSetAutomatic`/`updatesRestart` RPC, and explicit normal-quit versus restart-to-update lifecycle intent.
  Failed cleanup and handoff remain visible and retryable; normal Quit clears an armed update; configuration saves lock once restart handoff starts; Linux and unsupported builds remain disabled and never contact the feed.
- Settings and menu implemented in source: the Settings Updates section exposes installed/available/ready state, default-on automation, indeterminate progress, sanitized errors and retry actions, and update-specific confirmation. The macOS application and tray menus open the same main-process check path without automatically opening a background window.
- Background discovery renders a nonmodal, dismissible update notice when a window is already open; the tray label changes without stealing focus. Configuration drafts are preserved, restart requires explicit draft-discard confirmation, and open server dialogs block restart.
- Update status, progress, errors, preference failures, and restart/disabling logic use the authoritative `UpdateStatus`; unsupported platforms expose no actionable controls. Window recreation reloads the same state, and the menu signal focuses the Updates heading.
- Release verification now checks exact DMG/manifest/runtime asset names, package/manifest/payload version agreement, fixed feed metadata, wrapper/payload signatures and tickets, archive digest, and signing-secret absence. It supports distinct `MCP_GATEWAY_ARTIFACTS_DIR` and `MCP_GATEWAY_VERIFICATION_OUTPUT` paths.
- Earlier checkpoint: 298 Bun unit/integration tests with 2,587 assertions, 20 browser tests, typecheck, Biome, UI visual checks, and a product Bun bundle containing the worker entry passed.
  Current source verification is recorded in the Component 4 section; older build results do not cover later corrections.
- Prior intermediate signed, notarized, and stapled 0.3.1 deliverables were generated in isolated project-local paths under `.cache/auto-update-0.3.1/`: the wrapper app, DMG (`e05582a689dd9d2f2f0f338d9a985ec4aa1b32b256b5f9e0b9406f50ca4d5390`), update manifest, and runtime archive (`02a0c38010234665df29db41c3e456f255b0a459a6cefc38aa63e8d9c9554afd`). Signature, ticket, Gatekeeper, asset identity/version, fixed-feed, archive digest, and credential-scan checks passed in `.cache/auto-update-0.3.1/release-verification.json`; these artifacts must be rebuilt after closure review and are not final acceptance.
- The signed 0.3.1 payload passed four isolated native app scenarios with real renderer RPC, synthetic MCP calls, window recreation, Cocoa Cmd+W, Cocoa Cmd+Q/SIGTERM cleanup, and no owned child left alive. Evidence is under `.cache/auto-update-0.3.1/native-final-0.3.1/`.
- A signed packaged native replacement matrix passed for a synthetic app pair: success with one expected-version launch, byte-identical configuration, retained previous-app verification, moving-latest mismatch, read-only destination, literal ENOSPC, interrupted swap with manual recovery, write-limit failure, and invalid-candidate verifier rejection. Evidence is `.cache/auto-update-0.3.1/native-matrix.json`.
- The earlier integration enabled the macOS path and revalidated the frozen candidate before the pinned SDK apply call.
  Component 2 replaced its early-ready approval with the checked handoff protocol. The headless signed integration exercised cleanup -> handoff -> revalidation -> SDK apply, produced one 0.3.1 launch, preserved configuration bytes, and left no synthetic process. Evidence is `.cache/auto-update-0.3.1/apply-integration.json`.
- Cancellation now precedes the initial signature and metadata inspection, the AbortSignal reaches codesign/plutil/lipo child processes, post-worker freeze/extract/verify/retention publication is refused and state is discarded after cancellation, and focused regressions prove cancellation before inspection, cancellation during candidate verification, and owned verification-command child termination.
- The earlier native matrix exercised a signed product-current bundle with a signed packaged replacement fixture.
  Its product UI marker did not prove completed initialization with functional renderer RPC.
- The earlier Settings/menu product flow used private signed 0.3.1 and 0.3.2 builds, a fixed loopback feed, a synthetic MCP call and a dirty draft.
  Evidence at `.cache/auto-update-0.3.1/product-update-flow.json` predates the corrected startup/RPC assertions and cannot certify them.
  The authoritative deliverable remains 0.3.1; the private fixture versions are not publication targets.
- Public 0.3.1 publication, live GitHub delivery, physical macOS menu delivery, and installed-app rollout remain outstanding; the plan does not claim those as complete.
- Corrections to the earlier gate report: native apply does not require `/Applications`; the retained fixture recorded phase `validating`, not the reported `validating_payload`, and separately lacked the required `Contents/MacOS/launcher`; the initial validation failure is not attributed to the missing launcher without evidence. Native extraction must be preceded by application-side archive admission because symlink and link-as-parent writes are not covered by its path checks.
- Local signed packaged two-version acceptance must be regenerated after source closure, including the corrected startup/RPC and failure/recovery assertions.
  Publication and live GitHub delivery remain separate release-only limits.

### Combined-source closure review (2026-11-03)

The user selected the independent review gate only.
Three fresh read-only reviewers examined security/storage, transaction/lifecycle, and UI/release/acceptance integration.
All three returned a blocking verdict; the review is complete, but source closure has not passed.
The consolidated report is `.cache/auto-update-0.3.1/combined-source-review/combined-review.md`, with the individual reports and fresh check evidence in the same directory.
The R identifiers below are the current review findings, separate from historical U and F identifiers.

| Finding | Local implementation | Regression evidence |
| --- | --- | --- |
| R1 | Complete: cancellation joins the full boundary operation and finally cleanup before checked retirement; repeated abandonment and Quit coalesce. | Paused real boundary, second-writer exclusion and staging preservation, delayed command closure. |
| R2 | Complete: reconciliation uses a fresh exact journal under the guard without imposing the predecessor PID on the new process. | Exited-child success/failure, same-process controls and retained live/uncertain-helper refusals. |
| R3 | Complete: original combined ustar prefix/name bytes are limited before slash normalization. | Actual 255-byte acceptance and 256-byte refusal headers. |
| R4 | Complete: unique implicit parents and extraction root count toward admission; the distinct materialized budget is enforced. | Sparse parents with small limits and a materialized ceiling below aggregate capacity. |
| R5 | Complete: native adapters use SDK config/appData bases and resolved updater roots; workers pin admission before checks/downloads and after pruning. | Configuration-location preservation, canonical pruning and unchanged-SDK modern-to-legacy resolution with zero transfer/publication. |
| R6 | Complete: preferences and configuration share safe-parent validation before reads or creation/writes. | Leaf/ancestor symlinks, missing files beneath unsafe ancestors and preserved settings/target bytes. |
| R7 | Complete: unchanged non-handoff journals recover only after owner and registered writers are absent under the guard. | Abrupt before/after-grant owner exit, surviving descendants, unknown inspection and eventual recovery. |
| R8 | Complete: attempt cancellation reaches both verification stages; actual command close owns settlement. | Actual spawned-child cancellation at initial preflight/final handoff and deterministic delayed-close/error ownership. |
| R9 | Complete: restart execution coalesces by attempt ID and accepted lifecycle state is idempotent. | Duplicate service admissions during paused preflight/dispatch produce one cleanup, session and SDK call. |
| R10 | Complete: returned unarmed refusal invokes the authoritative failure transition; returned committed state exposes recovery and permits ordinary Quit without installer retry. | Real apply wrapper, boundary, lifecycle and coordinator for arming refusal, post-approval copy error and post-binding error. |
| R11 | Complete: confirmed-unarmed preparation keeps authenticated bytes and lease; proof-checked restoration returns it to prepared state. | Cleanup-fails-once and pre-handoff-fails-once followed by same-candidate retry and safe ordinary Quit. |
| R12 | Complete: rejected moving-latest preparation retires before a retryable mismatch; failed retirement requires recovery. | Real lease/file effects, fresh check/download success and an actual retirement-write refusal. |
| R13 | Complete: local restart uncertainty requires fresh updater and lifecycle evidence; pre-request snapshots are invalidated. | Lost acknowledgement with delayed/failed updater polling, fresh idle Quit, read-only drafts and reachable Logs/Quit. |
| R14 | Complete: macOS FFI loads only on native guard acquisition; genuinely native transaction tests are gated separately. | Portable graph with a throwing native-acquisition seam, including an eager-load negative control. |
| R15 | Complete in source only: private fixtures record one attempt-bound backend-absence observation immediately before apply. | Live-backend negative control still fails after eventual exit; both generated hook variants typecheck. |
| R16 | Complete: README distinguishes the completed SDK storage gate from pending source closure and packaged acceptance. | Documentation and preservation checks. |

Supervisor probes reproduced cross-process confirmation refusal, abandoned-operation refusal, cleanup deleting a second writer's staging, duplicate lifecycle dispatch, missing unarmed-failure callbacks, symlink-following preferences, oversized raw-path admission, and materialization-budget gaps.
The probes used synthetic files, actual transaction leases, exited Bun children, and injected inspection/dispatch boundaries; they did not run the installer or malformed input through the native extractor.
The first probe invocation refused an incorrectly laid-out isolated channel root; correcting that fixture allowed the complete reproduction run.
Fresh checks passed: 393 Bun tests with 2,978 assertions, 51 component tests, 20 browser tests, three private-hook tests with 32 assertions, three native SDK-limit tests covering seven cases with 174 assertions, root/private-fixture types, Biome, and configured LSP diagnostics.
Eight generated tracked screenshots were restored, and all 198 baseline files matched after checks.

No production or committed test-source fixes, builds, signing, packaged application launches, installation, publication, or Git mutations occurred in this review pass.
Only this plan's review status and project-local review evidence were authored.
The remaining source-only findings and unperformed native/platform checks are distinguished in the report.
Correct the findings and obtain closure review before the separate regenerated signed/notarized/stapled two-version acceptance gate.
The following component and U-disposition sections remain historical checkpoints, not current closure claims.

### Direct closure corrections after delegation stopped

The user stopped subagent work and requested direct, one-at-a-time corrections.
Workflow `c57fa209-d612-43d3-b71b-b05bea12c6ac` and its worker are stopped; no further delegates or automatic reviews will run.
The interrupted worker left partial storage, restart and regression-test edits; these were completed directly without new delegation.
The first independent closure pass found seven follow-ups in `remediation-r1-r16/security-storage-review.md`, `transaction-lifecycle-review.md` and `ui-acceptance-review.md` under the existing evidence directory.

- S1 storage accounting is corrected and directly self-reviewed: payload and allocation/directory overhead are counted separately, all eight overlapping payload categories have exact assertions, and unreadable budget roots fail rather than count as empty.
  The unreadable-root regression failed before correction; 27 budget/archive/recovery tests with 67 assertions, scoped Biome and configured LSP checks pass.
  Evidence: `direct-s1-*.log` under `.cache/auto-update-0.3.1/remediation-r1-r16/`.
- TL1 is corrected: service admission carries the exact attempt into queued execution, so a failed duplicate cannot allocate a new retry; a fresh explicit request can retry.
  The interrupted test doubles now implement that contract, and workspace typechecking passes.
- TL2 is corrected: failed unarmed restoration produces recovery-required state with no retry readiness.
  Persistent journal-permission failure keeps Quit incomplete and preserves the journal; restoring permissions permits safe ordinary Quit.
- Stale action responses are invalidated by the terminal generation, and uncertainty retirement uses matching fresh updater/lifecycle evidence.
  The ordered-response regression checks preserved restarting status, unchanged automation state, read-only drafts and later authoritative unlock.
- S2 is corrected: startup performs no effectful SDK path lookup, and workers use the SDK's pure root resolver before getters, status subscriptions or preparation can write.
  Main SDK initialization runs under the prepared lease and drains its first callback only after proving the pinned SDK's no-poll condition.
  Whole-root legacy refusal has an unsafe-getter control that demonstrates the observed-result write; six real-SDK main-adapter cases cover success, no result, cancellation and admission errors without applying an update.
- S3 is corrected: inaccessible updater storage is contained by startup reconciliation while the gateway service can initialize and start.
- Retry documentation now distinguishes usable confirmed-unarmed preparation from restoration failure or uncertain commitment.

Final checks passed: 423 Bun unit/integration tests with 3,159 assertions, 54 components, 20 real-service browser tests, three private-hook tests with 35 assertions, five real-SDK native-helper tests with 223 assertions, root/private types, Biome across 143 files and configured LSP diagnostics across 38 files.
The native suite covers seven storage cases, two rejected-root/control cases and six main-adapter cases; its current evidence is `.cache/updater-sdk-limits-BtzcrN/evidence.json`.
Desktop/narrow ready, restarting and recovery layouts were rendered and inspected at 1280 and 390 pixels, with focus, read-only/retry controls and overflow checks.
Details and observed fixture/lint corrections are recorded in `.cache/auto-update-0.3.1/remediation-r1-r16/DIRECT-COMPLETION.md`.

Direct self-review is not independent closure.
Signed builds, packaged replacement, publication and Git mutations remain excluded.
The following verification section records the first implementation pass, not the interrupted follow-up or current source acceptance.

### R1-R16 source verification and limits

Evidence is retained under `.cache/auto-update-0.3.1/remediation-r1-r16/`; `implementation-report.md` records changed paths and the final check results.
The integrated local checks passed: Bun unit/integration, React components, real-service browser, root typecheck/lint, private acceptance hooks and unchanged-SDK native-helper tests.
The native SDK suite now includes the seven storage cases plus a modern/legacy root-resolution refusal case.
The UI was rendered at 1280 and 390 pixels with retained drafts, disabled mutations, keyboard confirmation cancellation, menu focus, Logs/Quit access and no horizontal overflow.
Generated tracked screenshots were restored from the assignment baseline after retaining new evidence locally.

A supervisor-approved R8 correction removes the verification command's two-second early-completion escape, not its deadline or AbortSignal termination request.
Started-child errors and cancellation settle only after actual close; definite spawn failures settle explicitly without pretending a child was closed.
If termination cannot be confirmed, Quit stays pending and ownership remains retained rather than promising a fixed exit bound.
The deterministic fixture keeps a command logically alive past the old escape, proves the second writer remains excluded, then closes and joins it before deleting its tree.

Focused simplification/security review retained the existing boundary/coordinator/lifecycle dependency direction and shared the existing parent-path policy rather than adding another storage policy.
No dependency, vendor, installer, feed, publisher, configuration-location or historical F1-F5 changes were made in this remediation.
That implementation pass was submitted to independent review; its follow-up corrections and subsequent direct verification are recorded above.
No signed/app build, packaged two-version execution, installed-app change, signing, publication, Git mutation or external configuration change was performed.
Actual Linux runtime, live GitHub/CDN, full-size storage, physical disk exhaustion, power loss and final signed packaged acceptance remain unverified.
Gate 2 remains excluded from this source-only run.

### Independent review remediation (source pass)

The independent review blocked the earlier acceptance summary.
The following dispositions distinguish local implementation from independent closure; none implies final packaged acceptance.
The authoritative package version remains `0.3.1`.

- U1 implemented locally, pending closure review: a persistent exclusive channel-root transaction lease covers check, preparation, handoff, startup reconciliation, and cleanup. Final revalidation compares the exact approved in-memory candidate archive/prepared digests and is followed by the unchanged SDK while the lease is held. A two-writer regression rejects a second preparation before publication; a changed shared archive with the same labels is rejected.
- U2 implemented locally, pending closure review: check and download share admission, post-shutdown checks/downloads are refused, and cleanup only removes owned/abandoned staging.
- U3 implemented locally, pending closure review: cancellation is rechecked after owned-worker setup and after listener registration; an abort during setup cannot launch a detached child.
- U4 implemented locally, pending closure review: cancellation reaches codesign, plutil and lipo through AbortSignal; recovery copying/verification refuses publication after cancellation; abandoned recovery partials are reclaimed under cleanup ownership.
- U5 implemented locally, pending closure review: numeric storage budgets, cancellation and file-limit checks are implemented.
  Native acceptance now exercises unchanged-SDK oversized network downloads and the signed app's bundled zig-zstd through the production owned worker.
  The seven cases include both HTTP transfer modes, exact-limit expansion and same-payload success controls; the storage-limit section below records evidence and limits.
- U6 implemented locally, pending closure review: terminal intent remains mutable through cleanup; ordinary Quit, Cmd+Q and SIGTERM can replace an update intent before handoff; delayed-cleanup regression passes.
- U7 implemented locally, pending closure review: restart publishes an attempt-scoped `restarting` state before asynchronous revalidation; lost acknowledgement cannot unlock drafts, and refusal/failed handoff remains retryable.
- U8 implemented locally, pending closure review: update-action pending state is separate from workspace busy state; unresolved manual check/download leaves Stop, Quit, Logs and drafts usable.
- U9 implemented locally, pending corrected packaged acceptance: a bounded transaction lease and native result are persisted before handoff; startup reconciles the native result against the signed running version/hash and exposes confirmed, failed, unconfirmed or recovery-required outcomes with retained recovery location. The fixture marker is not used as production reconciliation.
- U10 implemented locally: complete wrapper inventories compare entry types, modes, file digests and symlink targets, including launcher and signature files.
  Mount cleanup awaits attach settlement, uses exact structured image/mount identity, and retains uncertain ownership instead of deleting its directory.
  Component 4 records the retained-DMG success, verification-failure and cancellation checks.
- U11 implemented locally: support admission requires macOS arm64 and a valid expected-publisher signature.
  Eligible-host fixtures explicitly inject arm64, including negative metadata cases that must not short-circuit on the CI host architecture.
- U12 implemented locally, pending closure review: private preference/state reads use O_NOFOLLOW descriptors, owner/type/mode checks, bounded reads, and pre/post inode/size/time detection; replacement and growth-during-read regressions pass.

### Seam proof status (historical checkpoint)

The bounded protocol seam pass is not source closure. Proven locally: a stable kernel guard (`flock`) serializes two processes on one inode, rejects symlink/unsafe guard files, preserves the journal, and releases after owner death; the limiter uses the exact 1,024-byte boundary and fails closed; a registered-but-ungranted worker writes nothing and exits on parent-pipe closure; the pinned SDK's `launching-new-version` callback binds a unique plan to the approved candidate; a test-only Cocoa helper invoking `NSApplication terminate:nil` produced an untagged native `before-quit` while the SDK metadata continuation retained its `apply-attempt` token and vetoed the update; exact-path/UID inspection detects an unlinked running helper and returns unknown for failed inspection; and registered process-group inspection blocks recovery after the leader disappears while a descendant remains, refusing to release on uncertain identity.

Both internal and external SIGTERM/SIGINT tests registered 3 listeners per signal before ready; actual signals reached untagged native `before-quit` (ordinary intent), and the later tagged SDK approval was cancelled. JS prepended/post-SDK callbacks did not run, but the shared untagged path is treated as ordinary Quit; no contract change is inferred. At this checkpoint, full SDK failure-return transitions and production group integration were still unproven.
Components 1 and 2 subsequently addressed those source gaps; independent closure and corrected packaged acceptance remain outstanding.

### Production protocol integration status (historical checkpoint)

This paragraph records the pre-component integration checkpoint, not the current source state.
Production integration was partial and did not establish source closure.
At that point, `TransactionLease` acquired the stable kernel guard before creating its lease; `Boundary` completed cleanup before releasing a failed preparation lease; restart reservation preceded the service semaphore; and AsyncLocalStorage distinguished SDK apply, update shutdown and ordinary contexts.
The then-unresolved requirements were durable SDK status binding, restart identity/lost-ack semantics, terminal intent through handoff, storage accounting and SDK-limit tests, and completed-startup/finished-helper reconciliation.
The fresh component sections record subsequent implementation and remaining gaps.
`.cache/auto-update-0.3.1/protocol-integration.json` records that checkpoint's finding-by-finding status.
It is not final acceptance.

### Fresh component 2 implementation status (2026-11-03)

Component 2 reported local source integration complete before Components 3 and 4.
Independent closure review and regenerated signed acceptance remain outstanding.
`HandoffSession` now arms the checked journal synchronously inside the matching `sdk-apply` AsyncLocalStorage invocation, observes only invocation-scoped SDK statuses, binds exact observed plans or limited early failure results, and classifies returned calls from those facts.
`QuitCoordinator` reserves terminal attempt identity before queueing, keeps mutable update/quit intent through cleanup, final revalidation and handoff, routes `begin-update-shutdown` to cleanup-only, and permits ordinary exit only after unarmed settlement and abandonment.
`UpdaterCoordinator` publishes the reserved attempt ID before revalidation, keeps restarting exclusive against checks/downloads, and reconciles before scheduling only after an explicit completed-initialization call.
`Boundary.prepareHandoff` verifies the canonical SDK root, running version/hash, cached/bundled helper byte identity, launcher-parent PID, physical temporary directory and bounded native ID set before any arming.
Production check/prepare workers now wait for a private stdin grant; the journal records the captured process group before the grant and retirement refuses live or uncertain groups.
Startup reconciliation waits a bounded time for the exact bound result and finished helper, preserves unconfirmed/recovery state, and confirms only the canonical application path with the initialized running version/hash.
Component 2 checkpoint checks: 340 Bun unit/integration tests with 2,749 assertions across 41 files, 51 component tests, typecheck and Biome passed.
Installation is enabled for the supported macOS arm64 stable path; final signed/notarized packaged acceptance has not been rerun.

### Fresh component 3 implementation status (2026-11-03)

Component 3 implemented cancellation and storage accounting locally.
The unchanged-SDK network and bundled-preparation limit tests were incomplete at this checkpoint and are covered by the later storage-limit acceptance below.
Independent closure and regenerated signed acceptance remain outstanding.
Cancellation is captured before lease acquisition and carried through worker registration/grant, verification commands, archive inspection/extraction, candidate freeze/revalidation, recovery copy and recovery-record publication.
Verification commands and owned workers wait for bounded actual child closure; logical cancellation alone is not treated as closure.
Full-archive-only preparation removes the SDK current-hash TAR, prepared record, compressed download and patch staging before the unchanged SDK worker runs.
The new numeric storage layout accounts for the compressed download, retained/expanded TAR, frozen copy, extracted verification tree, current app tree, existing recovery tree, recovery staging, candidate records and materialized directories.
Actual disk usage is checked before/after SDK preparation, freezing, extraction and recovery, with separate per-tree and aggregate bounds.
The production worker rejects oversized materialized output from an injected SDK double using a small limit.
The expansion test uses the installed zstd binary; neither test establishes the unchanged network SDK path or the signed app's bundled zig-zstd limit behavior.
Archive, candidate, recovery, process and boundary tests cover cancellation and production staging names.
Component 3 checkpoint checks: 353 Bun unit/integration tests with 2,776 assertions across 42 files, typecheck and Biome passed.
Signed packaged acceptance has not been rerun.

### Fresh component 4 acceptance-source status (2026-11-03)

The interrupted acceptance-source work is complete locally, with focused self-review rather than independent closure.
No DeepSeek worker, release build, signing submission or packaged update run was started in this pass.

- Complete DMG wrapper inventories include entry paths, types, modes, file sizes/digests and symlink targets.
  Same-metadata/same-payload regressions reject changed launcher/signature bytes, modes, types, links, missing entries and extra files.
- `scripts/release-dmg.ts` owns the attach attempt through settlement and cleanup.
  Cancellation waits for attach, exact `hdiutil info -plist` inspection gates detach and force-detach, and unknown settlement or cleanup fails while retaining the directory.
  Only confirmed unmounted directories are removed, non-recursively.
- The retained intermediate DMG passed complete wrapper comparison, signature/ticket/Gatekeeper checks and successful detachment with the current verifier.
  Verification-failure and cancellation-during-attach probes also confirmed detachment.
  No signing secrets were supplied, so the report explicitly marks the credential scan unperformed.
- Eligible-host fixtures explicitly select arm64; metadata rejection tests cannot pass solely because a runner is x64.
  The existing "unsaved drafts" help wording was retained and verified in desktop/narrow rendered states.
- Private A/B source hooks now refuse missing/ambiguous patch anchors, fix project-local home/data/temp roots before SDK imports, and record startup outside the signed bundle only after completed initialization and a successful renderer RPC.
  The private restart RPC checks the confirmation click result and records its receipt before forwarding the production restart handler.
- Acceptance rejects malformed/truncated/duplicate/extra startup records and requires exactly one initial and target startup, expected version/hash/roots, confirmed native transaction, old-backend exit and byte-identical configuration.
  Process cleanup reuses owned launcher/backend handling and exact executable/UID/start-time checks for the Launch Services replacement.
  Unconfirmed helper completion retains the run directory and is not reported as successful cleanup.
- Local checks passed: 393 Bun unit/integration tests with 2,978 assertions, 51 component tests, 20 real-service browser tests, 3 private hook/process tests, root and private-fixture typechecks, Biome and configured LSP diagnostics.
  Both generated private source variants typecheck without creating packaged builds.
  Desktop/narrow screenshots, keyboard restart-cancel focus and overflow checks passed.
- Verification corrections: the first new-test run failed because its helpers did not yet exist; a fixture literal-type error and a private tsconfig missing existing declaration files were corrected.
  A native cleanup probe exposed the process-output cap; selection is now exact-path/UID before bounded inspection.
  A copied system `sleep` probe exited before inspection, so the test uses a copied installed Bun executable instead.
  Focused self-review also corrected preservation of non-Error rejections during mount cleanup.
  The corrected checks passed.

Evidence: `.cache/auto-update-0.3.1/acceptance-direct/` and `.cache/auto-update-0.3.1/component-acceptance-source.json`.
Published artifacts, assets, dependency lockfile and production runtime source remain unchanged by this pass.
Generated tracked screenshots were restored to their pre-pass bytes.

Remaining gates: independent source closure and regenerated signed/notarized/stapled 0.3.1 plus the corrected private two-version acceptance.
The storage-limit gap is covered by the native acceptance below.
The private fixture's completed-startup/RPC, fixed-root initialization, click-receipt ordering and Launch Services cleanup have not yet been exercised together in a signed packaged update.
The two-second duplicate-startup observation window is bounded evidence, not a guarantee against a later restart.
Publication, installed-app replacement and Git mutations remain unauthorized.

### Real SDK storage-limit acceptance (2026-11-03)

The storage-limit gate passed locally without production, dependency or release-artifact changes.
`tests/native/updater-sdk-limits.native.ts` runs the production owned worker and default SDK loader, with the unchanged pinned Electrobun 2.0.5 source.
It copies Bun, zig-zstd and the required native libraries from an explicitly selected, signature-verified project-local app; source and copied binary hashes must remain identical.
The fixture routes only the fixed manifest/artifact requests to an ephemeral loopback HTTP feed and never calls apply or launches the application.

- Three tests cover seven cases with 174 assertions.
  Known Content-Length and unknown-length chunked downloads each have a same-payload success control and an oversized refusal.
  Client-observed headers distinguish the two transfer modes.
  Each oversized stream reaches an observed 65,536-byte SDK staging file before the feed sends bytes above the cap; refusal occurs before decompression.
- Bundled zig-zstd accepts a 65,536-byte TAR and rejects a 66,048-byte TAR under the same inherited file limit.
  The rejected payload succeeds with a larger limit, and successful outputs match the input TAR digest and exact prepared record.
- Refusals publish no ready result, retained TAR or prepared record.
  Checks confirm worker-group exit, interrupted-staging cleanup and unchanged synthetic configuration bytes.
  A test-only preload removing the inherited file limit makes all three refusal cases fail their SDK-error assertion after the SDK reaches download-complete.
- Fixture corrections preceded acceptance: the default SDK loader required the signed native libraries, and Bun's streaming server replaced Content-Length with chunked encoding.
  The final fixture uses node:http and asserts the headers received by the SDK.
  A mutation-preload import-path error was corrected before the sensitivity run.
- Root typecheck, Biome, configured LSP diagnostics and all 393 Bun unit/integration tests with 2,978 assertions passed.
  Focused self-review found no remaining issue in this test-only change; independent combined-source review remains separate.
  Component, browser and native application suites were not rerun because production and UI source are unchanged.

Evidence: `.cache/auto-update-0.3.1/sdk-storage-limits/acceptance.json`, with native results, mutation output and unit logs linked from that record.
The tests use small injected limits and loopback HTTP, not full 512 MiB artifacts, physical disk exhaustion or live GitHub/CDN delivery.
They do not replace regenerated signed two-version acceptance, and the retained signed app remains an intermediate build.

### Agreed behavior

- Support the signed macOS arm64 stable distribution first.
  Linux, Windows, Intel macOS, prerelease channels, and a separate update server are outside this feature.
- Fetch updates from GitHub Releases in `zaherg/mcp-gateway`.
  Use `https://github.com/zaherg/mcp-gateway/releases/latest/download` as the stable feed base URL.
- Enable automatic checks and downloads by default, with a persistent Settings toggle to disable them.
- Install only after the user chooses **Restart to Update**.
  Downloading an update must not stop the gateway or discard unsaved drafts.
- Provide **Check for Updates** even when automatic updates are disabled.
  Manual checking never authorizes installation.

Proposed scheduling: check after application startup has settled, then every 24 hours while the app runs.
After sleep, perform at most one overdue check, without replaying missed intervals.
Manual checks run immediately and share any in-flight check.
Background failures remain nonmodal, with status and retry available in Settings; a failed check must not appear as "up to date".

### Existing support and integration constraints

The app pins Electrobun `2.0.5` and Hutch `0.28.2`.
The pinned SDK exposes `Updater.checkForUpdate()`, `downloadUpdate()`, `applyUpdate()`, and status callbacks.
Reuse this updater rather than adding a custom downloader, archive installer, or update backend.
The original planning inspection found no feed/API integration.
The current source configures the fixed feed and calls these APIs through the application updater boundary.

The local build already generates `stable-macos-arm64-update.json` and `stable-macos-arm64-MCPGateway.app.tar.zst`.
GitHub release `v0.3.0` currently publishes only `macos-arm64-MCPGateway.dmg`.
Existing installations therefore need one manual installation of the first updater-capable release; publishing extra assets cannot add updater code or a feed URL to an installed app.

Three SDK behaviors require explicit handling:

1. Update availability is based on differing bundle hashes, not increasing versions.
   Add a strict stable-version gate using the installed Bun semver API: only a higher version is eligible, and equal-version rebuilds, older versions, invalid versions, and prereleases must not auto-download or install.
2. `applyUpdate()` synchronously requests native quit approval and returns if any handler vetoes it.
   The pre-updater `QuitCoordinator` vetoed while asynchronous cleanup ran, then called `Utils.quit()`.
   Component 2 adapts this with separate shutdown/apply origins and a checked handoff session; using the old flow would quit without applying the update.
3. Public check/download methods have internal timeouts but no caller cancellation signal, and preparation invokes synchronous native helpers.
   Update operations must not occupy the service queue that Stop/Quit needs.
   Measure preparation responsiveness and verify that exiting does not wait for a network timeout or leave owned helper processes behind.

### Security and installation gate

Before enabling installation, verify the pinned SDK's actual native replacement path with a signed two-version test.
The official documentation explicitly states that its bundle hash is a release-routing identifier, not a signature or content-authentication mechanism.
The inspected TypeScript validates manifest identity and filenames; this does not establish runtime publisher authentication.

The implementation must establish all of the following before accepting downloaded executable code:

- The candidate is for `dev.srvr.mcpgateway`, stable, macOS, arm64, and the selected higher version.
- A valid macOS signature belongs to the expected publisher and bundle identifier, rather than merely being signed by any developer.
  Preserve the project's notarization and stapling release checks.
- The staged payload matches the selected manifest before replacement or execution.
  Reject tampered, truncated, mismatched, wrong-publisher, and wrong-architecture candidates without replacing the working application.
- Metadata and artifact filenames cannot select arbitrary paths or executable commands.
  Use the fixed HTTPS GitHub source, permit required GitHub asset redirects, and never attach gateway or upstream credentials.
- Failed replacement retains or restores the previous app and leaves user configuration unchanged.
  Do not promise rollback after an arbitrary crash in the newly launched version without evidence that the SDK supports it.

If publisher verification or transactional replacement is missing, installation remains blocked.
Resolve that gap through a supported verification integration or an explicitly approved change of updater; do not silently trust HTTPS, an unsigned checksum, or the routing hash as publisher authentication.
No vendor patch, new signing framework, or custom installer is approved by this plan.

### Application design

Keep update policy in the main process, separate from the gateway controller and LAN MCP routes.
Add a small updater coordinator, with an injected SDK boundary for tests and one authoritative state exposed through validated local RPC.
Track availability, download/preparation progress, ready-to-restart state, errors, and the current operation identity so a late result cannot undo newer lifecycle state.
Keep only bounded status history, and map SDK errors to sanitized UI messages.

Store the automatic-update toggle in a separate owner-only `updates.json` in the existing application data directory.
Use a versioned, strictly validated document, bounded reads, atomic writes, and the existing path/symlink security conventions.
A missing file means the agreed default of enabled; an invalid or unreadable file produces a visible preference error and disables background work until repaired, without silently overwriting it.
A failed preference write preserves the prior effective setting.
Do not put update settings in `mcp.json`/`mcp.jsonc`, rewrite gateway configuration, or couple the toggle to the gateway's Save button.
This preserves credentials, JSONC comments, existing drafts, and compatibility when returning to an older application.

The coordinator owns timers and admits one check/download sequence at a time.
Status polling only reads state; it must never initiate network checks.
When automatic updates are off, a manual check offers **Download Update** for an eligible release.
When automatic updates are on, discovering an eligible release starts the download automatically.
Disabling automation stops new scheduled checks and download admissions; an already-running SDK transfer may finish and remain cached because the public API has no cancellation hook.
Disabling automation never applies or deletes a prepared update.

Do not await a background network operation from Stop or Quit.
Ignore late callbacks after shutdown begins, and verify interrupted preparation is recoverable on the next launch.
Development builds, isolated tests, unsupported platforms, and builds without the approved feed must not contact production update endpoints automatically.
Tests use injected data or a project-local fixture feed, never a production feed override exposed through renderer RPC.

Add an Updates section within Settings showing the installed version, check status, available version, progress, the automation toggle, and the appropriate check/download/restart action.
Reuse existing banners, focus handling, disabled states, and error-occurrence behavior.
Add **Check for Updates…** to the macOS application and tray menus; these open the Updates section and invoke the same main-process operation as the Settings button.
A background discovery shows a nonmodal update notice without opening the window or taking focus.
If release notes are linked, construct a fixed GitHub release URL from a validated version and do not render remote HTML.

### Restart and recovery contract

Before beginning update shutdown, confirm that active MCP connections will be interrupted and handle every unsaved configuration or open-dialog draft.
Offer cancellation or explicit draft discard; never silently save configuration as part of an update.
The restart action must target the prepared version shown to the user, not a different version discovered during confirmation.
Freeze that candidate for the attempt, and revalidate it before handoff.

Extend the existing lifecycle coordinator with an explicit terminal intent: normal quit or restart-to-update.
After successful gateway/backend cleanup, dispatch the retained intent exactly once.
For an update intent, retry `applyUpdate()` after cleanup is ready so its second approval request can pass; do not fall through to `Utils.quit()`.
Native Quit, signals, double clicks, and renderer requests must share that authority, with an ordinary Quit able to exit without unexpectedly installing or relaunching.
A normal Quit must not implicitly become "install on quit".

Reuse the existing configuration lock and lost-acknowledgement protections from F3 while shutdown or handoff is pending or has failed.
If cleanup fails, do not arm the installer; preserve Logs and an explicit retry path.
If installer handoff fails after cleanup, report that the gateway is stopped and keep Retry Update and normal Quit reachable instead of claiming that the app is fully running or allowing new unsavable edits.
Do not automatically reopen the listener as error recovery.
On successful relaunch, use the existing saved `autoStart` policy; updating does not silently change gateway exposure or login registration.

Closing the window with Cmd+W must still leave the gateway and update download running.
A normal application exit may interrupt an unfinished download, but must not be held open until a ten-minute download timeout.
A downloaded update is not an installed update; report success only after the relaunched app confirms the expected version/result.

### GitHub release contract

Set `release.baseUrl` in `electrobun.config.ts` to the agreed GitHub stable URL without changing the app name, identifier, or channel.
Every updater-capable stable release must publish these exact generated filenames:

- `macos-arm64-MCPGateway.dmg` for first installation and manual recovery.
- `stable-macos-arm64-update.json` for discovery.
- `stable-macos-arm64-MCPGateway.app.tar.zst` for the runtime payload, not the DMG or first-launch installer wrapper.

Use a unique increasing `vX.Y.Z` tag matching the package version, manifest version, and embedded payload version.
Do not replace artifacts under an existing published version.
Delta patches are optional SDK output, not a requirement for the first implementation; missing patches must fall back to the full archive.
Do not add a separate patch-retention service.

Build and verify locally, create a draft release, upload the complete matching asset set, verify downloaded bytes and signatures, then publish it as the latest stable release.
Drafts and prereleases must never become stable update candidates.
Publishing all required assets together avoids advertising an incomplete release.
A release published between a client's check and download can move the `latest/download` alias; mismatched metadata/payload must fail closed and permit a fresh check rather than install mixed versions.
If the SDK cannot meet that requirement, resolve immutable-tag targeting before enabling updates.
Retain older DMGs for explicit manual recovery; automatic downgrade is not supported.

These are future release requirements, not authorization to modify `v0.3.0`, create a release, upload assets, or push code now.

### Implementation order and acceptance

1. **Verify the updater boundary.**
   Inspect the pinned native helper and build a bounded compatibility test for publisher validation, archive identity, quit veto/retry, replacement recovery, and writable installation paths.
   Resolve the security gate before enabling apply behavior.
   Signing and packaged installation tests require explicit authorization and isolated project-local copies.
2. **Add policy and preferences.**
   Implement the main-process coordinator, version gate, schedule, strict preference storage, sanitized status, and fake SDK boundary.
   Cover default-on, disabling, corrupt preferences, concurrent requests, timeouts, stale callbacks, and same/older/invalid/prerelease versions.
3. **Integrate lifecycle and local RPC.**
   Update `src/main/lifecycle.ts`, `src/main/index.ts`, `src/main/service.ts`, `src/shared/rpc.ts`, and `src/mainview/client.ts` together.
   Keep Stop/Quit independent of update I/O and validate every new RPC request without accepting arbitrary URLs or paths.
4. **Add the Settings and menu controls.**
   Update `src/mainview/App.tsx` and neighboring components/styles as needed.
   Cover automation off/on, manual check/download, offline/error/retry, ready, dirty drafts, failed cleanup/handoff, lost acknowledgements, and window recreation.
   Inspect rendered desktop/narrow layouts, keyboard navigation, focus, and accessible live progress messages.
5. **Extend release verification and documentation.**
   Update `electrobun.config.ts`, the release verification scripts, `README.md`, and `tests/README.md`.
   Verify the complete asset set, exact filenames, increasing version, identity, signatures, notarization, and manifest/payload agreement before publication.
   Document default network behavior, manual bootstrap from `v0.3.0`, restart interruption, writable installation requirements, and recovery limits.
6. **Verify and review before release.**
   Run relevant Bun, component, real-service browser, type, lint, and LSP checks, including existing F1-F5 regressions.
   Obtain independent review of update trust boundaries, lifecycle races, preference persistence, and release publication ordering.
   After authorization, exercise an isolated signed version-A-to-version-B update with a synthetic active MCP session, failed cleanup, offline/interrupted download, insufficient disk space, read-only destination, rejected payload, concurrent latest-release change, and recovery.
   Confirm old owned processes exit before replacement, the expected new version starts once, and gateway configuration remains byte-identical.

Completion requires an actual packaged two-version update, not only mocks, a successful download, or a passing DMG signature check.
A live GitHub end-to-end check and public rollout remain separate authorized release steps; local fixture-host evidence does not establish GitHub delivery.
Historical planning checkpoint: no application checks or installations had run at that time.
Independent read-only plan review found no issues; its report is `.cache/auto-update-plan/independent-review.md` and is not implementation closure.
The current component status sections distinguish later source checks, intermediate signed evidence and remaining acceptance gates.
The reviewer confirmed that the pinned decompression call is synchronous and has no execution timeout, so queue separation alone cannot establish responsiveness.
Documentation checks passed for whitespace, required decisions, referenced local files, and preservation of the historical F1-F5 record.
An initial requirement-presence assertion used wording absent from the document; correcting it to the actual default-on sentence made the check pass without changing the plan.

### Planning evidence

- Local source: `electrobun.config.ts`, `hutch.config.ts`, `scripts/build.ts`, `src/main/index.ts`, `src/main/lifecycle.ts`, `src/main/service.ts`, `src/shared/rpc.ts`, `src/mainview/App.tsx`, and the existing configuration store/schema.
- Pinned SDK: `.cache/toolchain/electrobun-2.0.5/api/sdks/main/core/Updater.ts`, including manifest validation, `checkForUpdateOperation`, `downloadUpdateOperation`, and `applyUpdateOperation`.
- Local generated metadata: `artifacts/stable-macos-arm64-update.json`.
- Published asset inspection: `gh release view v0.3.0 --repo zaherg/mcp-gateway`, which returned the DMG as the only asset.
- Official [Updater API](https://docs.electrobun.dev/electrobun/apis/updater/) and [update publishing guide](https://docs.electrobun.dev/electrobun/guides/updates/), checked against the pinned SDK where possible.

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
