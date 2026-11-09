import type * as React from 'react';

import { cn } from '@mcp-gateway/mainview/lib/utils';

// A macOS 27 text field: 36px tall in this app (registry default 24px), 6px corners, a hairline border.
function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 rounded-[6px] bg-mac-field px-2 text-mac-body font-medium text-mac-label shadow-[0_0_0_1px_var(--mac-field-border)] transition-[box-shadow] outline-none selection:bg-mac-accent/30 file:inline-flex file:h-5 file:border-0 file:bg-transparent file:text-mac-body file:font-medium file:text-mac-label placeholder:font-normal placeholder:text-mac-label-tertiary disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:shadow-[0_0_0_1px_var(--mac-field-border),0_0_0_3.5px_color-mix(in_srgb,var(--mac-accent)_50%,transparent),inset_0_0_0_1px_color-mix(in_srgb,var(--mac-accent)_50%,transparent)]',
        'aria-invalid:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--mac-red)_50%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
