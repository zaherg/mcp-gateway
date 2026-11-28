import { UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Schema } from 'effect';

import {
  KeyMigrationSchema,
  KeyMigrationStatusSchema,
  type KeyMigrationValue,
} from '@mcp-gateway/mainview/effect-app/schemas';
import { buttonClasses, renderModal } from '@mcp-gateway/mainview/effect-ui';
import { type Locale, type Translate, translator } from '@mcp-gateway/shared/i18n';

export const KeyMigrationProps = Schema.Struct({
  locale: Schema.String,
  slots: KeyMigrationSchema,
  dirty: Schema.Boolean,
  busy: Schema.Boolean,
  status: KeyMigrationStatusSchema,
  error: Schema.NullOr(Schema.String),
  filename: Schema.String,
});

export const KeyMigrationModel = Schema.Struct({
  step: Schema.Literals(['what', 'confirm']),
  /** Frozen on Continue: the live list can change while the dialog is open and empties on success. */
  reviewed: KeyMigrationSchema,
  dismissedResult: Schema.Boolean,
});

export const KeyMigrationMessage = UiSchema.TaggedEnum({
  ClickedKeep: {},
  ClickedContinue: {},
  ClickedBack: {},
  ClickedMove: {},
  ClickedTryAgain: {},
  ClickedClose: {},
});

export const KeyMigrationEvent = UiSchema.TaggedEnum({
  RequestedKeep: {},
  RequestedClose: {},
  /** Moves exactly the slots the user reviewed, never ones that became eligible since. */
  RequestedMove: { slots: KeyMigrationSchema },
});

const slotNames = (list: KeyMigrationValue, t: Translate): string[] => [
  ...(list.gateway ? [t('keys.global')] : []),
  ...list.servers.map((name) => t('keys.server', { name })),
];

export const KeyMigrationView = Html.component({
  name: 'KeyMigrationView',
  props: KeyMigrationProps,
  model: KeyMigrationModel,
  message: KeyMigrationMessage,
  events: KeyMigrationEvent,
}).make({
  init: ($) =>
    $.set({
      step: 'what',
      reviewed: { gateway: $.props.slots.gateway, servers: [...$.props.slots.servers] },
      dismissedResult: false,
    }),
  update: {
    ClickedKeep: ($) => $.emit(KeyMigrationEvent.RequestedKeep()),
    ClickedContinue: ($) =>
      $.evolve({
        step: 'confirm' as const,
        reviewed: { gateway: $.props.slots.gateway, servers: [...$.props.slots.servers] },
        dismissedResult: true,
      }),
    ClickedBack: ($) => $.evolve({ step: 'what' as const, dismissedResult: true }),
    ClickedMove: ($) =>
      $.evolve({ dismissedResult: false }).emit(
        KeyMigrationEvent.RequestedMove({ slots: $.model.reviewed }),
      ),
    // Back to review: a stale or changed list must be confirmed again, not resent.
    ClickedTryAgain: ($) => $.evolve({ step: 'what' as const, dismissedResult: true }),
    ClickedClose: ($) => $.emit(KeyMigrationEvent.RequestedClose()),
  },
  view: (h, model) => {
    const t = translator(h.props.locale as Locale);
    const { slots, dirty, busy, status, error, filename } = h.props;
    const effectiveStep: 'what' | 'confirm' | 'done' | 'failed' =
      !model.dismissedResult && status === 'done'
        ? 'done'
        : !model.dismissedResult && status === 'failed'
          ? 'failed'
          : model.step;
    const shown = slotNames(effectiveStep === 'what' ? slots : model.reviewed, t);

    const body =
      dirty && effectiveStep !== 'done'
        ? [
            h.p.class('dialog-intro').children(t('keys.saveFirst')),
            h.div.class('dialog-actions').children(
              h.button
                .attr('type', 'button')
                .attr('data-slot', 'button')
                .attr('data-variant', 'secondary')
                .attr('data-size', 'xl')
                .class(buttonClasses('secondary', 'xl'))
                .disabled(busy)
                .on('click', () => KeyMigrationMessage.ClickedClose())
                .children(t('common.cancel')),
            ),
          ]
        : effectiveStep === 'what'
          ? [
              h.p.class('dialog-intro').children(t('keys.step1')),
              h.p.children(t('keys.intro', { filename })),
              h.p.children(t('keys.downgrade')),
              h.h3.children(t('keys.list')),
              h.ul.children(
                ...shown.map((name) =>
                  h.li.children(
                    h.span.children(name),
                    ' ',
                    h.code.class('masked-secret').attr('aria-hidden', 'true').children('••••••••'),
                  ),
                ),
              ),
              h.div.class('dialog-actions').children(
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'secondary')
                  .attr('data-size', 'xl')
                  .class(buttonClasses('secondary', 'xl'))
                  .disabled(busy)
                  .on('click', () => KeyMigrationMessage.ClickedKeep())
                  .children(t('keys.keep')),
                h.button
                  .attr('type', 'button')
                  .attr('data-slot', 'button')
                  .attr('data-variant', 'default')
                  .attr('data-size', 'xl')
                  .class(buttonClasses('default', 'xl'))
                  .disabled(busy || shown.length === 0)
                  .on('click', () => KeyMigrationMessage.ClickedContinue())
                  .children(t('keys.continue')),
              ),
            ]
          : effectiveStep === 'confirm'
            ? [
                h.p.class('dialog-intro').children(t('keys.step2')),
                h.p.children(t('keys.oneWay')),
                h.div.class('dialog-actions').children(
                  h.button
                    .attr('type', 'button')
                    .attr('data-slot', 'button')
                    .attr('data-variant', 'secondary')
                    .attr('data-size', 'xl')
                    .class(buttonClasses('secondary', 'xl'))
                    .disabled(busy)
                    .on('click', () => KeyMigrationMessage.ClickedBack())
                    .children(t('keys.back')),
                  h.button
                    .attr('type', 'button')
                    .attr('data-slot', 'button')
                    .attr('data-variant', 'default')
                    .attr('data-size', 'xl')
                    .class(buttonClasses('default', 'xl'))
                    .disabled(busy)
                    .on('click', () => KeyMigrationMessage.ClickedMove())
                    .children(
                      shown.length === 1
                        ? t('keys.moveOne')
                        : t('keys.moveMany', { count: shown.length }),
                    ),
                ),
              ]
            : effectiveStep === 'done'
              ? [
                  h.p.attr('role', 'status').children(t('keys.moved')),
                  h.div.class('dialog-actions').children(
                    h.button
                      .attr('type', 'button')
                      .attr('data-slot', 'button')
                      .attr('data-variant', 'default')
                      .attr('data-size', 'xl')
                      .class(buttonClasses('default', 'xl'))
                      .disabled(busy)
                      .on('click', () => KeyMigrationMessage.ClickedClose())
                      .children(t('keys.done')),
                  ),
                ]
              : [
                  h.p.attr('role', 'alert').children(t('keys.failed')),
                  error ? h.p.class('inline-error').children(error) : null,
                  h.div.class('dialog-actions').children(
                    h.button
                      .attr('type', 'button')
                      .attr('data-slot', 'button')
                      .attr('data-variant', 'secondary')
                      .attr('data-size', 'xl')
                      .class(buttonClasses('secondary', 'xl'))
                      .disabled(busy)
                      .on('click', () => KeyMigrationMessage.ClickedClose())
                      .children(t('common.cancel')),
                    h.button
                      .attr('type', 'button')
                      .attr('data-slot', 'button')
                      .attr('data-variant', 'default')
                      .attr('data-size', 'xl')
                      .class(buttonClasses('default', 'xl'))
                      .disabled(busy)
                      .on('click', () => KeyMigrationMessage.ClickedTryAgain())
                      .children(t('keys.tryAgain')),
                  ),
                ];

    return renderModal(h, {
      titleId: 'key-migration-title',
      title: t('keys.title'),
      closeLabel: t('common.closeDialog'),
      busy,
      onClose: KeyMigrationMessage.ClickedClose(),
      body,
    });
  },
});
