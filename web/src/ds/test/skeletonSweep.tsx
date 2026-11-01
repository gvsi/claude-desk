/**
 * The skeleton's one band of light, checked in a real browser: the Chromium design system tests and
 * the WebKit project run the same checks. The band must sit at the same viewport x on every shape
 * at every moment, after the window resizes too, and its ends must be transparent, so its edge
 * draws no step on the shape (decisions 10 and 16 of the skeleton plan).
 */
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, onTestFinished } from 'vitest';
import { page } from 'vitest/browser';

import { Skeleton, SkeletonCard } from '../components/Skeleton/Skeleton.tsx';
import { SkeletonScreen } from '../components/Skeleton/SkeletonScreen.tsx';
import { framesWithin } from './framesWithin.ts';
import { watchRegion } from './skeletonRegion.ts';

/** The shapes the checks read, by anchor: four left edges, one in an indented card, one a wide block. */
export const SWEEP_SHAPES = ['line', 'indented', 'circle', 'wide'] as const;
type SweepShape = (typeof SWEEP_SHAPES)[number];

/** The band's left edge, in px from the wide block's left, where the edge check holds the sweep. */
const EDGE_AT = 100;

/** How far either side of the band's edge the check samples, clear of the capture's rounding. */
const EDGE_SAMPLE = 3;

/**
 * Shapes at four left edges, one in an indented card and one a wide block straight on the page, in
 * a region 600 px wide centred in the window: a resize moves them without resizing the
 * region, so only the window's own resize can tell them where they are.
 */
function SweepFixture() {
  return (
    <div style={{ width: 600, margin: '40px auto' }}>
      <SkeletonScreen
        loading
        status="Opening your Desk"
        skeleton={
          <div style={{ display: 'grid', gap: 16 }}>
            <Skeleton shape="line" text="greeting" width={360} anchor="line" />
            <div style={{ paddingLeft: 48 }}>
              <SkeletonCard>
                <Skeleton shape="block" width={420} height={40} anchor="indented" />
              </SkeletonCard>
            </div>
            <div style={{ display: 'flex', paddingLeft: 212 }}>
              <Skeleton shape="circle" anchor="circle" />
            </div>
            <div style={{ paddingLeft: 24 }}>
              <Skeleton shape="block" width={560} height={40} anchor="wide" />
            </div>
          </div>
        }
      />
    </div>
  );
}

/** The element that paints each shape, once its region shows them. */
export async function mountSweep(): Promise<Record<SweepShape, HTMLElement>> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const watch = watchRegion(host);
  flushSync(() => root.render(<SweepFixture />));
  onTestFinished(() => {
    watch.stop();
    root.unmount();
    host.remove();
  });
  await watch.reached('shown');
  const painted = (anchor: SweepShape) => {
    const shape = host.querySelector<HTMLElement>(`[data-skeleton-anchor="${anchor}"]`);
    const element = shape?.classList.contains('cd-skeleton') ? shape : shape?.querySelector<HTMLElement>('.cd-skeleton');
    if (!element) throw new Error(`no shape paints "${anchor}"`);
    return element;
  };
  return Object.fromEntries(SWEEP_SHAPES.map((anchor) => [anchor, painted(anchor)])) as Record<SweepShape, HTMLElement>;
}

/** Resolves on the next frame the browser draws. */
export function nextFrame(): Promise<number> {
  return framesWithin('cd-skeleton-sweep frame');
}

/** The band's width, from its token. */
function bandWidth(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--size-skeleton-band'));
}

/** A shape's sweep, or a thrown error when it runs none. */
function sweepOf(shape: HTMLElement): Animation {
  const sweep = shape.getAnimations().find((animation) => (animation as CSSAnimation).animationName === 'cd-skeleton-sweep');
  if (!sweep) throw new Error('the shape runs no sweep');
  return sweep;
}

/**
 * Each shape's band centre in viewport x, all read at one moment, and where the sweep's clock puts
 * it: from half a band left of the viewport to one and a half bands right of it over each loop.
 */
export function bandCentres(shapes: readonly HTMLElement[]): { centres: number[]; expected: number } {
  const band = bandWidth();
  const centres = shapes.map((shape) => shape.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(shape).backgroundPositionX) + band / 2);
  const [first] = shapes;
  if (!first) throw new Error('no shapes to read');
  const loop = Number.parseFloat(getComputedStyle(first).animationDuration) * 1000;
  const progress = (Number(sweepOf(first).currentTime) % loop) / loop;
  return { centres, expected: -band / 2 + (window.innerWidth + 2 * band) * progress };
}

/**
 * The band's centre sits at the same viewport x on every shape, within 1 px, where the sweep's clock
 * puts it in the viewport, and it is moving.
 */
export async function expectBandLinesUp(shapes: readonly HTMLElement[]): Promise<void> {
  const lefts = new Set(shapes.map((shape) => Math.round(shape.getBoundingClientRect().left)));
  expect(lefts.size, 'the shapes start at different left edges').toBe(shapes.length);
  const before = bandCentres(shapes);
  await nextFrame();
  await nextFrame();
  const after = bandCentres(shapes);
  for (const { centres, expected } of [before, after]) {
    const spread = `band centres ${centres.join(', ')}, expected ${expected}`;
    expect(Math.max(...centres) - Math.min(...centres), spread).toBeLessThanOrEqual(1);
    for (const centre of centres) expect(Math.abs(centre - expected), spread).toBeLessThanOrEqual(1);
  }
  expect(after.centres[0], 'the band moves').not.toBe(before.centres[0]);
}

/** Resizes the window and waits until the page has drawn at the new size. */
export async function resizeWindow(width: number, height: number): Promise<void> {
  const resized = new Promise((resolve) => window.addEventListener('resize', resolve, { once: true }));
  await page.viewport(width, height);
  await resized;
  await nextFrame();
  await nextFrame();
  expect(window.innerWidth).toBe(width);
}

/** A responsive render can move shapes after resize listeners ran, without resizing their region. */
export async function expectBandsFollowLateResizeLayout(): Promise<void> {
  await page.viewport(900, 700);
  onTestFinished(() => page.viewport(1280, 820));
  const host = document.createElement('div');
  host.style.width = '600px';
  document.body.append(host);
  const root = createRoot(host);
  const watch = watchRegion(host);
  onTestFinished(() => { watch.stop(); root.unmount(); host.remove(); });
  flushSync(() => root.render(
    <SkeletonScreen loading status="Loading layout" skeleton={
      <>
        <Skeleton shape="block" width={100} height={20} anchor="fixed" />
        <div data-resize-layout style={{ marginLeft: 264 }}>
          <Skeleton shape="block" width={100} height={20} anchor="moved" />
        </div>
      </>
    } />,
  ));
  await watch.reached('shown');
  await nextFrame();
  await nextFrame();
  const region = host.querySelector('.cd-skeleton-screen')!;
  const before = region.getBoundingClientRect();
  const shapes = [...host.querySelectorAll<HTMLElement>('.cd-skeleton')];
  expect(shapes[1]!.getBoundingClientRect().left - shapes[0]!.getBoundingClientRect().left).toBe(264);
  const layout = host.querySelector<HTMLElement>('[data-resize-layout]')!;
  // Registered after SkeletonScreen's listener: model the responsive commit that removes a column.
  const move = () => { layout.style.marginLeft = '0px'; };
  window.addEventListener('resize', move, { once: true });
  onTestFinished(() => window.removeEventListener('resize', move));
  await resizeWindow(620, 700);
  const after = region.getBoundingClientRect();
  expect([after.width, after.height]).toEqual([before.width, before.height]);
  expect(shapes[1]!.getBoundingClientRect().left).toBe(shapes[0]!.getBoundingClientRect().left);
  for (const shape of shapes) {
    expect(Math.abs(Number.parseFloat(shape.style.getPropertyValue('--cd-skeleton-x')) - shape.getBoundingClientRect().left)).toBeLessThanOrEqual(1);
  }
  const { centres } = bandCentres(shapes);
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
}

/** The pixels of a capture of `element`, and how many capture pixels make one CSS pixel. */
async function capture(element: HTMLElement): Promise<{ pixels: ImageData; scale: number }> {
  const base64 = await page.screenshot({ element, save: false });
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d canvas to read the capture with');
  context.drawImage(bitmap, 0, 0);
  return { pixels: context.getImageData(0, 0, bitmap.width, bitmap.height), scale: bitmap.width / element.getBoundingClientRect().width };
}

/** The red, green and blue of the capture at `x` css px from its left, on its middle row. */
function rgbAt({ pixels, scale }: { pixels: ImageData; scale: number }, x: number): number[] {
  const column = Math.round(x * scale);
  const row = Math.floor(pixels.height / 2);
  const start = (row * pixels.width + column) * 4;
  return [...pixels.data.slice(start, start + 3)];
}

/**
 * Holds the wide block's sweep with the band's left edge `EDGE_AT` px inside it, captures it, and
 * compares the pixels just outside and just inside the edge: transparent ends draw no step. The
 * band's centre, 450 px further in, is lighter, so the capture does show the band.
 */
export async function expectNoStepAtTheEdge(wide: HTMLElement): Promise<void> {
  const sweep = sweepOf(wide);
  sweep.pause();
  // The band's offset moves at an even speed, so two readings place it.
  const offsetAt = (time: number) => {
    sweep.currentTime = time;
    return Number.parseFloat(getComputedStyle(wide).backgroundPositionX);
  };
  const start = offsetAt(0);
  const perMs = (offsetAt(800) - start) / 800;
  const edge = offsetAt((EDGE_AT - start) / perMs);
  expect(Math.abs(edge - EDGE_AT)).toBeLessThan(1);

  const shot = await capture(wide);
  const outside = rgbAt(shot, edge - EDGE_SAMPLE);
  const inside = rgbAt(shot, edge + EDGE_SAMPLE);
  const centre = rgbAt(shot, edge + bandWidth() / 2);
  for (const [i, value] of outside.entries()) {
    expect(Math.abs((inside[i] ?? 0) - value), `outside ${outside.join(', ')}, inside ${inside.join(', ')}`).toBeLessThanOrEqual(1);
  }
  expect((centre[0] ?? 0) - (outside[0] ?? 0), `centre ${centre.join(', ')}, outside ${outside.join(', ')}`).toBeGreaterThanOrEqual(10);
  sweep.play();
}
