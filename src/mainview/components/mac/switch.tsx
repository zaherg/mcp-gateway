import { Switch as SwitchPrimitive } from '@base-ui/react/switch';

import { cn } from '@mcp-gateway/mainview/lib/utils';

// A macOS 27 switch: a capsule track with a pill-shaped knob. Sizes follow
// the macOS control sizes; System Settings uses `mini` in its grouped forms.
//   mini 36x16 (knob 21x13) · sm 44x20 (26x16) · default 54x24 (32x20) · lg 64x28 (38x24)
interface SwitchProps extends SwitchPrimitive.Root.Props {
  size?: 'mini' | 'sm' | 'default' | 'lg';
}

function Switch({ className, size = 'default', ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        'peer group/switch inline-flex shrink-0 items-center rounded-full transition-colors outline-none focus-visible:mac-focus-ring data-disabled:cursor-not-allowed data-disabled:opacity-40',
        'data-[size=mini]:h-4 data-[size=mini]:w-9 data-[size=mini]:px-[1.5px] data-[size=sm]:h-5 data-[size=sm]:w-11 data-[size=sm]:px-0.5 data-[size=default]:h-6 data-[size=default]:w-13.5 data-[size=default]:px-0.5 data-[size=lg]:h-7 data-[size=lg]:w-16 data-[size=lg]:px-0.5',
        'data-checked:bg-mac-accent data-unchecked:bg-black/8.5 dark:data-unchecked:bg-white/8.5 group-data-inactive/window:data-checked:bg-black/14 dark:group-data-inactive/window:data-checked:bg-white/13',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'pointer-events-none block rounded-full bg-white shadow-[0_3px_36px_rgb(0_0_0/0.05),0_0_0_0.5px_rgb(0_0_0/0.04),0_1px_2px_rgb(0_0_0/0.12)] transition-transform duration-200 dark:shadow-none dark:group-data-inactive/window:bg-[#e2e2e2]',
          'group-data-[size=mini]/switch:h-3.25 group-data-[size=mini]/switch:w-5.25 group-data-[size=sm]/switch:h-4 group-data-[size=sm]/switch:w-6.5 group-data-[size=default]/switch:h-5 group-data-[size=default]/switch:w-8 group-data-[size=lg]/switch:h-6 group-data-[size=lg]/switch:w-9.5',
          'data-unchecked:translate-x-0 group-data-[size=mini]/switch:data-checked:translate-x-3 group-data-[size=sm]/switch:data-checked:translate-x-3.5 group-data-[size=default]/switch:data-checked:translate-x-4.5 group-data-[size=lg]/switch:data-checked:translate-x-5.5',
          // Right to left, the knob moves the other way.
          'rtl:group-data-[size=mini]/switch:data-checked:-translate-x-3 rtl:group-data-[size=sm]/switch:data-checked:-translate-x-3.5 rtl:group-data-[size=default]/switch:data-checked:-translate-x-4.5 rtl:group-data-[size=lg]/switch:data-checked:-translate-x-5.5',
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
