import { expect, onTestFinished, vi } from 'vitest';

import { SKELETON_DELAY_MS } from '../ds/index.ts';
import { expectComputed } from '../ds/test/expectComputed.ts';
import { CONCEPT_FOOTER_TEXT } from '../ds/test/copy.ts';
import { loadWebFonts } from '../ds/test/fonts.ts';
import { reduceMotion } from '../ds/test/reducedMotion.ts';
import { partsOf, type LayerState, type RegionParts } from '../ds/test/skeletonRegion.ts';
import { bandCentres } from '../ds/test/skeletonSweep.tsx';
import { tokenColor } from './screen.ts';

export const SKELETON_TOLERANCE_PX = 2;
export interface SkeletonAnchor {
  name: string;
  page: string;
  size?: boolean;
  /** Extra dimensions when only width or height is predictable before data arrives. */
  dimensions?: readonly ('width' | 'height' | 'bottom')[];
}
export interface SkeletonLoad {
  status: string;
  anchors: readonly SkeletonAnchor[];
  stays?: readonly string[];
  open: () => Promise<void>;
  release: () => void;
  continues?: boolean;
}

/** Shared layout classes also occur in the layer: only measure the landed page outside it. */
function findLanded(selector: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>(selector)].find((el) => !el.closest('.cd-skeleton-screen__layer'));
}

function landed(selector: string): HTMLElement {
  const element = findLanded(selector);
  if (!element) throw new Error(`No landed element for ${selector}`);
  return element;
}

function compare(shape: DOMRect, real: DOMRect, label: string, size = false, dimensions: readonly ('width' | 'height' | 'bottom')[] = []): void {
  for (const edge of size ? (['top', 'left', 'width', 'height'] as const) : (['top', 'left', ...dimensions] as const)) {
    expect(Math.abs(shape[edge] - real[edge]), `${label} ${edge}: shape ${shape[edge]}, page ${real[edge]}`).toBeLessThanOrEqual(
      SKELETON_TOLERANCE_PX,
    );
  }
}

/** Observe commits, so even a short fade or a reduced-motion replacement cannot escape the check. */
function watchLoad(load: SkeletonLoad) {
  let region: HTMLElement | undefined;
  let appeared = 0;
  const states: { state: LayerState; at: number }[] = [];
  let first: RegionParts | undefined;
  let firstVisibility: string | undefined;
  let firstStatus: string | null = null;
  let firstBusy: string | null = null;
  let leaving: { style: { name: string; duration: string; pointer: string }; anchors: (DOMRect | undefined)[] } | undefined;
  let replaced: (DOMRect | undefined)[] | undefined;
  let replacementFrame = 0;
  let replacementPaint: Promise<void> | undefined;
  let replacementPainted = false;
  // Several regions can load together. Keep each mount's history until its status identifies it.
  const candidates = new Map<
    HTMLElement,
    {
      first: RegionParts;
      appeared: number;
      visibility: string;
      status: string | null;
      busy: string | null;
      states: { state: LayerState; at: number }[];
    }
  >();
  const read = () => {
    if (!region) {
      for (const element of document.querySelectorAll<HTMLElement>('.cd-skeleton-screen')) {
        if (element.children.length < 2) continue;
        const parts = partsOf(element);
        if (!parts.layer) continue;
        const state = parts.layer.dataset.state as LayerState;
        let candidate = candidates.get(element);
        if (!candidate) {
          candidate = {
            first: parts,
            appeared: performance.now(),
            visibility: getComputedStyle(parts.layer).visibility,
            status: parts.status.textContent,
            busy: parts.body.getAttribute('aria-busy'),
            states: [],
          };
          candidates.set(element, candidate);
        }
        if (candidate.states.at(-1)?.state !== state) candidate.states.push({ state, at: performance.now() });
        if (parts.status.textContent !== load.status) continue;
        region = element;
        first = candidate.first;
        appeared = candidate.appeared;
        firstVisibility = candidate.visibility;
        firstStatus = candidate.status;
        firstBusy = candidate.busy;
        states.push(...candidate.states);
        break;
      }
    }
    if (!region || region.children.length < 2) return;
    const parts = partsOf(region);
    const state = (parts.layer?.dataset.state ?? 'gone') as LayerState;
    if (states.at(-1)?.state !== state) states.push({ state, at: performance.now() });
    if (state === 'leaving' && parts.layer && !leaving) {
      const style = getComputedStyle(parts.layer);
      leaving = {
        style: { name: style.animationName, duration: style.animationDuration, pointer: style.pointerEvents },
        anchors: load.anchors.map(() => undefined),
      };
    }
    if (state === 'gone' && !replaced) {
      replaced = load.anchors.map(() => undefined);
      replacementPaint = new Promise<void>((resolve) => {
        replacementFrame = requestAnimationFrame(() => {
          // Include commits before the replacement's first paint, then freeze missing slots too.
          read();
          replacementPainted = true;
          resolve();
        });
      });
    }
    if (state === 'leaving' || state === 'gone') {
      // A page can commit its anchors separately during the fade. Never backfill a leaving
      // position from a later commit after the layer has gone.
      load.anchors.forEach((anchor, i) => {
        const positions = state === 'leaving' ? leaving?.anchors : replacementPainted ? undefined : replaced;
        if (!positions || positions[i]) return;
        positions[i] = findLanded(anchor.page)?.getBoundingClientRect();
      });
    }
  };
  const observer = new MutationObserver(read);
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-state', 'aria-busy'],
  });
  const stop = () => {
    observer.disconnect();
    cancelAnimationFrame(replacementFrame);
  };
  onTestFinished(stop);
  return {
    states,
    appeared: () => appeared,
    first: () => first,
    firstVisibility: () => firstVisibility,
    firstStatus: () => firstStatus,
    firstBusy: () => firstBusy,
    parts: () => {
      if (!region) throw new Error('No loading region');
      return partsOf(region);
    },
    leaving: () => leaving,
    replaced: () => replaced,
    replacementPaint: () => replacementPaint,
    stop,
  };
}

async function checkLoad(load: SkeletonLoad, still: boolean): Promise<void> {
  await loadWebFonts();
  const watch = watchLoad(load);
  try {
    await checkWatchedLoad(load, still, watch);
  } finally {
    watch.stop();
  }
}

async function checkWatchedLoad(load: SkeletonLoad, still: boolean, watch: ReturnType<typeof watchLoad>): Promise<void> {
  await load.open();
  await vi.waitFor(() => expect(watch.states.some(({ state }) => state === 'shown')).toBe(true), { timeout: load.status === 'Reading your rules' || load.status === 'Drafting your rules' ? 4_000 : 1_000 });
  const { status, body, layer } = watch.parts();
  expect(layer).not.toBeNull();
  const shapesLayer = layer!;
  expect(watch.firstBusy()).toBe('true');
  expect(watch.states[0]?.state).toBe(load.continues ? 'shown' : 'waiting');
  expect(watch.firstStatus()).toBe(load.continues ? load.status : '');
  if (!load.continues) {
    expect(watch.firstVisibility()).toBe('hidden');
    expect(watch.states.find(({ state }) => state === 'shown')!.at - watch.appeared()).toBeGreaterThanOrEqual(SKELETON_DELAY_MS);
  }
  expect(status.textContent).toBe(load.status);
  expect(status.classList.contains('cd-sr-only')).toBe(true);
  expect(status.closest('[aria-busy]')).toBeNull();
  expectComputed(status, { position: 'absolute', width: '1px', height: '1px' });
  expect(body.getAttribute('aria-busy')).toBe('true');
  expect(shapesLayer.getAttribute('aria-hidden')).toBe('true');
  expect(shapesLayer.hasAttribute('inert')).toBe(true);
  expect(shapesLayer.querySelector('button, a[href], input, select, textarea, [tabindex]')).toBeNull();
  const words = shapesLayer.cloneNode(true) as HTMLElement;
  words.querySelectorAll('.cd-concept-footer').forEach((footer) => {
    const powered = footer.querySelector('.cd-concept-footer__powered');
    const expected = CONCEPT_FOOTER_TEXT + (powered ? 'Powered by Claude Desk' : '');
    expect(footer.textContent?.replace(/\s+/g, ' ').trim()).toBe(expected);
    footer.remove();
  });
  expect(words.textContent?.trim()).toBe('');

  const painted = [...shapesLayer.querySelectorAll<HTMLElement>('.cd-skeleton')].filter((el) => el.getClientRects().length > 0);
  expect(painted.length).toBeGreaterThan(0);
  const times: number[] = [];
  for (const shape of painted) {
    expectComputed(shape, { backgroundColor: tokenColor('--fill-hover'), animationName: still ? 'none' : 'cd-skeleton-sweep' });
    const style = getComputedStyle(shape);
    expect(style.backgroundImage).toContain('rgba(0, 0, 0, 0) 0px');
    expect(style.backgroundImage).toContain(`${tokenColor('--fill-secondary')} 50%`);
    expect(style.backgroundImage).toContain('rgba(0, 0, 0, 0) 100%');
    if (still) expect(shape.getAnimations().filter((a) => a.playState === 'running')).toHaveLength(0);
    else {
      expectComputed(shape, { animationDuration: '1.6s', animationTimingFunction: 'linear', animationIterationCount: 'infinite' });
      times.push(Number(shape.getAnimations()[0]?.currentTime));
    }
  }
  if (!still) {
    const { centres } = bandCentres(painted);
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
    expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(17);
  }
  const anchors = load.anchors.map((anchor) => {
    const element = shapesLayer.querySelector(`[data-skeleton-anchor="${anchor.name}"]`);
    if (!element) throw new Error(`No shape for ${anchor.name}`);
    return element.getBoundingClientRect();
  });
  const stays = (load.stays ?? []).map((selector) => landed(selector).getBoundingClientRect());
  load.release();
  await vi.waitFor(() => expect(watch.states.some(({ state }) => state === 'gone')).toBe(true), { timeout: load.status === 'Reading your rules' || load.status === 'Drafting your rules' ? 4_000 : 1_000 });
  await watch.replacementPaint();
  if (!still) expect(watch.leaving(), 'the layer never started leaving').toBeDefined();
  for (const [i, anchor] of load.anchors.entries()) {
    const label = `${anchor.name} (${anchor.page})`;
    if (!still) expect(watch.leaving()?.anchors[i], `${label} was not on the page while the layer faded`).toBeDefined();
    expect(watch.replaced()?.[i], `${label} was not on the page at the first paint after replacement`).toBeDefined();
  }
  let final: DOMRect[] = [];
  await vi.waitFor(() => {
    final = load.anchors.map((anchor) => {
      const element = findLanded(anchor.page);
      expect(element, `${anchor.name} (${anchor.page}) never landed within 2 s of the layer being gone`).toBeDefined();
      return element!.getBoundingClientRect();
    });
  }, { timeout: load.status === 'Reading your rules' || load.status === 'Drafting your rules' ? 4_000 : 2_000 });
  if (still) {
    expect(watch.states.some(({ state }) => state === 'leaving')).toBe(false);
    expect(watch.replaced()).toHaveLength(load.anchors.length);
  } else {
    expect(watch.leaving()?.style).toEqual({ name: 'cd-skeleton-leave', duration: '0.12s', pointer: 'none' });
    expect(watch.leaving()?.anchors).toHaveLength(load.anchors.length);
  }
  for (const [i, anchor] of load.anchors.entries()) {
    const moment = still ? watch.replaced() : watch.leaving()?.anchors;
    compare(anchors[i]!, moment![i]!, anchor.name, anchor.size, anchor.dimensions);
    if (!still) compare(anchors[i]!, watch.replaced()![i]!, anchor.name, anchor.size, anchor.dimensions);
    // The tables allow data-dependent sizes relative to the shape. After replacement, the
    // landed anchor's own top, left, width and height must all stay stable.
    compare(watch.replaced()![i]!, final[i]!, `${anchor.name} after gone`, true);
    compare(anchors[i]!, final[i]!, anchor.name, anchor.size, anchor.dimensions);
  }
  (load.stays ?? []).forEach((selector, i) => compare(stays[i]!, landed(selector).getBoundingClientRect(), selector, true));
  expect(watch.parts().body.hasAttribute('aria-busy')).toBe(false);
  expect(watch.parts().status.textContent).toBe('');
}

export async function expectSkeletonLoad(load: SkeletonLoad): Promise<void> {
  await checkLoad(load, false);
}

export async function expectSkeletonStill(load: SkeletonLoad): Promise<void> {
  await reduceMotion(true);
  onTestFinished(() => reduceMotion(false));
  await checkLoad(load, true);
}

/** Count painted frames without a visible layer between the first shapes and the destination. */
export function watchSkeletonGaps(until: string): () => number {
  let started = false;
  let gaps = 0;
  let frame = 0;
  const look = () => {
    const visible = [...document.querySelectorAll<HTMLElement>('.cd-skeleton-screen__layer')].some(
      (layer) => layer.dataset.state !== 'waiting' && getComputedStyle(layer).opacity !== '0',
    );
    started ||= visible;
    if ([...document.querySelectorAll(until)].some((element) => !element.closest('.cd-skeleton-screen__layer'))) return;
    if (started && !visible) gaps += 1;
    frame = requestAnimationFrame(look);
  };
  frame = requestAnimationFrame(look);
  onTestFinished(() => cancelAnimationFrame(frame));
  return () => gaps;
}
