import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the macOS theme scales, so e.g. `text-mac-body`
// (a font size) is not mistaken for a text color and dropped.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        'mac-large-title',
        'mac-title-1',
        'mac-title-2',
        'mac-title-3',
        'mac-headline',
        'mac-body',
        'mac-callout',
        'mac-subheadline',
        'mac-footnote',
        'mac-caption',
      ],
      radius: [
        'mac-control',
        'mac-menu',
        'mac-item',
        'mac-group',
        'mac-popover',
        'mac-alert',
        'mac-window',
      ],
      shadow: [
        'mac-menu',
        'mac-popover',
        'mac-tooltip',
        'mac-dock',
        'mac-window',
        'mac-window-inactive',
        'mac-focus',
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
