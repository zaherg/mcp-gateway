import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the macOS theme scales, so e.g. `text-mac-body`
// (a font size) is not mistaken for a text color and dropped.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['mac-title-1', 'mac-headline', 'mac-body', 'mac-subheadline'],
      radius: ['mac-control', 'mac-popover'],
      shadow: ['mac-popover'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
