import { ChevronsUpDownIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '@mcp-gateway/mainview/lib/utils';

type NativeSelectProps = Omit<React.ComponentProps<'select'>, 'size'> & {
  size?: 'sm' | 'default';
};

// The browser's own <select>, dressed as a macOS pop-up button. It opens
// the system menu, which suits long lists and phones.
// App defaults: 36px tall (registry 24px) and full width (registry fits its content).
function NativeSelect({ className, size = 'default', ...props }: NativeSelectProps) {
  return (
    <div
      className={cn(
        'group/native-select relative w-full has-[select:disabled]:opacity-50',
        className,
      )}
      data-slot="native-select-wrapper"
      data-size={size}
    >
      <select
        data-slot="native-select"
        data-size={size}
        className="h-9 w-full min-w-0 cursor-default appearance-none rounded-lg bg-mac-control py-0 pr-7 pl-3 text-mac-body font-medium text-mac-label outline-none select-none focus-visible:mac-focus-ring active:bg-mac-control-pressed disabled:pointer-events-none aria-invalid:mac-focus-ring data-[size=sm]:h-5 data-[size=sm]:rounded-[5px] data-[size=sm]:pl-2.5 data-[size=sm]:text-mac-subheadline"
        {...props}
      />
      <ChevronsUpDownIcon
        className="pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-mac-label group-data-[size=sm]/native-select:size-2.5"
        strokeWidth={2.5}
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({ className, ...props }: React.ComponentProps<'option'>) {
  return (
    <option
      data-slot="native-select-option"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({ className, ...props }: React.ComponentProps<'optgroup'>) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
