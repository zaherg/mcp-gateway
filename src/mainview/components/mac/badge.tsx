import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@mcp-gateway/mainview/lib/utils';

// macOS badges are small capsules: the accent color, the grey count badge
// of a sidebar or the red badge of a Dock icon.
const badgeVariants = cva(
  'group/badge inline-flex h-[18px] w-fit min-w-[18px] shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full px-1.5 text-[11px] leading-none font-semibold whitespace-nowrap tabular-nums transition-colors outline-none focus-visible:mac-focus-ring [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'bg-mac-accent text-white [a]:hover:brightness-110',
        secondary: 'bg-mac-fill-secondary text-mac-label-secondary [a]:hover:bg-mac-fill-primary',
        destructive: 'bg-[#ec3830] text-white [a]:hover:brightness-110',
        // Status badges: dark label on a tinted fill. White on the accent or red fill fails 4.5:1
        // contrast at 11px.
        accent: 'bg-mac-accent/20 text-mac-label',
        danger: 'bg-mac-red/15 text-mac-label',
        outline:
          'text-mac-label shadow-[inset_0_0_0_1px_var(--mac-grid)] [a]:hover:bg-mac-fill-tertiary',
        ghost: 'text-mac-label-secondary hover:bg-mac-fill-tertiary',
        link: 'text-mac-link underline-offset-2 hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>({ className: cn(badgeVariants({ variant }), className) }, props),
    render,
    state: { slot: 'badge', variant },
  });
}

export { Badge, badgeVariants };
