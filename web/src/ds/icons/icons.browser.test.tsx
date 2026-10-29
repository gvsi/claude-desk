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
const OWN_ICONS: readonly IconName[] = ['agent', 'person', 'clock', 'menu'];

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
