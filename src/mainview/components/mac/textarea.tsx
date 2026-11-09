import type * as React from 'react';

import { cn } from '@mcp-gateway/mainview/lib/utils';

// App defaults: a fixed-height, vertically resizable monospace box (registry grows with its
// content), because every textarea here edits JSON.
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-fixed min-h-18 w-full resize-y font-mono leading-relaxed rounded-[6px] bg-mac-field px-2 py-1 text-mac-body font-medium text-mac-label shadow-[0_0_0_1px_var(--mac-field-border)] transition-[box-shadow] outline-none selection:bg-mac-accent/30 placeholder:font-normal placeholder:text-mac-label-tertiary disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:shadow-[0_0_0_1px_var(--mac-field-border),0_0_0_3.5px_color-mix(in_srgb,var(--mac-accent)_50%,transparent),inset_0_0_0_1px_color-mix(in_srgb,var(--mac-accent)_50%,transparent)]',
        'aria-invalid:shadow-[0_0_0_3.5px_color-mix(in_srgb,var(--mac-red)_50%,transparent)]',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
