import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from '@mcp-gateway/mainview/lib/utils';

// A macOS 27 switch: a capsule track with a pill-shaped knob. Sizes follow
// the macOS control sizes; System Settings uses `mini` in its grouped forms.
//   mini 36x16 (knob 21x13) · sm 44x20 (26x16)
interface SwitchProps extends SwitchPrimitive.Root.Props {
  size?: 'mini' | 'sm';
}

function Switch({ className, size = 'sm', ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch inline-flex shrink-0 items-center rounded-full transition-colors outline-none focus-visible:mac-focus-ring data-disabled:cursor-not-allowed data-disabled:opacity-40',
        'data-[size=mini]:h-4 data-[size=mini]:w-9 data-[size=mini]:px-[1.5px] data-[size=sm]:h-5 data-[size=sm]:w-11 data-[size=sm]:px-0.5',
        'data-checked:bg-mac-accent data-unchecked:bg-black/8.5 dark:data-unchecked:bg-white/8.5 group-data-inactive/window:data-checked:bg-black/14 dark:group-data-inactive/window:data-checked:bg-white/13',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-white shadow-[0_3px_36px_rgb(0_0_0/0.05),0_0_0_0.5px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.12)] transition-transform duration-200 dark:shadow-none dark:group-data-inactive/window:bg-[#e2e2e2]',
          'group-data-[size=mini]/switch:h-3.25 group-data-[size=mini]/switch:w-5.25 group-data-[size=sm]/switch:h-4 group-data-[size=sm]/switch:w-6.5',
          'data-unchecked:translate-x-0 group-data-[size=mini]/switch:data-checked:translate-x-3 group-data-[size=sm]/switch:data-checked:translate-x-3.5',
          // Right to left, the knob moves the other way.
          'rtl:group-data-[size=mini]/switch:data-checked:-translate-x-3 rtl:group-data-[size=sm]/switch:data-checked:-translate-x-3.5',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
