import type { View } from '@effect/ui';
import type { Html } from '@effect/ui/html';
import { Checkbox, Switch } from '@effect/ui-kit';

import { iconChevronsUpDown, iconX } from '@mcp-gateway/mainview/effect-ui/icons';

export type ButtonVariant = 'default' | 'destructive' | 'secondary' | 'outline' | 'ghost' | 'link';
export type ButtonSize = 'lg' | 'xl' | 'icon' | 'icon-lg' | 'icon-xl';
export type AlertKind = 'error' | 'warning' | 'success';

export const BUTTON_BASE =
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none transition-[background-color,color,opacity] outline-none focus-visible:mac-focus-ring disabled:pointer-events-none data-disabled:pointer-events-none aria-invalid:mac-focus-ring [&_svg]:pointer-events-none [&_svg]:shrink-0';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  default: 'bg-mac-accent text-mac-accent-foreground active:brightness-90 disabled:opacity-45',
  destructive:
    'bg-[color-mix(in_srgb,var(--mac-red)_80%,black)] text-white active:brightness-90 disabled:opacity-45',
  secondary:
    'bg-mac-control text-mac-label active:bg-mac-control-pressed disabled:bg-mac-control-disabled disabled:text-mac-label-tertiary',
  outline:
    'bg-transparent text-mac-label shadow-[inset_0_0_0_1px_var(--mac-grid)] hover:bg-mac-fill-tertiary active:bg-mac-control-pressed disabled:text-mac-label-tertiary',
  ghost:
    'text-mac-label hover:bg-mac-fill-tertiary active:bg-mac-control-pressed disabled:text-mac-label-tertiary',
  link: 'h-auto px-0 text-mac-link underline-offset-2 hover:underline disabled:opacity-45',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  lg: "h-7 rounded-full px-4 text-mac-body [&_svg:not([class*='size-'])]:size-4",
  xl: "h-9 rounded-full px-4 text-mac-body [&_svg:not([class*='size-'])]:size-4",
  icon: "size-6 rounded-[6px] [&_svg:not([class*='size-'])]:size-3.5",
  'icon-lg': "size-7 rounded-full [&_svg:not([class*='size-'])]:size-4",
  'icon-xl': "size-9 rounded-full [&_svg:not([class*='size-'])]:size-[18px]",
};

export const buttonClasses = (
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'xl',
  extra?: string,
) =>
  extra
    ? `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]} ${extra}`
    : `${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${BUTTON_SIZES[size]}`;

export const ALERT_BASE =
  "group/alert relative grid w-full gap-0.5 rounded-[10px] px-3 py-2.5 text-left text-mac-body has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-px *:[svg:not([class*='size-'])]:size-4 mb-4 flex items-center gap-2.5 text-mac-label";

const ALERT_VARIANTS: Record<AlertKind, string> = {
  error:
    'bg-mac-red/8 text-mac-red shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mac-red)_30%,transparent)] *:[svg]:text-current',
  warning:
    'bg-mac-yellow/12 text-mac-label shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mac-yellow)_35%,transparent)] *:[svg]:text-mac-orange',
  success:
    'bg-mac-fill-quaternary text-mac-label shadow-[inset_0_0_0_1px_var(--mac-grid)] *:[svg]:text-mac-blue',
};

export const alertClasses = (kind: AlertKind = 'error', extra?: string) =>
  extra
    ? `${ALERT_BASE} ${ALERT_VARIANTS[kind]} ${extra}`
    : `${ALERT_BASE} ${ALERT_VARIANTS[kind]}`;

export const INPUT_CLASSES =
  'h-9 w-full min-w-0 rounded-[6px] bg-mac-field px-2 text-mac-body font-medium text-mac-label shadow-[0_0_0_1px_var(--mac-field-border)] transition-[box-shadow] outline-none selection:bg-mac-accent/30 file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-mac-body file:font-medium file:text-mac-label placeholder:font-normal placeholder:text-mac-label-tertiary disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:shadow-[0_0_0_1px_var(--mac-field-border),0_0_0_3.5px_color-mix(in_srgb,var(--mac-accent)_50%,transparent),inset_0_0_0_1px_color-mix(in_srgb,var(--mac-accent)_50%,transparent)] aria-invalid:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--mac-red)_50%,transparent)]';

export const inputClasses = (extra?: string) =>
  extra ? `${INPUT_CLASSES} ${extra}` : INPUT_CLASSES;

export const LABEL_BASE_CLASSES =
  'flex items-center gap-1.5 text-mac-body leading-none font-normal text-mac-label select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50';

export const LABEL_CLASSES = `${LABEL_BASE_CLASSES} font-semibold`;

export const SELECT_CLASSES =
  'h-9 w-full min-w-0 cursor-default appearance-none rounded-lg bg-mac-control py-0 pr-7 pl-3 text-mac-body font-medium text-mac-label outline-none select-none focus-visible:mac-focus-ring active:bg-mac-control-pressed disabled:pointer-events-none aria-invalid:mac-focus-ring data-[size=md]:h-7 data-[size=md]:rounded-mac-control data-[size=sm]:h-5 data-[size=sm]:rounded-[5px] data-[size=sm]:pl-2.5 data-[size=sm]:text-mac-subheadline';

export const SELECT_WRAPPER_CLASSES =
  'group/native-select relative w-full has-[select:disabled]:opacity-50';

export const SELECT_OPTION_CLASSES = 'bg-[Canvas] text-[CanvasText]';

export const SWITCH_ROOT_CLASSES =
  'peer group/switch inline-flex shrink-0 items-center rounded-full transition-colors outline-none focus-visible:mac-focus-ring data-disabled:cursor-not-allowed data-disabled:opacity-40 data-[size=mini]:h-4 data-[size=mini]:w-9 data-[size=mini]:px-[1.5px] data-[size=sm]:h-5 data-[size=sm]:w-11 data-[size=sm]:px-0.5 data-checked:bg-mac-accent data-unchecked:bg-black/8.5 dark:data-unchecked:bg-white/8.5 group-data-inactive/window:data-checked:bg-black/14 dark:group-data-inactive/window:data-checked:bg-white/13';

export const SWITCH_THUMB_CLASSES =
  'pointer-events-none block rounded-full bg-white shadow-[0_3px_36px_rgb(0_0_0/0.05),0_0_0_0.5px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.12)] transition-transform duration-200 dark:shadow-none dark:group-data-inactive/window:bg-[#e2e2e2] group-data-[size=mini]/switch:h-3.25 group-data-[size=mini]/switch:w-5.25 group-data-[size=sm]/switch:h-4 group-data-[size=sm]/switch:w-6.5 data-unchecked:translate-x-0 group-data-[size=mini]/switch:data-checked:translate-x-3 group-data-[size=sm]/switch:data-checked:translate-x-3.5 rtl:group-data-[size=mini]/switch:data-checked:-translate-x-3 rtl:group-data-[size=sm]/switch:data-checked:-translate-x-3.5';

export const CHECKBOX_ROOT_CLASSES =
  'peer group/checkbox size-4 shrink-0 rounded-[5.5px] bg-mac-fill-primary text-white outline-none focus-visible:mac-focus-ring active:bg-black/19 data-disabled:cursor-not-allowed data-disabled:opacity-40 aria-invalid:mac-focus-ring data-checked:bg-mac-accent data-indeterminate:bg-mac-accent dark:active:bg-white/19 group-data-[inactive]/window:data-checked:bg-black/14 group-data-[inactive]/window:data-checked:text-black/70 group-data-[inactive]/window:data-indeterminate:bg-black/14 group-data-[inactive]/window:data-indeterminate:text-black/70 dark:group-data-[inactive]/window:data-checked:bg-white/18 dark:group-data-[inactive]/window:data-checked:text-white/70 dark:group-data-[inactive]/window:data-indeterminate:bg-white/18 dark:group-data-[inactive]/window:data-indeterminate:text-white/70';

export const CHECKBOX_INDICATOR_CLASSES =
  'grid size-full place-content-center text-current transition-none';

export const renderAlert = <M, R = never>(
  h: Html.H<M>,
  options: {
    readonly kind?: AlertKind;
    readonly role?: 'alert' | 'status';
    readonly dismissLabel: string;
    readonly onDismiss: M;
    readonly content: View.Input<M, R>;
    readonly className?: string;
  },
) => {
  const kind = options.kind ?? 'error';
  const role = options.role ?? (kind === 'success' ? 'status' : 'alert');
  return h.div
    .attr('data-slot', 'alert')
    .attr('role', role)
    .class(alertClasses(kind, options.className))
    .children(
      h.span.class('min-w-0 flex-1 wrap-anywhere').children(options.content),
      h.button
        .attr('type', 'button')
        .attr('data-slot', 'button')
        .attr('data-variant', 'ghost')
        .attr('data-size', 'icon')
        .attr('aria-label', options.dismissLabel)
        .class(buttonClasses('ghost', 'icon'))
        .on('click', () => options.onDismiss)
        .children(iconX(h)),
    );
};

export const renderNativeSelect = <M, C extends View.Children<M>>(
  h: Html.H<M>,
  options: {
    readonly id?: string;
    readonly value: string;
    readonly disabled?: boolean;
    readonly ariaLabel?: string;
    readonly ariaDescribedBy?: string;
    readonly size?: 'sm' | 'md' | 'default';
    readonly wrapperClass?: string;
    readonly onChange: (value: string) => M;
    readonly options: C;
  },
) => {
  const size = options.size ?? 'default';
  let select = h.select
    .attr('data-slot', 'native-select')
    .attr('data-size', size)
    .class(SELECT_CLASSES)
    .value(options.value)
    .disabled(options.disabled ?? false)
    .on('change', (event) => options.onChange(event.value));
  if (options.id) select = select.attr('id', options.id);
  if (options.ariaLabel) select = select.attr('aria-label', options.ariaLabel);
  if (options.ariaDescribedBy) select = select.attr('aria-describedby', options.ariaDescribedBy);

  return h.div
    .class(
      options.wrapperClass
        ? `${SELECT_WRAPPER_CLASSES} ${options.wrapperClass}`
        : SELECT_WRAPPER_CLASSES,
    )
    .attr('data-slot', 'native-select-wrapper')
    .attr('data-size', size)
    .children(select.children(options.options), iconChevronsUpDown(h));
};

export const renderField = <M, R = never>(
  h: Html.H<M>,
  options: {
    readonly id: string;
    readonly label: string;
    readonly help?: string;
    readonly layout?: 'stack' | 'row';
    readonly control: View.Input<M, R>;
  },
) => {
  const labelNode = h.label
    .attr('for', options.id)
    .attr('id', `${options.id}-label`)
    .attr('data-slot', 'label')
    .class(LABEL_CLASSES)
    .children(options.label);
  const helpNode = options.help
    ? h.small.attr('id', `${options.id}-help`).children(options.help)
    : null;

  if (options.layout === 'row') {
    return h.div
      .class('field-row')
      .children(h.div.class('field-row-copy').children(labelNode, helpNode), options.control);
  }
  return h.div.class('field').children(labelNode, options.control, helpNode);
};

export const renderToggleRow = <M>(
  h: Html.H<M>,
  options: {
    readonly key?: string;
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly checked: boolean;
    readonly disabled?: boolean;
    readonly onToggle: (checked: boolean) => M;
  },
) =>
  Switch(h, {
    ...(options.key !== undefined ? { key: options.key } : {}),
    props: { checked: options.checked, disabled: options.disabled ?? false },
    onToggle: ({ checked }) => options.onToggle(checked),
    view: (parts) =>
      h.label
        .class('toggle-row')
        .attr('for', options.id)
        .children(
          h.span.children(h.strong.children(options.label), h.small.children(options.description)),
          parts
            .root(
              h.button
                .attr('id', options.id)
                .attr('data-slot', 'switch')
                .attr('data-size', 'sm')
                .class(SWITCH_ROOT_CLASSES),
            )
            .children(
              parts.thumb(h.span.attr('data-slot', 'switch-thumb').class(SWITCH_THUMB_CLASSES)),
            ),
        ),
  });

export const renderCheckboxRow = <M>(
  h: Html.H<M>,
  options: {
    readonly key?: string;
    readonly id: string;
    readonly label: string;
    readonly checked: boolean;
    readonly disabled: boolean;
    readonly onToggle: (checked: boolean) => M;
  },
) => {
  const handleToggle = ({ checked }: { readonly checked: boolean }) => options.onToggle(checked);
  return Checkbox(h, {
    ...(options.key !== undefined ? { key: options.key } : {}),
    props: { checked: options.checked, disabled: options.disabled },
    onEmit: { Toggled: handleToggle },
    view: (parts) =>
      h.div
        .class('checkbox-row')
        .children(
          parts
            .root(
              h.button
                .attr('id', options.id)
                .attr('data-slot', 'checkbox')
                .class(CHECKBOX_ROOT_CLASSES),
            )
            .children(
              parts
                .indicator(
                  h.span.attr('data-slot', 'checkbox-indicator').class(CHECKBOX_INDICATOR_CLASSES),
                )
                .children(
                  options.checked
                    ? h.svg
                        .attr('viewBox', '0 0 10 10')
                        .attr('aria-hidden', 'true')
                        .class('size-[9.5px] group-data-indeterminate/checkbox:hidden')
                        .children(
                          h.path
                            .attr('d', 'M1.4 5.4 3.9 8 8.6 1.9')
                            .attr('fill', 'none')
                            .attr('stroke', 'currentColor')
                            .attr('stroke-width', '1.9')
                            .attr('stroke-linecap', 'round')
                            .attr('stroke-linejoin', 'round'),
                        )
                    : null,
                ),
            ),
          h.label
            .attr('for', options.id)
            .attr('data-slot', 'label')
            .class(`${LABEL_BASE_CLASSES} text-mac-label-secondary`)
            .children(options.label),
        ),
  });
};
