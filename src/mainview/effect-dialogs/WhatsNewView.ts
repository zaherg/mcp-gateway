import { UiSchema } from '@effect/ui';
import { Html } from '@effect/ui/html';
import { Schema } from 'effect';

import { buttonClasses, renderModal } from '@mcp-gateway/mainview/effect-ui';
import { changelogBlocks, changelogSection } from '@mcp-gateway/shared/changelog';
import { type Locale, translator } from '@mcp-gateway/shared/i18n';
import bundledChangelog from '../../../CHANGELOG.md?raw';

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/;

/** Renders inline code and bold; a link keeps its text only, because the window cannot navigate. */
const renderInline = <M>(h: Html.H<M>, text: string) =>
  text.split(INLINE).map((part) => {
    if (part.startsWith('`')) return h.code.children(part.slice(1, -1));
    if (part.startsWith('**')) return h.strong.children(part.slice(2, -2));
    if (part.startsWith('[') && part.endsWith(')')) return part.slice(1, part.indexOf(']('));
    return part;
  });

export const WhatsNewProps = Schema.Struct({
  locale: Schema.String,
  version: Schema.String,
  changelogText: Schema.optional(Schema.String),
});

export const WhatsNewModel = Schema.Struct({});

export const WhatsNewMessage = UiSchema.TaggedEnum({
  Closed: {},
});

export const WhatsNewEvent = UiSchema.TaggedEnum({
  Closed: {},
});

export const WhatsNewView = Html.component({
  name: 'WhatsNewView',
  props: WhatsNewProps,
  model: WhatsNewModel,
  message: WhatsNewMessage,
  events: WhatsNewEvent,
}).make({
  init: ($) => $.set({}),
  update: {
    Closed: ($) => $.emit(WhatsNewEvent.Closed()),
  },
  view: (h) => {
    const t = translator(h.props.locale as Locale);
    const source = h.props.changelogText ?? bundledChangelog;
    const section = changelogSection(source, h.props.version);
    if (!section) return h.text('');
    return renderModal(h, {
      titleId: 'whats-new-title',
      title: t('whatsNew.title', { version: h.props.version }),
      closeLabel: t('common.closeDialog'),
      onClose: WhatsNewMessage.Closed(),
      body: [
        h.div
          .class('whats-new')
          .children(
            ...changelogBlocks(section).map((block) =>
              block.kind === 'list'
                ? h.ul.children(
                    ...block.items.map((item) => h.li.children(...renderInline(h, item))),
                  )
                : block.kind === 'heading'
                  ? h.h3.children(block.text)
                  : h.p.children(...renderInline(h, block.text)),
            ),
          ),
        h.div.class('dialog-actions').children(
          h.button
            .attr('type', 'button')
            .attr('data-slot', 'button')
            .attr('data-variant', 'default')
            .attr('data-size', 'xl')
            .class(buttonClasses('default', 'xl'))
            .on('click', () => WhatsNewMessage.Closed())
            .children(t('whatsNew.done')),
        ),
      ],
    });
  },
});
