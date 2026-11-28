import type { Html } from '@effect/ui/html';

export const svgIcon = <M>(
  h: Html.H<M>,
  sizeClass: string,
  paths: ReadonlyArray<string>,
  strokeWidth = '2',
) =>
  h.svg
    .class(sizeClass)
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', strokeWidth)
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(...paths.map((d) => h.path.attr('d', d)));

export const iconX = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  svgIcon(h, sizeClass, ['M18 6 6 18', 'm6 6 12 12']);

export const iconChevronsUpDown = <M>(h: Html.H<M>) =>
  h.svg
    .class(
      'pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2 text-mac-label group-data-[size=sm]/native-select:size-2.5',
    )
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2.5')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .attr('data-slot', 'native-select-icon')
    .children(h.path.attr('d', 'm7 15 5 5 5-5'), h.path.attr('d', 'm7 9 5-5 5 5'));

export const iconArrowDownToLine = <M>(h: Html.H<M>, sizeClass = 'size-4') =>
  svgIcon(h, sizeClass, ['M12 17V3', 'm6 11 6 6 6-6', 'M19 21H5']);

export const iconCircleHelp = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  svgIcon(h, sizeClass, [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z',
    'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3',
    'M12 17h.01',
  ]);

export const iconCopy = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  svgIcon(h, sizeClass, [
    'M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z',
    'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2',
  ]);

export const iconCheck = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  svgIcon(h, sizeClass, ['M20 6 9 17l-5-5']);

export const iconLoader = <M>(h: Html.H<M>, sizeClass = 'size-3.5 motion-safe:animate-spin') =>
  svgIcon(h, sizeClass, ['M21 12a9 9 0 1 1-6.219-8.56']);

export const iconPlugZap = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  svgIcon(h, sizeClass, [
    'M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z',
    'm2 22 3-3',
    'M7.5 13.5 10 11',
    'M10.5 16.5 13 14',
    'm18 3-4 4h6l-4 4',
  ]);

export const iconPencil = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  svgIcon(h, sizeClass, [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4',
  ]);

export const iconTrash = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  svgIcon(h, sizeClass, [
    'M3 6h18',
    'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6',
    'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2',
    'M10 11v6',
    'M14 11v6',
  ]);

export const iconEraser = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  svgIcon(h, sizeClass, [
    'M21 21H8a2 2 0 0 1-1.42-.587l-3.994-3.999a2 2 0 0 1 0-2.828l10-10a2 2 0 0 1 2.829 0l5.999 6a2 2 0 0 1 0 2.828L12.834 21',
    'm5.082 11.09 8.828 8.828',
  ]);

export const iconCode2 = <M>(h: Html.H<M>, sizeClass = 'size-6') =>
  svgIcon(h, sizeClass, ['m18 16 4-4-4-4', 'm6 8-4 4 4 4', 'm14.5 4-5 16']);

export const iconServer = <M>(h: Html.H<M>) =>
  h.svg
    .class('size-6')
    .attr('width', '24')
    .attr('height', '24')
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(
      h.rect
        .attr('width', '20')
        .attr('height', '8')
        .attr('x', '2')
        .attr('y', '2')
        .attr('rx', '2')
        .attr('ry', '2'),
      h.rect
        .attr('width', '20')
        .attr('height', '8')
        .attr('x', '2')
        .attr('y', '14')
        .attr('rx', '2')
        .attr('ry', '2'),
      h.path.attr('d', 'M6 6h.01'),
      h.path.attr('d', 'M6 18h.01'),
    );

export const iconEye = <M>(h: Html.H<M>, sizeClass = 'size-4') =>
  h.svg
    .class(sizeClass)
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(
      h.path.attr(
        'd',
        'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0',
      ),
      h.circle.attr('cx', '12').attr('cy', '12').attr('r', '3'),
    );

export const iconEyeOff = <M>(h: Html.H<M>, sizeClass = 'size-4') =>
  svgIcon(h, sizeClass, [
    'M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49',
    'M14.084 14.158a3 3 0 0 1-4.242-4.242',
    'M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143',
    'm2 2 20 20',
  ]);

export const iconLock = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  h.svg
    .class(sizeClass)
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(
      h.rect
        .attr('width', '18')
        .attr('height', '11')
        .attr('x', '3')
        .attr('y', '11')
        .attr('rx', '2')
        .attr('ry', '2'),
      h.path.attr('d', 'M7 11V7a5 5 0 0 1 10 0v4'),
    );

export const iconPlus = <M>(h: Html.H<M>, sizeClass = 'size-4') =>
  svgIcon(h, sizeClass, ['M5 12h14', 'M12 5v14']);

export const iconMinus = <M>(h: Html.H<M>, sizeClass = 'size-3.5') =>
  svgIcon(h, sizeClass, ['M5 12h14']);

export const iconAlertTriangle = <M>(
  h: Html.H<M>,

  sizeClass = 'size-4 shrink-0 text-mac-red-ink',
) =>
  svgIcon(h, sizeClass, [
    'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3',
    'M12 9v4',
    'M12 17h.01',
  ]);

export const iconChevronRight = <M>(h: Html.H<M>, sizeClass = 'size-4 raw-chevron') =>
  svgIcon(h, sizeClass, ['m9 18 6-6-6-6']);

export const iconNetwork = <M>(h: Html.H<M>, sizeClass = 'size-[18px]') =>
  h.svg
    .class(sizeClass)
    .attr('viewBox', '0 0 24 24')
    .attr('fill', 'none')
    .attr('stroke', 'currentColor')
    .attr('stroke-width', '2')
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round')
    .attr('aria-hidden', 'true')
    .children(
      h.rect.attr('x', '16').attr('y', '16').attr('width', '6').attr('height', '6').attr('rx', '1'),
      h.rect.attr('x', '2').attr('y', '16').attr('width', '6').attr('height', '6').attr('rx', '1'),
      h.rect.attr('x', '9').attr('y', '2').attr('width', '6').attr('height', '6').attr('rx', '1'),
      h.path.attr('d', 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3'),
      h.path.attr('d', 'M12 12V8'),
    );

export const iconActivity = <M>(h: Html.H<M>, sizeClass = 'size-[22px]') =>
  svgIcon(h, sizeClass, [
    'M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2',
  ]);
