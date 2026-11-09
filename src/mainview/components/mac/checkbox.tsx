import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';

import { cn } from '@mcp-gateway/mainview/lib/utils';

// A macOS 27 checkbox: a 16px rounded square filled with the accent color
// when checked. In an inactive window the fill turns grey and the mark dark.
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer group/checkbox size-4 shrink-0 rounded-[5.5px] bg-mac-fill-primary text-white outline-none focus-visible:mac-focus-ring active:bg-black/19 data-disabled:cursor-not-allowed data-disabled:opacity-40 aria-invalid:mac-focus-ring data-checked:bg-mac-accent data-indeterminate:bg-mac-accent dark:active:bg-white/19 group-data-[inactive]/window:data-checked:bg-black/14 group-data-[inactive]/window:data-checked:text-black/70 group-data-[inactive]/window:data-indeterminate:bg-black/14 group-data-[inactive]/window:data-indeterminate:text-black/70 dark:group-data-[inactive]/window:data-checked:bg-white/18 dark:group-data-[inactive]/window:data-checked:text-white/70 dark:group-data-[inactive]/window:data-indeterminate:bg-white/18 dark:group-data-[inactive]/window:data-indeterminate:text-white/70',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid size-full place-content-center text-current transition-none"
      >
        <svg
          viewBox="0 0 10 10"
          aria-hidden="true"
          className="size-[9.5px] group-data-indeterminate/checkbox:hidden"
        >
          <path
            d="M1.4 5.4 3.9 8 8.6 1.9"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="hidden h-0.5 w-[6.5px] rounded-full bg-current group-data-indeterminate/checkbox:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
