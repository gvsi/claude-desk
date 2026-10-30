/**
 * The icons drawn for Claude Desk (the rest are Lucide's own shapes) sit on the center of their
 * 24-unit grid, so in a round tile or beside a line of text they look centered. Measured from the
 * browser's own geometry of each shape; the stroke and round caps widen the box evenly on every
 * side, so they don't move its center.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { Icon, type IconName } from './index.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Drawn for Claude Desk in Lucide's style, as the icon module's header says. */
const OWN_ICONS: readonly IconName[] = ['agent', 'person', 'clock', 'menu', 'shared', 'quote'];

/** The union of an icon's shapes' boxes, in grid units. */
function drawnBox(svg: SVGSVGElement): { left: number; top: number; right: number; bottom: number } {
  const boxes = [...svg.children].map((shape) => (shape as SVGGraphicsElement).getBBox());
  return {
    left: Math.min(...boxes.map((b) => b.x)),
    top: Math.min(...boxes.map((b) => b.y)),
    right: Math.max(...boxes.map((b) => b.x + b.width)),
    bottom: Math.max(...boxes.map((b) => b.y + b.height)),
  };
}

it('own_icons_sit_on_the_grid_center', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <>
        {OWN_ICONS.map((name) => (
          <Icon key={name} name={name} />
        ))}
      </>,
    ),
  );

  const offCenter: string[] = [];
  const svgs = [...container.querySelectorAll('svg')];
  expect(svgs).toHaveLength(OWN_ICONS.length);
  svgs.forEach((svg, index) => {
    const box = drawnBox(svg);
    const dx = (box.left + box.right) / 2 - 12;
    const dy = (box.top + box.bottom) / 2 - 12;
    // A quarter of a unit is 0.2 px at 20 px: under what an eye can see.
    if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) {
      offCenter.push(`${OWN_ICONS[index]}: center off by ${dx.toFixed(2)}, ${dy.toFixed(2)} units`);
    }
  });
  expect(offCenter).toEqual([]);

  act(() => root.unmount());
  container.remove();
});

/** Lucide's "history": a clock's face drawn as an arrow turning back, with its hands. */
const LUCIDE_HISTORY = ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2'];

it('history_is_lucides_history_at_the_effective_stroke', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  // The Recorded tag draws it at 14 px, beside caption text.
  act(() => root.render(<Icon name="history" size={14} />));

  const svg = container.querySelector('svg');
  expect(svg?.getAttribute('aria-hidden')).toBe('true');
  expect([...(svg?.querySelectorAll('path') ?? [])].map((path) => path.getAttribute('d'))).toEqual(LUCIDE_HISTORY);
  // 1.5 px at 14 px is 24 × 1.5 / 14 units of the grid.
  expect(Number(svg?.getAttribute('stroke-width'))).toBeCloseTo((1.5 * 24) / 14, 6);
  // Lucide's shape is centered on the grid too, so beside a line of text it looks centered.
  const box = drawnBox(svg as SVGSVGElement);
  expect(Math.abs((box.left + box.right) / 2 - 12)).toBeLessThanOrEqual(0.25);
  expect(Math.abs((box.top + box.bottom) / 2 - 12)).toBeLessThanOrEqual(0.25);

  act(() => root.unmount());
  container.remove();
});
