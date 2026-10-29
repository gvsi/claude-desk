/**
 * The Claude Desk mark's geometry on its 20-unit grid: a rounded square with one horizontal line,
 * as the design canvas draws it. `Mark` renders from it, and so does the design system artifact's
 * standalone SVG, so the two can't drift. Color is not geometry: the mark is stroked in clay.
 */
export const MARK_GEOMETRY = {
  viewBox: '0 0 20 20',
  rect: { x: 2.75, y: 2.75, width: 14.5, height: 14.5, rx: 4 },
  path: 'M6.5 11.5h7',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;
