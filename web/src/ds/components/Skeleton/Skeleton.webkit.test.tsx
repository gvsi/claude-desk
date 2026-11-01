/**
 * The skeleton's sweep in WebKit, the engine of every browser on an iPhone, where most people will
 * open a public chat link. iOS Safari ignores a fixed background, so the band lines up by each
 * shape's measured offset instead; these are the Chromium checks in `Skeleton.browser.test.tsx`,
 * run in the `ds-webkit` project with motion on: the band lines up across shapes at every left edge,
 * after a resize too, and its edge draws no step.
 */
import { expect, it, onTestFinished } from 'vitest';
import { page } from 'vitest/browser';

import { SWEEP_SHAPES, expectBandLinesUp, expectBandsFollowLateResizeLayout, expectNoStepAtTheEdge, mountSweep, resizeWindow } from '../../test/skeletonSweep.tsx';

it('band_lines_up_across_shapes_in_webkit', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(false);
  onTestFinished(() => page.viewport(1280, 820));
  const shapes = await mountSweep();
  const all = SWEEP_SHAPES.map((anchor) => shapes[anchor]);
  await expectBandLinesUp(all);
  // The region keeps its width and moves with the window; the band still lines up.
  const left = shapes.line.getBoundingClientRect().left;
  await resizeWindow(900, 700);
  expect(shapes.line.getBoundingClientRect().left).not.toBe(left);
  await expectBandLinesUp(all);
});

it('band_edge_draws_no_step_in_webkit', async () => {
  const shapes = await mountSweep();
  await expectNoStepAtTheEdge(shapes.wide);
});

it('bands_follow_a_late_resize_layout_with_an_unchanged_region', expectBandsFollowLateResizeLayout);
