/**
 * The About reading page with motion, in the `about-motion` project: a reader who hasn't asked for reduced motion.
 * Following a contents link glides to its section and the contents bar slides once to its row, while every scroll
 * the page makes itself stays instant. What the list marks, and the instant jump under reduced motion, are checked
 * in reader.browser.test.tsx. Expected timings and offsets are written out here, never read from the page's code.
 */
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { forgetPlayedFigures } from './figures/usePlayOnce.ts';
import type { AboutId } from './links.ts';
import { ReaderPage } from './ReaderPage.tsx';

/** Where the memory router is, and a way to move it. */
const at: { path: string; navigate: NavigateFunction | null } = { path: '', navigate: null };

function LocationProbe() {
  const location = useLocation();
  at.path = `${location.pathname}${location.hash}`;
  at.navigate = useNavigate();
  return null;
}

const ROUTES = { proposal: '/about/proposal', prediction: '/about/prediction' } as const;

/** The reader at its route, at the desktop size, in a memory router that knows both pages. */
async function renderReader(id: AboutId) {
  await page.viewport(1440, 900);
  return render(
    <MemoryRouter initialEntries={[ROUTES[id]]}>
      <Routes>
        <Route path="/about/proposal" element={<ReaderPage id="proposal" />} />
        <Route path="/about/prediction" element={<ReaderPage id="prediction" />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

afterEach(async () => {
  // Each test is a fresh page load, in which no figure has played.
  forgetPlayedFigures();
  window.scrollTo({ top: 0, behavior: 'instant' });
  await page.viewport(1440, 900);
});

/** The heading of the section `anchor` names. */
function headingOf(anchor: string): HTMLElement {
  const heading = document.getElementById(anchor);
  if (!heading) throw new Error(`no section #${anchor}`);
  return heading;
}

/** The window's offset at which the section's heading sits at the top, below its scroll margin. */
function placeOf(anchor: string): number {
  const heading = headingOf(anchor);
  return Math.round(heading.getBoundingClientRect().top + window.scrollY - parseFloat(getComputedStyle(heading).scrollMarginTop));
}

/** Moves the window to `y` in one jump and waits for it to rest. */
async function jumpTo(y: number): Promise<void> {
  if (Math.round(window.scrollY) === y) return;
  const rested = new Promise((resolve) => window.addEventListener('scrollend', resolve, { once: true }));
  window.scrollTo({ top: y, behavior: 'instant' });
  await rested;
}

/** The contents list's link to `anchor`. */
function linkTo(anchor: string): HTMLElement {
  const link = document.querySelector<HTMLElement>(`nav[aria-label="On this page"] a[href="#${anchor}"]`);
  if (!link) throw new Error(`no contents link to #${anchor}`);
  return link;
}

/**
 * Follows the contents list's link to `anchor`, clicked where it is, as a reader's click on the pinned list is. A
 * driven click first brings its target into view, and for a link in the pinned column that can scroll the page.
 */
function followLink(anchor: string): void {
  linkTo(anchor).click();
}

/** The contents list's links marked as the section being read, by their href. */
function marked(): string[] {
  return [...document.querySelectorAll('nav[aria-label="On this page"] a[aria-current]')].map((link) => link.getAttribute('href') ?? '');
}

/** The page's title, the document's. */
function title(): string {
  return (document.querySelector('h1')?.textContent ?? '').trim();
}

/** The easing a motion token computes to, read off a probe element. */
function tokenEasing(token: string): string {
  const probe = document.createElement('span');
  probe.style.transitionTimingFunction = `var(${token})`;
  document.body.append(probe);
  const easing = getComputedStyle(probe).transitionTimingFunction;
  probe.remove();
  return easing;
}

/**
 * Waits until the window has gone still: no scroll for a moment. A test ends here before its page goes away; a glide
 * still finishing its last fraction of a pixel when the page is removed would carry on into the next test's page.
 */
async function untilStill(): Promise<void> {
  let last = performance.now();
  const onScroll = () => {
    last = performance.now();
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  try {
    await expect.poll(() => performance.now() - last >= 200, { timeout: 3000, interval: 50 }).toBe(true);
  } finally {
    window.removeEventListener('scroll', onScroll);
  }
}

/** Records, frame by frame, what `read` returns, until stopped. */
function eachFrame<T>(read: () => T): { frames: T[]; stop: () => void } {
  const frames: T[] = [];
  let id = 0;
  const tick = () => {
    frames.push(read());
    id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return { frames, stop: () => cancelAnimationFrame(id) };
}

/**
 * Turns the browser's scroll anchoring off for the test, so nothing but the page puts the window back. On the root and
 * the body both: Chromium on Linux still anchors the window to a focused heading with it off on the root alone.
 */
function withoutScrollAnchoring(): void {
  document.documentElement.style.overflowAnchor = 'none';
  document.body.style.overflowAnchor = 'none';
  onTestFinished(() => {
    document.documentElement.style.overflowAnchor = '';
    document.body.style.overflowAnchor = '';
  });
}

/** Makes the reading type's web font still loading, as on a cold load, and returns what finishes loading it. */
function typeStillLoading(): () => void {
  let loaded = () => {};
  const ready = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const fonts = { status: 'loading', ready } as unknown as FontFaceSet;
  Object.defineProperty(document, 'fonts', { configurable: true, get: () => fonts });
  onTestFinished(() => {
    delete (document as { fonts?: FontFaceSet }).fonts;
  });
  return loaded;
}

describe('ReaderPage with motion', () => {
  it('read_next_arrow_nudges_toward_the_next_page', async () => {
    // Pointing at the "Read next" card moves its arrow 4 px toward the next page, and back when the pointer leaves.
    for (const id of ['proposal', 'prediction'] as const) {
      const screen = await renderReader(id);
      const card = document.querySelector<HTMLElement>('.cd-about-next .cd-card');
      const arrow = card?.querySelector<SVGSVGElement>('svg.cd-about-next__arrow');
      if (!card || !arrow) throw new Error(`${id}: Read next draws no arrow`);
      expect(getComputedStyle(arrow).transform, id).toBe('none');
      card.scrollIntoView({ block: 'center' });
      const link = card.querySelector('a') as HTMLElement;
      await userEvent.hover(link);
      await expect.poll(() => getComputedStyle(arrow).transform, { message: id }).toBe('matrix(1, 0, 0, 1, 4, 0)');
      await userEvent.unhover(link);
      await expect.poll(() => getComputedStyle(arrow).transform, { message: id }).toBe('none');
      await screen.unmount();
    }
  });

  it('contents_link_scrolls_smoothly', async () => {
    // A section a couple of thousand pixels down: the browser's glide takes longer the further it goes.
    const screen = await renderReader('prediction');
    const heading = headingOf('why-its-coming');
    // Where the heading is, and what has focus, once the page has handled the click.
    let atClick: { top: number; focused: Element | null } | null = null;
    const onClick = () => {
      atClick = { top: heading.getBoundingClientRect().top, focused: document.activeElement };
    };
    document.addEventListener('click', onClick);
    onTestFinished(() => document.removeEventListener('click', onClick));
    const tops = eachFrame(() => Math.round(heading.getBoundingClientRect().top));
    onTestFinished(tops.stop);

    followLink('why-its-coming');
    // Right after the click the window hasn't reached the heading yet, though focus is already on it.
    expect(atClick).not.toBeNull();
    const { top, focused } = atClick as unknown as { top: number; focused: Element | null };
    expect(top, 'the heading at the click').toBeGreaterThan(900);
    expect(focused).toBe(heading);
    // Within a second it rests with the heading at its place below the pinned bar, still focused, having passed
    // through places on the way.
    await expect.poll(() => Math.abs(heading.getBoundingClientRect().top - 88), { timeout: 1000 }).toBeLessThanOrEqual(1);
    tops.stop();
    const between = new Set(tops.frames.filter((y) => y < top - 1 && y > 89));
    expect(between.size, 'frames part way there').toBeGreaterThan(2);
    expect(document.activeElement).toBe(heading);
    await expect.poll(() => at.path).toBe('/about/prediction#why-its-coming');
    await untilStill();
    await screen.unmount();
  });

  it('contents_bar_slides_once_to_its_target', async () => {
    const screen = await renderReader('prediction');
    const contents = document.querySelector('nav[aria-label="On this page"]') as HTMLElement;
    const bar = () => contents.querySelector<HTMLElement>('[data-contents-bar]');

    // When the first section becomes current, the bar shows on its row at once, without sliding from the top.
    await jumpTo(placeOf('capability'));
    await expect.poll(marked).toEqual(['#capability']);
    expect(bar(), 'the bar is drawn').not.toBeNull();
    expect(bar()?.getAnimations(), 'the bar shows without sliding').toEqual([]);

    // Following a link two sections down: the mark goes straight to it, and the bar's place changes once, to its row.
    const marks: string[] = [];
    const places: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target as HTMLElement;
        if (record.attributeName === 'aria-current' && el.getAttribute('aria-current')) marks.push(el.getAttribute('href') ?? '');
        if (record.attributeName === 'style' && el.hasAttribute('data-contents-bar')) places.push(el.style.transform);
      }
    });
    watch.observe(contents, { attributes: true, attributeFilter: ['aria-current', 'style'], subtree: true });
    onTestFinished(() => watch.disconnect());
    const slides = eachFrame(() => bar()?.getAnimations().map((animation) => (animation as CSSTransition).transitionProperty) ?? []);
    onTestFinished(slides.stop);

    followLink('how-its-measured');
    const heading = headingOf('how-its-measured');
    await expect.poll(() => Math.abs(heading.getBoundingClientRect().top - 88), { timeout: 1000 }).toBeLessThanOrEqual(1);
    // Past the scroll's end: the page has looked again, and nothing moves.
    await new Promise((resolve) => setTimeout(resolve, 300));
    slides.stop();
    watch.disconnect();
    expect(marks, 'the sections marked on the way').toEqual(['#how-its-measured']);
    expect(marked()).toEqual(['#how-its-measured']);
    expect(places, 'the bar moved once').toHaveLength(1);
    // To the row's words.
    const words = linkTo('how-its-measured').querySelector('span:last-child')?.getBoundingClientRect() as DOMRect;
    expect(Math.abs((bar()?.getBoundingClientRect().top ?? 0) - words.top)).toBeLessThanOrEqual(0.5);
    // It slid there: a transition of its place, in motion-base on the emphasis ease.
    expect(slides.frames.some((properties) => properties.includes('transform')), 'the bar slid').toBe(true);
    const style = getComputedStyle(bar() as HTMLElement);
    expect(style.transitionProperty).toBe('transform, height');
    expect(style.transitionDuration).toBe('0.2s, 0.2s');
    const emphasis = tokenEasing('--motion-ease-emphasis');
    expect(style.transitionTimingFunction).toBe(`${emphasis}, ${emphasis}`);
    await untilStill();
    await screen.unmount();
  });

  it('contents_link_lands_on_its_section_though_the_page_moves', async () => {
    // The page can grow above the section while the window glides there, as when the reading type's web font
    // swaps in on a cold load. The glide still ends with the heading at its place.
    const screen = await renderReader('prediction');
    const heading = headingOf('limitations');
    const hero = document.querySelector('[data-hero]') as HTMLElement;
    const grow = document.createElement('div');
    grow.style.height = '29px';
    onTestFinished(() => grow.remove());
    followLink('limitations');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(heading.getBoundingClientRect().top, 'the glide is under way').toBeGreaterThan(200);
    hero.append(grow);
    await expect.poll(() => Math.abs(heading.getBoundingClientRect().top - 88), { timeout: 2000 }).toBeLessThanOrEqual(1);
    await untilStill();
    await screen.unmount();

    // The same when the rest of a scroll just before the click arrives as the glide starts, as the window's nudge
    // when a font's metrics come in does: that rest isn't the glide's.
    const nudged = await renderReader('prediction');
    const restAtTheClick = () => window.dispatchEvent(new Event('scrollend'));
    document.addEventListener('click', restAtTheClick, { once: true });
    followLink('limitations');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const grown = document.createElement('div');
    grown.style.height = '29px';
    onTestFinished(() => grown.remove());
    (document.querySelector('[data-hero]') as HTMLElement).append(grown);
    await expect
      .poll(() => Math.abs(headingOf('limitations').getBoundingClientRect().top - 88), { timeout: 2000, message: 'after an earlier rest' })
      .toBeLessThanOrEqual(1);
    await untilStill();
    await nudged.unmount();

    // A reader who takes over part way, scrolling the window themselves, is left where they stopped.
    const again = await renderReader('prediction');
    followLink('readiness');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const stopAt = Math.round(window.scrollY) + 200;
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: 200 }));
    await jumpTo(stopAt);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(Math.round(window.scrollY), 'where the reader stopped').toBe(stopAt);
    await untilStill();
    await again.unmount();
  });

  it('a_rest_from_an_earlier_scroll_doesnt_end_a_jump', async () => {
    // The rest of a scroll just before the click arrives as the glide starts: the mark stays on the section
    // followed, rather than going back to where the window still is.
    const screen = await renderReader('prediction');
    await jumpTo(placeOf('capability'));
    await expect.poll(marked).toEqual(['#capability']);
    const marks: string[] = [];
    const watch = new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target as HTMLElement;
        if (el.getAttribute('aria-current')) marks.push(el.getAttribute('href') ?? '');
      }
    });
    watch.observe(document.querySelector('nav[aria-label="On this page"]') as HTMLElement, {
      attributes: true,
      attributeFilter: ['aria-current'],
      subtree: true,
    });
    onTestFinished(() => watch.disconnect());
    document.addEventListener('click', () => window.dispatchEvent(new Event('scrollend')), { once: true });
    followLink('how-its-measured');
    const heading = headingOf('how-its-measured');
    await expect.poll(() => Math.abs(heading.getBoundingClientRect().top - 88), { timeout: 2000 }).toBeLessThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(marks, 'the sections marked on the way').toEqual(['#how-its-measured']);

    // A reader who takes over part way, with the wheel, is followed: the mark is where they stop.
    followLink('readiness');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }));
    await jumpTo(placeOf('why-its-coming') + 100);
    await expect.poll(marked, { timeout: 500, message: 'where the reader stopped' }).toEqual(['#why-its-coming']);
    watch.disconnect();
    await untilStill();
    await screen.unmount();
  });

  it('a_followed_section_keeps_its_place_while_the_type_loads', async () => {
    // Followed before the type has loaded, a section that the swap moves after the glide has arrived glides back to
    // its place once the type has loaded. Scroll anchoring is off, so nothing else puts the window back.
    withoutScrollAnchoring();
    const loaded = typeStillLoading();
    const screen = await renderReader('prediction');
    const heading = headingOf('limitations');
    followLink('limitations');
    await expect.poll(() => Math.abs(heading.getBoundingClientRect().top - 88), { timeout: 2000 }).toBeLessThanOrEqual(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const grown = document.createElement('div');
    grown.style.height = '29px';
    onTestFinished(() => grown.remove());
    (document.querySelector('[data-hero]') as HTMLElement).append(grown);
    expect(heading.getBoundingClientRect().top - 88, 'the swap moved the page').toBeGreaterThan(20);
    loaded();
    await expect
      .poll(() => Math.abs(heading.getBoundingClientRect().top - 88), { timeout: 2000, message: 'once the type has loaded' })
      .toBeLessThanOrEqual(1);
    expect(marked()).toEqual(['#limitations']);
    await untilStill();
    await screen.unmount();
  });

  it('a_pending_font_correction_gives_way_to_back', async () => {
    // Followed before the type has loaded, then Back before it loads: once it does, the window stays where Back put
    // it, and isn't taken back to the section. A memory router has no browser to restore the place, so the test puts
    // the window back as the browser does. Scroll anchoring is off, so nothing else moves it.
    withoutScrollAnchoring();
    const loaded = typeStillLoading();
    const screen = await renderReader('prediction');
    await jumpTo(1800);
    followLink('limitations');
    const heading = headingOf('limitations');
    await expect.poll(() => Math.abs(heading.getBoundingClientRect().top - 88), { timeout: 2000 }).toBeLessThanOrEqual(1);
    await untilStill();
    at.navigate?.(-1);
    await expect.poll(() => at.path).toBe('/about/prediction');
    await jumpTo(1800);
    const grown = document.createElement('div');
    grown.style.height = '29px';
    onTestFinished(() => grown.remove());
    (document.querySelector('[data-hero]') as HTMLElement).append(grown);
    loaded();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(Math.round(window.scrollY), 'where Back put the window').toBe(1800);
    await untilStill();
    await screen.unmount();
  });

  it('back_during_a_contents_glide_stops_it', async () => {
    // Part way through the glide to "Readiness", the reader goes Back: the address no longer names the section, and the
    // window stops where it is rather than going on there. (A memory router has no browser to restore the reader's
    // place; the end-to-end test checks that the glide stops within about a line of it.)
    const screen = await renderReader('prediction');
    await jumpTo(1800);
    followLink('readiness');
    await expect.poll(() => window.scrollY > 1810, { interval: 5 }).toBe(true);
    at.navigate?.(-1);
    await expect.poll(() => at.path).toBe('/about/prediction');
    await untilStill();
    const stopped = Math.round(window.scrollY);
    expect(stopped, 'the window stopped short of the section').toBeLessThan(placeOf('readiness') - 400);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(Math.round(window.scrollY), 'and stays there').toBe(stopped);
    await screen.unmount();
  });

  it('page_scrolls_stay_instant_with_motion', async () => {
    // The scrolls the page makes itself land in the frame the page draws, never part way, and the place the page
    // remembers for Back is where they landed.
    withoutScrollAnchoring();
    const screen = await renderReader('proposal');
    await expect.poll(title).toBe('Product proposal');
    const seen = eachFrame(() => ({ title: title(), y: Math.round(window.scrollY) }));
    onTestFinished(seen.stop);
    /** Every frame since the page showed `name`, until `frames` more have been drawn. */
    const framesOf = async (name: string, frames = 20) => {
      await expect.poll(title).toBe(name);
      const from = seen.frames.findIndex((frame, i) => frame.title === name && seen.frames[i - 1]?.title !== name);
      await expect.poll(() => seen.frames.length).toBeGreaterThan(from + frames);
      return seen.frames.slice(from).map((frame) => frame.y);
    };
    const landsAt = async (name: string, place: number, where: string) => {
      const ys = await framesOf(name);
      expect(ys.every((y) => Math.abs(y - place) <= 1), `${where}: ${ys.slice(0, 8).join(', ')}`).toBe(true);
    };

    // Opening the other document lands at its top.
    await jumpTo(2000);
    at.navigate?.('/about/prediction');
    await landsAt('Capability prediction', 0, 'opened');
    await jumpTo(1500);

    // Opening an address with a section lands at the section.
    seen.frames.length = 0;
    at.navigate?.('/about/proposal#why-anthropic');
    await expect.poll(title).toBe('Product proposal');
    const section = placeOf('why-anthropic');
    await landsAt('Product proposal', section, 'opened at a section');

    // Back and Forward land where the reader was in each document.
    seen.frames.length = 0;
    at.navigate?.(-1);
    await landsAt('Capability prediction', 1500, 'back');
    seen.frames.length = 0;
    at.navigate?.(1);
    await landsAt('Product proposal', section, 'forward');

    // And what the page remembers is where they landed: Back again finds the same place.
    seen.frames.length = 0;
    at.navigate?.(-1);
    await landsAt('Capability prediction', 1500, 'back again');
    seen.frames.length = 0;
    at.navigate?.(1);
    await landsAt('Product proposal', section, 'forward again');
    await untilStill();
    await screen.unmount();
  });
});
