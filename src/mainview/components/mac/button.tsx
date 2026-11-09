import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@mcp-gateway/mainview/lib/utils';

// macOS 27 buttons are flat: a translucent fill, a medium-weight label and no
// shadow. Large and extra-large buttons are capsules.
const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none transition-[background-color,color,opacity] outline-none focus-visible:mac-focus-ring disabled:pointer-events-none data-disabled:pointer-events-none aria-invalid:mac-focus-ring [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // The window's default button: filled with the accent color.
        default:
          'bg-mac-accent text-mac-accent-foreground active:brightness-90 disabled:opacity-45',
        // Darker than --mac-red so white text keeps 4.5:1 contrast.
        destructive:
          'bg-[color-mix(in_srgb,var(--mac-red)_80%,black)] text-white active:brightness-90 disabled:opacity-45',
        // The standard macOS push button ("Bordered").
        secondary:
          'bg-mac-control text-mac-label active:bg-mac-control-pressed disabled:bg-mac-control-disabled disabled:text-mac-label-tertiary',
        // An accent-tinted button ("Bordered - Tinted").
        tinted: 'bg-mac-accent/20 text-mac-accent active:bg-mac-accent/30 disabled:opacity-45',
        // A bordered button without fill, e.g. inside grouped content.
        outline:
          'bg-transparent text-mac-label shadow-[inset_0_0_0_1px_var(--mac-grid)] hover:bg-mac-fill-tertiary active:bg-mac-control-pressed disabled:text-mac-label-tertiary',
        // Borderless button, as used in toolbars and title bars.
        ghost:
          'text-mac-label hover:bg-mac-fill-tertiary active:bg-mac-control-pressed disabled:text-mac-label-tertiary',
        link: 'h-auto px-0 text-mac-link underline-offset-2 hover:underline disabled:opacity-45',
      },
      size: {
        default:
          "h-6 rounded-[6px] px-4 text-mac-body has-[>svg]:px-3 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-4 gap-1 rounded-[4px] px-[7px] text-[10px] [&_svg:not([class*='size-'])]:size-2.5",
        sm: "h-5 gap-1 rounded-[5px] px-2.5 text-mac-subheadline [&_svg:not([class*='size-'])]:size-3",
        lg: "h-7 rounded-full px-4 text-mac-body [&_svg:not([class*='size-'])]:size-4",
        xl: "h-9 rounded-full px-4 text-mac-body [&_svg:not([class*='size-'])]:size-4",
        icon: "size-6 rounded-[6px] [&_svg:not([class*='size-'])]:size-3.5",
        'icon-xs': "size-4 rounded-[4px] [&_svg:not([class*='size-'])]:size-2.5",
        'icon-sm': "size-5 rounded-[5px] [&_svg:not([class*='size-'])]:size-3",
        'icon-lg': "size-7 rounded-full [&_svg:not([class*='size-'])]:size-4",
        'icon-xl': "size-9 rounded-full [&_svg:not([class*='size-'])]:size-[18px]",
      },
    },
    // App density: a plain <Button> is the standard 36px bordered push button.
    defaultVariants: {
      variant: 'secondary',
      size: 'xl',
    },
  },
);

// Base UI's Button. To render a link or another element with the button's
// styles, pass it as `render` (with `nativeButton={false}` when it isn't a
// <button>).
function Button({
  className,
  variant = 'secondary',
  size = 'xl',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
