import { Mount, type View } from '@effect/ui';
import type { Html } from '@effect/ui/html';
import { Effect, Stream } from 'effect';

import { iconX } from '@mcp-gateway/mainview/effect-ui/icons';
import { buttonClasses } from '@mcp-gateway/mainview/effect-ui/primitives';

/**
 * Captures the focused element when a modal `<dialog>` mounts (before `showModal()`
 * moves focus inside) and restores focus to it (or to `[data-fallback-focus]`) when
 * the modal unmounts, matching the prior React Modal. The modal presentation itself
 * (`showModal()` / `close()` / `cancel`) is handled natively by `@effect/ui`'s
 * `h.dialog.modal(true)`.
 */
export const RestoreDialogFocus = Mount.makeStream(
  'mcp-gateway/ui/RestoreDialogFocus',
  { beforeCommit: true },
  (dialog: HTMLDialogElement) =>
    Stream.callback<never>((_queue) =>
      Effect.acquireRelease(
        Effect.sync(() => (typeof document === 'undefined' ? null : document.activeElement)),
        (opener) =>
          Effect.sync(() => {
            if (typeof document === 'undefined') return;
            // Exclude the closing dialog itself: mount teardown runs before DOM removal.
            const hasOtherOpenDialog = Array.from(document.querySelectorAll('dialog[open]')).some(
              (el) => el !== dialog,
            );
            if (hasOtherOpenDialog) return;
            if (
              opener instanceof HTMLElement &&
              opener !== document.body &&
              opener !== document.documentElement &&
              opener.isConnected &&
              !dialog.contains(opener) &&
              !opener.matches(':disabled')
            ) {
              opener.focus();
            } else {
              document.querySelector<HTMLElement>('[data-fallback-focus]')?.focus();
            }
          }),
      ).pipe(Effect.asVoid),
    ),
);

export const renderModal = <M, C extends View.Children<M>>(
  h: Html.H<M>,
  options: {
    readonly titleId: string;
    readonly title: string;
    readonly closeLabel: string;
    readonly busy?: boolean;
    readonly onClose: M;
    readonly body: C;
  },
) => {
  const busy = options.busy ?? false;
  let dialog = h.dialog
    .modal(true)
    .attr('aria-labelledby', options.titleId)
    .onMount(RestoreDialogFocus());
  if (!busy) {
    dialog = dialog.on('cancel', () => options.onClose);
  }
  return dialog.children(
    h.div.class('dialog-heading').children(
      h.h2.attr('id', options.titleId).children(options.title),
      h.button
        .attr('type', 'button')
        .attr('data-slot', 'button')
        .attr('data-variant', 'ghost')
        .attr('data-size', 'icon-lg')
        .attr('aria-label', options.closeLabel)
        .disabled(busy)
        .class(buttonClasses('ghost', 'icon-lg'))
        .on('click', () => (busy ? undefined : options.onClose))
        .children(iconX(h, 'size-4')),
    ),
    options.body,
  );
};
