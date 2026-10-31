/**
 * A touch phone's pointer for the design system's browser tests, and the box a tap lands a control
 * in. `coarsePointer()` turns on Chromium's touch emulation, under which `(pointer: coarse)` matches,
 * for the rest of the test. `hitArea()` is the element's box grown by its `::after` hit area, read
 * off the computed style; `expectHitAreaLands()` proves it with the browser's own hit testing.
 */
import { expect, onTestFinished } from 'vitest';
import { cdp } from 'vitest/browser';

/** Sets the pointer a phone has: coarse, with no hover, as a visitor's touch screen would. */
async function touch(on: boolean): Promise<void> {
  await cdp().send('Emulation.setTouchEmulationEnabled', on ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
}

/** A coarse pointer for the rest of the test; the fine one comes back after it. */
export async function coarsePointer(): Promise<void> {
  await touch(true);
  onTestFinished(() => touch(false));
  expect(window.matchMedia('(pointer: coarse)').matches, 'a coarse pointer').toBe(true);
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function box(left: number, top: number, right: number, bottom: number): Box {
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/**
 * Where a tap lands `element`: its border box, grown to its `::after` hit area where it has one. The
 * hit area is absolutely positioned against the element's padding box, so its offsets are read from
 * there.
 */
export function hitArea(element: Element): Box {
  const own = element.getBoundingClientRect();
  const after = getComputedStyle(element, '::after');
  if (after.content === 'none' || after.position !== 'absolute') return box(own.left, own.top, own.right, own.bottom);
  const style = getComputedStyle(element);
  const px = (value: string) => Number.parseFloat(value);
  const left = own.left + px(style.borderLeftWidth) + px(after.left);
  const top = own.top + px(style.borderTopWidth) + px(after.top);
  const right = own.right - px(style.borderRightWidth) - px(after.right);
  const bottom = own.bottom - px(style.borderBottomWidth) - px(after.bottom);
  return box(Math.min(left, own.left), Math.min(top, own.top), Math.max(right, own.right), Math.max(bottom, own.bottom));
}

/**
 * The browser's hit testing agrees with `hitArea`: a point 1 px inside each edge of the hit area
 * lands on the element, and a point 1 px outside it doesn't.
 */
export function expectHitAreaLands(element: Element, label = element.textContent ?? ''): void {
  const area = hitArea(element);
  const midX = (area.left + area.right) / 2;
  const midY = (area.top + area.bottom) / 2;
  const inside: [string, number, number][] = [
    ['top', midX, area.top + 1],
    ['bottom', midX, area.bottom - 1],
    ['left', area.left + 1, midY],
    ['right', area.right - 1, midY],
  ];
  for (const [edge, x, y] of inside) {
    expect(element.contains(document.elementFromPoint(x, y)), `${label}: a tap just inside its hit area's ${edge} edge lands on it`).toBe(true);
  }
  const outside: [string, number, number][] = [
    ['top', midX, area.top - 1],
    ['bottom', midX, area.bottom + 1],
    ['left', area.left - 1, midY],
    ['right', area.right + 1, midY],
  ];
  for (const [edge, x, y] of outside) {
    expect(element.contains(document.elementFromPoint(x, y)), `${label}: a tap just past its hit area's ${edge} edge misses it`).toBe(false);
  }
}

/** Two hit areas share no point: a tap between two controls lands on one of them, never on both. */
export function expectApart(a: Box, b: Box, label: string): void {
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  expect(overlapX <= 0 || overlapY <= 0, `${label}: the hit areas don't overlap (${JSON.stringify({ a, b })})`).toBe(true);
}

/** Nothing about the hit area is drawn: no fill, border, outline or shadow. */
export function expectUnseen(element: Element): void {
  const after = getComputedStyle(element, '::after');
  expect(
    {
      backgroundColor: after.backgroundColor,
      backgroundImage: after.backgroundImage,
      borderStyle: after.borderStyle,
      outlineStyle: after.outlineStyle,
      boxShadow: after.boxShadow,
    },
    'the hit area draws nothing',
  ).toEqual({ backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', borderStyle: 'none', outlineStyle: 'none', boxShadow: 'none' });
}
