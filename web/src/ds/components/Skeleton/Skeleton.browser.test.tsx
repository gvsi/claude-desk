/**
 * The skeleton in Chromium. Under prefers-reduced-motion: reduce, which this project's browser
 * context emulates, the shapes are still, the part replaces them at once with no fade, a region
 * that takes over from it shows its shapes in that same commit, and a part that loads again waits
 * again. With motion on, the band lines up across shapes at every left edge,
 * after a resize too, and its edge draws no step (`Skeleton.webkit.test.tsx` runs the same two
 * checks in WebKit).
 */
import { composeStory } from '@storybook/react-vite';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';
import { page } from 'vitest/browser';

import { motion } from '../../test/reducedMotion.ts';
import { partsOf, regionIn, watchRegion } from '../../test/skeletonRegion.ts';
import { SWEEP_SHAPES, expectBandLinesUp, expectBandsFollowLateResizeLayout, expectNoStepAtTheEdge, mountSweep, nextFrame, resizeWindow } from '../../test/skeletonSweep.tsx';
import { Skeleton } from './Skeleton.tsx';
import meta, { Continues, Lands, Sweep } from './Skeleton.stories.tsx';
import { SKELETON_DELAY_MS, SkeletonScreen } from './SkeletonScreen.tsx';

/**
 * Renders a story without its play, as a page would draw it, in a container of its own, so a watch
 * started before it never reads an earlier test's render.
 */
async function renderBare(story: typeof Sweep, name: string, canvasElement: HTMLElement) {
  await composeStory({ ...story, play: undefined }, meta, undefined, name).run({ canvasElement });
}

/** A fresh container on the page, taken off it when the test finishes. */
function container(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  onTestFinished(() => element.remove());
  return element;
}

it('skeleton_is_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const root = container();
  const watch = watchRegion(root);
  try {
    await renderBare(Sweep, 'Sweep', root);
    await watch.reached('shown');
    const shapes = [...root.querySelectorAll<HTMLElement>('.cd-skeleton')];
    expect(shapes.length).toBeGreaterThan(20);
    for (const shape of shapes) {
      expect(shape.getAnimations()).toEqual([]);
      expect(getComputedStyle(shape).animationName).toBe('none');
    }
    // Still, they keep their fill: the band is out of view, so nothing on them changes.
    expect(new Set(shapes.map((shape) => getComputedStyle(shape).backgroundColor))).toEqual(new Set(['rgba(250, 249, 245, 0.06)']));
    expect(partsOf(regionIn(root) as HTMLElement).status.textContent).toBe('Opening your Desk');
  } finally {
    watch.stop();
  }
});

it('skeleton_leaves_at_once_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  // In the commit the load ends, the layer is gone and the people are drawn: no fade, no leaving.
  let landedWithIt: boolean | null = null;
  const root = container();
  const watch = watchRegion(root, (state) => {
    if (state === 'gone') landedWithIt = root.querySelector('ul[aria-label="Contacts on record"]') !== null;
  });
  try {
    await renderBare(Lands, 'Lands', root);
    await watch.reached('gone', 4000);
    expect(watch.states.map((entry) => entry.state)).toEqual(['waiting', 'shown', 'gone']);
    expect(landedWithIt).toBe(true);
    const { region, body, status } = partsOf(regionIn(root) as HTMLElement);
    expect(body.hasAttribute('aria-busy')).toBe(false);
    expect(status.textContent).toBe('');
    expect(getComputedStyle(region).position).toBe('static');
  } finally {
    watch.stop();
  }
});

it('skeleton_continues_at_once_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  // A reload of Customers: the full-page shapes go at once, with no fade, and Customers' own region
  // shows its shapes in that same commit, so no frame goes without shapes.
  let firstFrame: { inner: string | undefined; status: string | null; outer: string } | null = null;
  const root = container();
  const watch = watchRegion(root, (state) => {
    const inner = root.querySelectorAll<HTMLElement>('.cd-skeleton-screen')[1];
    if (!inner || firstFrame) return;
    const parts = partsOf(inner);
    firstFrame = { inner: parts.layer?.dataset.state, status: parts.status.textContent, outer: state };
  });
  try {
    await renderBare(Continues, 'Continues', root);
    await watch.reached('gone', 4000);
    expect(watch.states.map((entry) => entry.state)).toEqual(['waiting', 'shown', 'gone']);
    expect(firstFrame).toEqual({ inner: 'shown', status: 'Loading your customers', outer: 'gone' });
    // It keeps them while the people are read.
    await new Promise((resolve) => setTimeout(resolve, SKELETON_DELAY_MS));
    const inner = partsOf(root.querySelectorAll<HTMLElement>('.cd-skeleton-screen')[1] as HTMLElement);
    expect(inner.layer?.dataset.state).toBe('shown');
    expect(inner.body.getAttribute('aria-busy')).toBe('true');
  } finally {
    watch.stop();
  }
});

it('skeleton_hand_off_lasts_one_commit_under_reduced_motion', async () => {
  // The hand-off is for a region that mounts as the part lands. One that mounts in the part later,
  // with no shapes on screen, waits as usual, so a fast read there still shows nothing.
  const root = container();
  const react = createRoot(root);
  onTestFinished(() => react.unmount());
  const shape = <Skeleton shape="line" text="section" width={150} />;
  const draw = (loading: boolean, later: boolean) =>
    flushSync(() =>
      react.render(
        <SkeletonScreen loading={loading} status="Opening your Desk" skeleton={shape}>
          {later ? <SkeletonScreen loading status="Loading your customers" skeleton={shape} /> : <h1>Customers</h1>}
        </SkeletonScreen>,
      ),
    );
  const watch = watchRegion(root);
  try {
    draw(true, false);
    await watch.reached('shown');
    draw(false, false);
    await watch.reached('gone');
    await nextFrame();
    await nextFrame();
    draw(false, true);
    const later = partsOf(root.querySelectorAll<HTMLElement>('.cd-skeleton-screen')[1] as HTMLElement);
    expect(later.layer?.dataset.state).toBe('waiting');
    expect(later.status.textContent).toBe('');
  } finally {
    watch.stop();
  }
});

it('skeleton_waits_again_when_loading_returns', async () => {
  // A part that reads again from nothing (its data dropped) goes back to the wait, not straight to
  // the shapes: a fast second read still shows nothing.
  const root = container();
  const react = createRoot(root);
  onTestFinished(() => react.unmount());
  const draw = (loading: boolean) =>
    flushSync(() =>
      react.render(
        <SkeletonScreen loading={loading} status="Loading your customers" skeleton={<Skeleton shape="line" text="section" width={150} />}>
          <p>Contacts on record</p>
        </SkeletonScreen>,
      ),
    );
  const watch = watchRegion(root);
  try {
    draw(true);
    await watch.reached('shown');
    // The watch reads each commit once its records arrive, a microtask later.
    draw(false);
    await Promise.resolve();
    draw(true);
    await Promise.resolve();
    const again = performance.now();
    const { body, status, layer } = partsOf(regionIn(root) as HTMLElement);
    expect(watch.states.map((entry) => entry.state)).toEqual(['waiting', 'shown', 'gone', 'waiting']);
    expect(layer?.dataset.state).toBe('waiting');
    expect(body.getAttribute('aria-busy')).toBe('true');
    expect(status.textContent).toBe('');
    expect(root.textContent).toBe('');
    await expect.poll(() => layer?.dataset.state).toBe('shown');
    expect(performance.now() - again).toBeGreaterThanOrEqual(SKELETON_DELAY_MS);
    expect(status.textContent).toBe('Loading your customers');
  } finally {
    watch.stop();
  }
});

it('band_lines_up_across_shapes_in_chromium', async () => {
  await motion();
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

it('band_edge_draws_no_step_in_chromium', async () => {
  await motion();
  const shapes = await mountSweep();
  await expectNoStepAtTheEdge(shapes.wide);
});

it('bands_follow_a_late_resize_layout_with_an_unchanged_region', async () => {
  await motion();
  await expectBandsFollowLateResizeLayout();
});
