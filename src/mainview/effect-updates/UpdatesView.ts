import { UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Schema } from 'effect';

import {
  UpdateStatusSchema,
  type UpdateStatusValue,
} from '@mcp-gateway/mainview/effect-app/schemas';
import {
  buttonClasses,
  iconCircleHelp,
  renderAlert,
  renderToggleRow,
} from '@mcp-gateway/mainview/effect-ui';
import { type Locale, type Translate, translator } from '@mcp-gateway/shared/i18n';

// The clock format follows the macOS region, not the interface language, as it did before.
export const updateCheckedLabel = (value: string | null, t: Translate): string => {
  if (!value) return t('updates.notChecked');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t('updates.checkTimeUnavailable');
  return t('updates.lastChecked', {
    time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  });
};

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const updateStatusText = (update: UpdateStatusValue, t: Translate): string => {
  switch (update.phase) {
    case 'checking':
      return t('updates.status.checking');
    case 'downloading':
      return update.availableVersion
        ? t('updates.status.downloadingVersion', { version: update.availableVersion })
        : t('updates.status.downloading');
    case 'available':
      return update.availableVersion
        ? t('updates.status.availableVersion', { version: update.availableVersion })
        : t('updates.status.available');
    case 'ready':
      return update.availableVersion
        ? t('updates.status.readyVersion', { version: update.availableVersion })
        : t('updates.status.ready');
    case 'restarting':
      return t('updates.status.restarting');
    case 'error':
      return update.error ?? t('common.updateOperationFailed');
    case 'idle':
      return update.checkedAt ? t('updates.status.upToDate') : t('updates.status.neverChecked');
  }
};

export const UpdatesProps = Schema.Struct({
  locale: Schema.String,
  updateState: UpdateStatusSchema,
  busy: Schema.Boolean,
  updateBusy: Schema.Boolean,
  configurationLocked: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});

export const UpdatesModel = Schema.Struct({
  autoChecked: Schema.Boolean,
});

export const UpdatesMessage = UiSchema.TaggedEnum({
  DismissedError: {},
  ClickedCheck: {},
  ClickedInstallOrRelaunch: {},
  ToggledAutomatic: { automatic: Schema.Boolean },
});

export const UpdatesEvent = UiSchema.TaggedEnum({
  RequestedDismissError: {},
  RequestedCheck: {},
  RequestedInstall: {},
  RequestedRestart: {},
  RequestedToggleAutomatic: { automatic: Schema.Boolean },
});

export const UpdatesView = Html.component({
  name: 'UpdatesView',
  props: UpdatesProps,
  model: UpdatesModel,
  message: UpdatesMessage,
  events: UpdatesEvent,
}).make({
  init: ($) => {
    const shouldAutoCheck = $.props.updateState.supported && $.props.updateState.phase === 'idle';
    const step = $.set({ autoChecked: shouldAutoCheck });
    return shouldAutoCheck ? step.emit(UpdatesEvent.RequestedCheck()) : step;
  },
  update: {
    DismissedError: ($) => $.emit(UpdatesEvent.RequestedDismissError()),
    ClickedCheck: ($) => $.emit(UpdatesEvent.RequestedCheck()),
    ClickedInstallOrRelaunch: ($) =>
      $.props.updateState.phase === 'ready'
        ? $.emit(UpdatesEvent.RequestedRestart())
        : $.emit(UpdatesEvent.RequestedInstall()),
    ToggledAutomatic: ($, { automatic }) =>
      $.emit(UpdatesEvent.RequestedToggleAutomatic({ automatic })),
  },
  view: (h) => {
    const { updateState, busy, updateBusy, configurationLocked, error } = h.props;
    const t = translator(h.props.locale as Locale);
    const updateReady = updateState.phase === 'ready';
    const updateAvailable =
      updateState.phase === 'available' || Boolean(updateState.availableVersion);
    const inProgress = updateState.phase === 'checking' || updateState.phase === 'downloading';
    const toggleDisabled =
      busy || updateBusy || configurationLocked || updateState.phase === 'restarting';
    const actionsDisabled = toggleDisabled || inProgress;

    const progressPercent =
      updateState.progressPercent ?? updateState.downloadProgress?.percent ?? null;
    const downloadedBytes =
      updateState.downloadedBytes ?? updateState.downloadProgress?.bytesDownloaded ?? null;
    const totalBytes = updateState.totalBytes ?? updateState.downloadProgress?.totalBytes ?? null;
    const showProgress = inProgress || progressPercent !== null;

    const progressParts: string[] = [];
    if (progressPercent !== null) progressParts.push(`${progressPercent}%`);
    if (downloadedBytes !== null && downloadedBytes > 0) {
      if (totalBytes !== null && totalBytes > 0) {
        progressParts.push(`${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)}`);
      } else {
        progressParts.push(formatBytes(downloadedBytes));
      }
    }
    const progressLabel = progressParts.join(' · ');
    const statusText = updateStatusText(updateState, t);

    let progressBar = h.div
      .class('update-progress')
      .attr('role', 'progressbar')
      .attr('aria-label', t('updates.progress'))
      .attr('aria-valuemin', '0')
      .attr('aria-valuemax', '100')
      .attr('aria-valuetext', progressLabel || statusText)
      .attr('aria-busy', String(inProgress));
    if (progressPercent !== null) {
      progressBar = progressBar.attr('aria-valuenow', String(progressPercent));
    }

    const progressFill =
      progressPercent !== null
        ? h.span.style({ width: `${Math.min(100, Math.max(0, progressPercent))}%` })
        : h.span;

    const handleToggleAutomatic = (automatic: boolean) =>
      UpdatesMessage.ToggledAutomatic({ automatic });

    return h.div.class('updates-content').children(
      h.p.class('dialog-intro').children(t('updates.intro')),
      error
        ? renderAlert(h, {
            kind: 'error',
            dismissLabel: t('common.dismissError'),
            onDismiss: UpdatesMessage.DismissedError(),
            content: error,
          })
        : null,
      !updateState.supported
        ? h.p.class('update-unavailable').children(t('updates.unsupported'))
        : [
            h.div
              .class('update-summary')
              .children(
                h.div.children(
                  h.span.class('update-label').children(t('updates.installed')),
                  h.strong.children(updateState.installedVersion ?? t('updates.unknown')),
                ),
                h.div.children(
                  h.span.class('update-label').children(t('updates.statusLabel')),
                  h.strong.attr('role', 'status').children(statusText),
                ),
                updateState.availableVersion
                  ? h.div.children(
                      h.span.class('update-label').children(t('updates.availableLabel')),
                      h.strong.children(updateState.availableVersion),
                    )
                  : null,
              ),
            showProgress
              ? h.div.children(
                  progressBar.children(progressFill),
                  progressLabel
                    ? h.p.class('mt-1 text-[11px] text-mac-label-secondary').children(progressLabel)
                    : null,
                )
              : null,
            h.p
              .class('mt-3 text-[11px] text-mac-label-secondary')
              .children(updateCheckedLabel(updateState.checkedAt, t)),
            renderToggleRow(h, {
              id: 'updates-automatic',
              key: 'updates-automatic',
              label: t('updates.automatic'),
              description: t('updates.automaticDescription'),
              disabled: toggleDisabled,
              checked: updateState.automaticUpdates,
              onToggle: handleToggleAutomatic,
            }),
            h.div.class('update-actions').children(
              h.button
                .attr('type', 'button')
                .attr('data-slot', 'button')
                .attr('data-variant', 'secondary')
                .attr('data-size', 'xl')
                .class(buttonClasses('secondary', 'xl'))
                .disabled(actionsDisabled)
                .on('click', () => UpdatesMessage.ClickedCheck())
                .children(
                  updateState.phase === 'checking'
                    ? t('updates.checkingButton')
                    : t('updates.check'),
                ),
              updateAvailable || updateReady
                ? h.button
                    .attr('type', 'button')
                    .attr('data-slot', 'button')
                    .attr('data-variant', 'default')
                    .attr('data-size', 'xl')
                    .class(buttonClasses('default', 'xl'))
                    .disabled(updateReady ? toggleDisabled : actionsDisabled)
                    .on('click', () => UpdatesMessage.ClickedInstallOrRelaunch())
                    .children(
                      updateState.phase === 'downloading'
                        ? t('updates.downloadingButton')
                        : 'Install and Relaunch',
                    )
                : null,
            ),
            h.p
              .class(
                'mt-4 flex items-start gap-2 text-[11px] leading-[1.6] text-mac-label-secondary',
              )
              .children(iconCircleHelp(h, 'mt-0.5 size-4 shrink-0'), ' ', t('updates.restartNote')),
          ],
    );
  },
});
