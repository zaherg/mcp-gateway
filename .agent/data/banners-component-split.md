# Banners component split: discussion and plan

## Status and scope

Revised planning only; implementation has not started.
This revision supersedes the earlier plan's broader login-warning visibility and its assumptions about the shared alert's dismiss control.
The requested destination is `src/mainview/components/banners/`, which currently exists but is empty.
This plan uses the current working tree at HEAD `08246efb064d78560336a8ced19ebe70bdff4867`, including the newer Settings-only login behavior and macOS control migration.
The unchanged commit ID does not mean the working-tree source is unchanged.
It does not authorize behavior changes, tests, dependency changes, or release work.

## Current structure

`src/mainview/components/Banners.tsx` has 24 props and 12 rendering branches inside one `announcements` live region.
`src/mainview/App.tsx` is its only component consumer and owns errors, notices, dismissed IDs, snapshots, and lifecycle state.
`src/mainview/components/ui.tsx` supplies the shared `Alert`, including its severity styling, role defaults, and dismiss button.
It now composes `MacAlert` with the shared macOS `Button`, using `variant="ghost"`, `size="icon"`, and the existing accessible label.
Message text uses `min-w-0 flex-1 wrap-anywhere`.
That primitive also serves other screens and should remain where it is; the split must not recreate its styling or restore the former raw button.

The existing working-tree changes matter to this extraction:

- Available/ready update notices appear only on Overview.
- Update errors, gateway errors, and stale-draft warnings appear on Overview and Settings, not Logs.
- Login warnings now appear only on Settings, never Overview or Logs.
- Local errors, Quit messages, and success notices can still appear on every tab.
- `App` derives `showLoginRetry = retryLogin && tab === 'settings'` and passes it to both `DraftBar` and `RawConfig`.
- `loginInDraftBar` still receives `retryLogin && !dirty`; on Settings it suppresses a duplicate login warning when the clean-draft retry bar already presents the error.
- `retryLogin` retains its existing valid-config, snapshot, no-configuration-error, non-stale, and `needsLoginRetry` checks.
- Local error dismissal also acknowledges matching configuration and operational occurrences in `App`.
- `.announcements:empty` hides an empty banner stack; fragments must preserve that behavior and the existing grid spacing.

## Recommended split

Use seven focused child components and one small composition component.
Group adjacent branches that share state and behavior, rather than creating a file for every conditional paragraph.

```text
src/mainview/components/banners/
  Banners.tsx
  LocalErrorBanner.tsx
  UpdateBanners.tsx
  QuitBanners.tsx
  NoticeBanner.tsx
  GatewayErrorBanners.tsx
  LoginStartupBanner.tsx
  StaleConfigBanner.tsx
```

| Component | Responsibility | Inputs needed |
| --- | --- | --- |
| `Banners` | Keep the live region, rendering order, and explicit tab visibility policy, including Settings-only login warnings. | Existing App-facing props. |
| `LocalErrorBanner` | Render the local error and use the existing dismissal callback. | `error`, `onDismiss`. |
| `UpdateBanners` | Render the available/ready notice or update error with unchanged wording and identity. | `updateState`, `showAvailableNotice`, `showErrors`, `dismissed`, `dismiss`. |
| `QuitBanners` | Render failed Quit, shutdown read-only, unconfirmed status, and status-read failure messages. | The existing seven lifecycle values, `dismissed`, `dismiss`. |
| `NoticeBanner` | Render the success notice. | `notice`, `onDismiss`. |
| `GatewayErrorBanners` | Render configuration and operational errors, including local-error deduplication and retained-draft wording. | `configError`, `operationalError`, `hasLocalError`, `errorOccurrence`, `hasRetainedConfig`, `configurationLocked`, `dismissed`, `dismiss`. |
| `LoginStartupBanner` | Within the parent's Settings-only gate, render the login warning unless represented by the supplied draft-bar flag. | `login`, `loginWanted`, `loginInDraftBar`, `dismissed`, `dismiss`. |
| `StaleConfigBanner` | Render the external-change warning with revision-based dismissal. | `stale`, `revision`, `dismissed`, `dismiss`. |

The seven lifecycle values are `quitting`, `quitStatus`, `shutdownStarted`, `updateRestarting`, `quitStatusKnown`, `requestingQuit`, and `quitReadError`.
`GatewayErrorBanners` keeps its two branches independent: both errors may need to render.
`QuitBanners` also preserves its independent conditions rather than choosing one message with an `else if` chain.

### Why this grouping

A separate component for all 12 branches would add tiny files without separating additional state ownership.
A single generic banner registry would make visibility, deduplication, and dismissal harder to follow.
The proposed grouping keeps related update, Quit, and gateway-error behavior together while separating unrelated messages.
The new tab policy changes where a group renders, not the number of state-owning responsibilities, so the seven-child split still fits.
It improves navigation without introducing a banner framework.
The broader macOS control migration remains outside this refactor.

## Ownership and imports

- Keep all state, polling, lifecycle actions, and dismissal-retention logic in `App` and its existing hooks.
- Keep the current App-facing `Banners` props compatible; reducing the 24-prop interface is not part of this extraction.
- Give children only the fields they consume, not the entire `AppSnapshot`, `GatewaySnapshot`, or `GatewayConfig`.
- Reuse `LoginStatus`, `UpdateStatus`, `QuitStatus`, and indexed gateway error types rather than recreating domain types.
- Let dismissible children receive `ReadonlySet<string>` and the existing callback; never mutate the set or create child-owned dismissal state.
- Translate `setNotice` to `onDismiss={() => setNotice('')}` inside the composition component.
- Derive `hasLocalError` with `Boolean(error)` and `hasRetainedConfig` from the current config presence, preserving existing truthiness semantics.
- Keep `showStatus = tab !== 'logs'` in the composition component.
- Pass `showAvailableNotice={tab === 'overview'}` and `showErrors={showStatus}` to `UpdateBanners`.
- Gate `GatewayErrorBanners` and `StaleConfigBanner` with `showStatus` separately, preserving their order around the login warning.
- Gate `LoginStartupBanner` with `tab === 'settings'`; placing it under only `showStatus` would incorrectly restore the Overview warning.
- Preserve the supplied `loginInDraftBar` value rather than recalculating it inside a child.
- Leave `showLoginRetry` and its `DraftBar`/`RawConfig` consumers unchanged; the banner split must not re-enable login retry outside Settings.
- Use named `const` arrow components and `@mcp-gateway/...` imports, following the repository conventions.
- Import the entry point explicitly from `@mcp-gateway/mainview/components/banners/Banners`.
- Remove the old `components/Banners.tsx` after moving its behavior; no barrel or compatibility re-export is needed for the one internal consumer.
- Reuse `Alert` from `components/ui.tsx` in the extracted children; do not import `MacAlert` or `Button` directly just to reproduce its internals.
- Leave `ui.tsx`, the `mac/` primitives, `DraftBar.tsx`, `RawConfig.tsx`, and `styles.css` unchanged during implementation.

## Tab visibility contract

These are tab gates, not unconditional rendering requirements; each banner retains its existing state, error, and dismissal checks.

| Banner group | Overview | Settings | Logs |
| --- | --- | --- | --- |
| Local error | Eligible | Eligible | Eligible |
| Available/ready update notice | Eligible | Hidden | Hidden |
| Update error | Eligible | Eligible | Hidden |
| Quit failure and status paragraphs | Eligible | Eligible | Eligible |
| Success notice | Eligible | Eligible | Eligible |
| Configuration and operational errors | Eligible | Eligible | Hidden |
| Login startup warning | Hidden | Eligible | Hidden |
| Stale-draft warning | Eligible | Eligible | Hidden |

Do not infer this matrix from the existing Logs comment alone: success notices also render on Logs, and login warnings have a narrower Settings-only rule.

## Behavior that must remain unchanged

Keep the exact DOM order:

1. Local error.
2. Available/ready update notice, then update error.
3. Failed Quit, shutdown explanation, unconfirmed Quit status, then Quit-status read failure.
4. Success notice.
5. Configuration error, then operational error.
6. Login warning.
7. Stale-draft warning.

Keep one outer `<div className="announcements" aria-live="polite">`.
Grouped children should return fragments, not introduce new layout wrappers or live regions.
A child with nothing to show must leave no placeholder DOM element that defeats `.announcements:empty`.
Keep the existing grid gap and bottom spacing without adding banner-local margins.
Preserve all message text, severity, explicit roles, dismiss labels, and the shared `Alert` defaults.
Preserve the macOS ghost icon button, its focus/interaction behavior, and the current long-message wrapping through reuse of `Alert`.
Plain Quit status paragraphs must remain non-dismissible `role="status"` elements.

Keep the existing dismissal identities, including nullish fallbacks and optional values:

- Update: `update-${phase}-${availableVersion ?? ''}-${error ?? ''}`.
- Quit: `quit-${attempt}`.
- Configuration: `config-${occurrenceId}`.
- Operation: `operation-${occurrenceId}`.
- Login: `login-${occurrenceId}`.
- Stale draft: `stale-${gateway?.revision}`.

Within `UpdateBanners`, compute the update key once for its visibility checks and dismissal callbacks.
Do not change the corresponding retention keys or local-error acknowledgement behavior in `App`.
A new occurrence, Quit attempt, update identity, or gateway revision must retain its existing ability to show another message.
Preserve local-error deduplication only while the local error is truthy and its occurrence matches the gateway error.
Do not change missing-snapshot handling, configuration locking, login retry rules, or updater actions.

## Implementation sequence

- [ ] Re-read `Banners.tsx`, the relevant `App.tsx` state and call site, `Alert`, the macOS `Button`, `DraftBar`, `RawConfig`, and announcement styles; preserve any newer user edits.
- [ ] Move the composition component to `banners/Banners.tsx` and extract the seven children in the rendering order above, retaining the current `Alert` primitive.
- [ ] Narrow child props and reuse existing domain types without changing state ownership or dismissal identities; apply the explicit tab matrix, especially the separate Settings-only login gate.
- [ ] Update only the `Banners` import in `App.tsx`; preserve its prop expressions, callbacks, effects, `showLoginRetry`, and both retry-control consumers.
- [ ] Remove the old file and check for stale imports, duplicated alert/button styling, unintended DOM wrappers, and loss of the empty-stack behavior.
- [ ] Run the source/build checks and manual verification below.
- [ ] Review the final diff for scope, behavior parity, and preservation of the pre-existing changes.

If a step is blocked or needs a different design, stop and confirm the change before proceeding.

## Verification for implementation

No test files or test suites should be added.
Run `bun run typecheck`, `bun run lint`, configured TypeScript diagnostics for changed files, and `bun run ui:build`.
Report pre-existing failures separately rather than expanding the refactor to fix them.
Capture the current rendered behavior before extraction and compare desktop and narrow layouts afterward, including text wrapping, the macOS dismiss control, dismissal focus, keyboard access, and alert/status semantics.
Use synthetic UI state without mutating real configuration, login registration, or update installation; document any state that cannot be exercised safely without additional tooling.
Do not launch, stop, or overwrite an already-running user development session just to perform these checks without coordination.

Manual checks should cover:

- Every row of the tab matrix, especially no login warning on Overview or Logs and local success notices still appearing on Logs.
- Available, ready, and failed updates; dismiss the current identity and observe a new identity.
- Failed Quit, active cleanup, update restart, unknown status, and read failure, including overlapping messages.
- Configuration and operational errors together, matching local-error suppression, and locked versus editable retained-draft text.
- Settings with a clean retriable login failure: the draft bar presents the login error and retry action, without a duplicate banner.
- Settings with a dirty draft and login error: preserve the unsaved-changes bar and independently eligible login warning.
- Settings with retry unavailable, including stale/invalid configuration: the login warning remains governed by its existing error, wanted/supported, and dismissal conditions, not by retry eligibility.
- The same login snapshots on Overview and Logs: no login warning or clean-draft retry control; `RawConfig` must not gain retry-only save eligibility outside Settings.
- Stale drafts, dismissal, and a changed revision.
- Empty/loading state, no empty-stack spacing, long messages, macOS button hover/pressed/focus states, keyboard dismissal, and unchanged banner ordering.

This replanning task did not execute those implementation checks or establish runtime parity.
The revised discussion received a focused source-based self-review, not an independent review.
