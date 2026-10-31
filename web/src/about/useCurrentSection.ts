/**
 * The section being read, for the About pages' contents list: the last section whose heading's top is above 40%
 * of the window, or the last section once the page is scrolled to its end, where a short last section's heading
 * may never reach the line. Null above the first heading.
 *
 * Intersection observers over the headings and over a sentinel at the page's end only say when to look again;
 * each look reads every heading's place, never the observers' own entries. A jump can carry headings straight
 * past the line without one coming into the observer's band or leaving it, so the hook also looks once each
 * scroll comes to rest: one look per scroll, not work on every frame.
 *
 * `moveToSection`, the window's move when a contents link is followed, lives here too, so the timing of a jump (when
 * it has arrived, when the reader has taken over, how long to wait) is in one place for the mark and the move.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How far down the window a section's heading has to have come for the section to be the one being read. */
const LINE = 0.4;

/** Where a browser has no `scrollend`, how long the window has to be still for a scroll to have come to rest. */
const REST_WAIT = 100;

/** How long after the window last scrolled a contents link's jump stops waiting for word that it has arrived. */
const JUMP_WAIT = 1000;

/** The keys that scroll the window when nothing that takes them has focus. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/**
 * Waits on a jump the page started, for the ways it can end other than arriving: the reader scrolling the window
 * themselves (the wheel, a touch that moves, a scrolling key) calls `onTakenOver`; a second with no scroll calls
 * `onQuiet`, so a long glide isn't cut short and a jump that never moves doesn't wait forever. Returns what stops
 * waiting.
 */
function waitForJump(onTakenOver: () => void, onQuiet: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const takenOver = () => {
    stop();
    onTakenOver();
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stop();
      onQuiet();
    }, JUMP_WAIT);
  };
  const onKey = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) takenOver();
  };
  function stop() {
    clearTimeout(timer);
    window.removeEventListener('scroll', later);
    window.removeEventListener('wheel', takenOver);
    window.removeEventListener('touchmove', takenOver);
    window.removeEventListener('keydown', onKey);
  }
  window.addEventListener('scroll', later, { passive: true });
  window.addEventListener('wheel', takenOver, { passive: true });
  window.addEventListener('touchmove', takenOver, { passive: true });
  window.addEventListener('keydown', onKey);
  later();
  return stop;
}

/**
 * Where the window rests when it has gone to `heading`: the heading at its scroll margin, or as far down as the page
 * goes when the page ends before the heading can get there.
 */
function placeOf(heading: HTMLElement): number {
  const margin = parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
  const end = document.documentElement.scrollHeight - window.innerHeight;
  return Math.min(end, heading.getBoundingClientRect().top + window.scrollY - margin);
}

/** Whether the window rests where it goes for `heading`. */
function atPlaceOf(heading: HTMLElement): boolean {
  return Math.abs(window.scrollY - placeOf(heading)) <= 1;
}

/**
 * Moves the window to a contents link's section: to `heading`, below its scroll margin, gliding unless `behavior` is
 * instant. A glide heads for where the heading was when it started; if the page grows above the section on the way,
 * as when the reading type's web font swaps in on a cold load, it ends short. So once the window has come to rest
 * where the glide was going, a heading that has moved is followed once more. A rest short of there is an earlier
 * scroll's or the reader's, and the reader taking over ends the watch.
 */
export function moveToSection(heading: HTMLElement, behavior: ScrollBehavior): void {
  let going = placeOf(heading);
  heading.scrollIntoView({ behavior, block: 'start' });
  keepSectionWhileTypeLoads(heading, behavior);
  // An instant jump has arrived already, and keeps its place as the page changes; so has a jump to where it is.
  if (Math.abs(window.scrollY - going) <= 1) return;
  let followedAgain = false;
  const stopWaiting = waitForJump(
    () => stopResting(),
    () => stopResting(),
  );
  const stopResting = onScrollRest(() => {
    if (Math.abs(window.scrollY - going) > 1) return;
    if (!followedAgain && !atPlaceOf(heading)) {
      followedAgain = true;
      going = placeOf(heading);
      heading.scrollIntoView({ behavior, block: 'start' });
      return;
    }
    stopWaiting();
    stopResting();
  });
}

/** What the reader does that means they have moved on from where the page put them, Back and Forward included. */
const READER_ACTIONS = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'popstate'] as const;

/**
 * Keeps the window at a section the page moved to (by an address, or a contents link) until the reading type's web
 * font has loaded, and returns what cancels it. On a cold load the font swaps in after the page has moved there and
 * shifts the page under the window, and the browser's scroll anchoring holds the window to some other element than
 * the heading (about 2 px off after an address, about 30 px after a contents link). Once the type has loaded and the
 * window has come to rest, a heading that has moved is followed once more, in `behavior`, unless the reader has acted
 * first (Back and Forward included) or the page has cancelled it.
 */
export function keepSectionWhileTypeLoads(heading: HTMLElement, behavior: ScrollBehavior = 'instant'): () => void {
  const { fonts } = document;
  if (!fonts || fonts.status !== 'loading') return () => {};
  let acted = false;
  let moving = false;
  const act = () => {
    acted = true;
    stop();
  };
  const onScroll = () => {
    moving = true;
  };
  let afterRest: (() => void) | null = null;
  const stopResting = onScrollRest(() => {
    moving = false;
    afterRest?.();
  });
  function stop() {
    for (const kind of READER_ACTIONS) window.removeEventListener(kind, act);
    window.removeEventListener('scroll', onScroll);
    stopResting();
  }
  for (const kind of READER_ACTIONS) window.addEventListener(kind, act, { passive: true });
  window.addEventListener('scroll', onScroll, { passive: true });
  const followAgain = () => {
    stop();
    if (acted || !heading.isConnected) return;
    if (!atPlaceOf(heading)) heading.scrollIntoView({ behavior, block: 'start' });
  };
  void fonts.ready.then(() => {
    if (acted) return;
    // A glide still under way, or a jump whose scroll hasn't been heard to end, is let finish first.
    if (moving) afterRest = followAgain;
    else followAgain();
  });
  return act;
}

/**
 * Calls `onRest` each time a scroll of the window comes to rest, and returns what stops it: on `scrollend`, or where
 * the browser lacks it, once no scroll has been heard for a moment.
 */
function onScrollRest(onRest: () => void): () => void {
  // Null where the browser knows the event and nothing is set; missing where it doesn't.
  if (typeof window.onscrollend !== 'undefined') {
    window.addEventListener('scrollend', onRest);
    return () => window.removeEventListener('scrollend', onRest);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onScroll = () => {
    clearTimeout(timer);
    timer = setTimeout(onRest, REST_WAIT);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    clearTimeout(timer);
    window.removeEventListener('scroll', onScroll);
  };
}

/** Whether the window is scrolled as far down the page as it goes. A page too short to scroll has no end to reach. */
function atPageEnd(): boolean {
  const { scrollHeight } = document.documentElement;
  return window.scrollY > 0 && Math.ceil(window.scrollY + window.innerHeight) >= scrollHeight;
}

/** The last of `ids` whose heading's top is above the line, the last of them at the page's end, or null. */
function sectionAt(ids: readonly string[]): string | null {
  if (ids.length > 0 && atPageEnd()) return ids[ids.length - 1] ?? null;
  const line = window.innerHeight * LINE;
  let current: string | null = null;
  for (const id of ids) {
    const heading = document.getElementById(id);
    if (!heading) continue;
    if (heading.getBoundingClientRect().top > line) break;
    current = id;
  }
  return current;
}

/**
 * The id of the section being read, of the sections `ids` names in the page's order, and `follow`, which the
 * contents list calls as one of its links starts the window's jump to a section. That section is current at once,
 * and the hook doesn't look again while the jump is under way, so the list's mark moves once, to the section
 * followed, rather than through each section the window passes on the way. Once the window rests where the jump
 * goes, the section stays current until the reader scrolls on.
 */
export function useCurrentSection(ids: readonly string[]): [current: string | null, follow: (id: string) => void] {
  const [current, setCurrent] = useState<string | null>(null);
  // What `follow` does for the sections drawn now; nothing until they are.
  const following = useRef<(id: string) => void>(() => {});
  // The ids by value: the page passes a new array each time it draws.
  const key = ids.join('\n');

  useEffect(() => {
    const sections = key === '' ? [] : key.split('\n');
    // While a link's jump is under way: the section it follows, and what stops waiting for it to arrive.
    let held: string | undefined;
    let stopWaiting = () => {};
    // Once a jump has arrived, its section stays current until the reader's own next scroll, even where the 40% rule
    // would mark another: a page that ends before the heading reaches the top, or the next heading also above the line.
    let arrived = false;
    function look() {
      if (held === undefined && !arrived) setCurrent(sectionAt(sections));
    }
    function release() {
      held = undefined;
      stopWaiting();
      stopWaiting = () => {};
    }
    function scrolledOn() {
      arrived = false;
      window.removeEventListener('scroll', scrolledOn);
    }
    function arrive() {
      release();
      arrived = true;
      window.addEventListener('scroll', scrolledOn, { passive: true });
    }
    function letGo() {
      release();
      scrolledOn();
      look();
    }
    /** Whether the window rests where the jump in hand goes. */
    function there(): boolean {
      const heading = held === undefined ? null : document.getElementById(held);
      return heading !== null && atPlaceOf(heading);
    }
    following.current = (id) => {
      if (!sections.includes(id)) return;
      release();
      scrolledOn();
      held = id;
      setCurrent(id);
      // The reader scrolling on their own ends the jump. So does a second with no scroll: arrived if the window is
      // where the jump goes (a jump to where it already is never says it has arrived), let go if it isn't.
      stopWaiting = waitForJump(letGo, () => (there() ? arrive() : letGo()));
    };
    look();
    const stops = [
      onScrollRest(() => {
        if (held === undefined) look();
        // A rest where the jump goes is its arrival. A rest short of there is an earlier scroll's, such as the
        // window's nudge when a font's metrics come in just before the click.
        else if (there()) arrive();
      }),
      () => {
        release();
        scrolledOn();
        following.current = () => {};
      },
    ];
    if (typeof window.IntersectionObserver === 'function') {
      // The window above the line: a heading coming into it or leaving it, by either edge, is a reason to look.
      const band = new IntersectionObserver(look, { rootMargin: `0px 0px -${Math.round((1 - LINE) * 100)}% 0px` });
      for (const id of sections) {
        const heading = document.getElementById(id);
        if (heading) band.observe(heading);
      }
      // An empty element after everything on the page, which comes into the window as the page's end does.
      const end = document.createElement('div');
      end.setAttribute('aria-hidden', 'true');
      document.body.append(end);
      const ends = new IntersectionObserver(look);
      ends.observe(end);
      stops.push(() => {
        band.disconnect();
        ends.disconnect();
        end.remove();
      });
    }
    return () => {
      for (const stop of stops) stop();
    };
  }, [key]);

  const follow = useCallback((id: string) => following.current(id), []);
  return [current, follow];
}
