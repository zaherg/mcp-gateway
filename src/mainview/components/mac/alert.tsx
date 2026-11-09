import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@mcp-gateway/mainview/lib/utils';

// An inline callout in a pane: a tinted rounded box with a symbol, a title
// and a description.
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-[10px] px-3 py-2.5 text-left text-mac-body has-data-[slot=alert-action]:pr-24 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-px *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          'bg-mac-fill-quaternary text-mac-label shadow-[inset_0_0_0_1px_var(--mac-grid)] *:[svg]:text-mac-blue',
        warning:
          'bg-mac-yellow/12 text-mac-label shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mac-yellow)_35%,transparent)] *:[svg]:text-mac-orange',
        destructive:
          'bg-mac-red/8 text-mac-red shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--mac-red)_30%,transparent)] *:data-[slot=alert-description]:text-mac-red/85 *:[svg]:text-current',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        'font-semibold group-has-[>svg]/alert:col-start-2 [&_a]:text-mac-link [&_a]:hover:underline',
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'text-mac-body text-balance text-mac-label-secondary md:text-pretty [&_a]:text-mac-link [&_a]:hover:underline [&_p:not(:last-child)]:mb-3',
        className,
      )}
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div data-slot="alert-action" className={cn('absolute top-2 right-2', className)} {...props} />
  );
}

export { Alert, AlertAction, AlertDescription, AlertTitle };
