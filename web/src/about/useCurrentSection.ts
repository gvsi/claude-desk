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
 * Calls `onDone` once a jump the page started is over by other means than arriving: the reader scrolling the window
 * themselves (the wheel, a touch that moves, a scrolling key), or a second with no scroll, so a long glide isn't cut
 * short and a jump that never moves doesn't wait forever. Returns what stops waiting.
 */
function waitForJump(onDone: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = () => {
    stop();
    onDone();
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(done, JUMP_WAIT);
  };
  const onKey = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) done();
  };
  function stop() {
    clearTimeout(timer);
    window.removeEventListener('scroll', later);
    window.removeEventListener('wheel', done);
    window.removeEventListener('touchmove', done);
    window.removeEventListener('keydown', onKey);
  }
  window.addEventListener('scroll', later, { passive: true });
  window.addEventListener('wheel', done, { passive: true });
  window.addEventListener('touchmove', done, { passive: true });
  window.addEventListener('keydown', onKey);
  later();
  return stop;
}

/**
 * Moves the window to a contents link's section: to `heading`, below its scroll margin, gliding unless `behavior` is
 * instant. A glide heads for where the heading was when it started; if the page grows above the section on the way,
 * as when the reading type's web font swaps in on a cold load, it ends short. So once the window has come to rest
 * where the glide was going, a heading that has moved is followed once more. A rest short of there is an earlier
 * scroll's or the reader's, and the reader taking over ends the watch.
 */
export function moveToSection(heading: HTMLElement, behavior: ScrollBehavior): void {
  const margin = parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
  const placeOf = () =>
    Math.min(document.documentElement.scrollHeight - window.innerHeight, heading.getBoundingClientRect().top + window.scrollY - margin);
  let going = placeOf();
  heading.scrollIntoView({ behavior, block: 'start' });
  // An instant jump has arrived already, and keeps its place as the page changes; so has a jump to where it is.
  if (Math.abs(window.scrollY - going) <= 1) return;
  let followedAgain = false;
  const stopWaiting = waitForJump(() => stopResting());
  const stopResting = onScrollRest(() => {
    if (Math.abs(window.scrollY - going) > 1) return;
    if (!followedAgain && Math.abs(heading.getBoundingClientRect().top - margin) > 1) {
      followedAgain = true;
      going = placeOf();
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
 * Keeps the window at the section an address opened until the reading type's web font has loaded, and returns what
 * cancels it. On a cold load the font swaps in after the page has opened there and moves the page under the window,
 * and the browser's scroll anchoring holds the window to some other element than the heading (about 2 px off on the
 * prediction). Once the type has loaded, the heading is followed once more, unless the reader has acted first (Back
 * and Forward included) or the page has cancelled it.
 */
export function keepSectionWhileTypeLoads(heading: HTMLElement): () => void {
  const { fonts } = document;
  if (!fonts || fonts.status !== 'loading') return () => {};
  const margin = parseFloat(getComputedStyle(heading).scrollMarginTop) || 0;
  let acted = false;
  const act = () => {
    acted = true;
    stop();
  };
  function stop() {
    for (const kind of READER_ACTIONS) window.removeEventListener(kind, act);
  }
  for (const kind of READER_ACTIONS) window.addEventListener(kind, act, { passive: true });
  void fonts.ready.then(() => {
    stop();
    if (acted || !heading.isConnected) return;
    if (Math.abs(heading.getBoundingClientRect().top - margin) > 1) heading.scrollIntoView({ behavior: 'instant', block: 'start' });
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
 * and the hook doesn't look again until the scroll ends, so the list's mark moves once, to the section followed,
 * rather than through each section the window passes on the way.
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
    function look() {
      if (held === undefined) setCurrent(sectionAt(sections));
    }
    function release() {
      held = undefined;
      stopWaiting();
      stopWaiting = () => {};
    }
    function letGo() {
      release();
      look();
    }
    following.current = (id) => {
      if (!sections.includes(id)) return;
      stopWaiting();
      held = id;
      setCurrent(id);
      // The reader scrolling on their own ends the jump, as does a second with no scroll; a jump to where the window
      // already is never says it has arrived.
      stopWaiting = waitForJump(letGo);
    };
    look();
    const stops = [
      onScrollRest(() => {
        // A rest ends the jump only once it has arrived, where a look marks the section followed. A rest short of
        // that is an earlier scroll's, such as the window's nudge when a font's metrics come in just before the click.
        if (held !== undefined && sectionAt(sections) !== held) return;
        if (held !== undefined) letGo();
        else look();
      }),
      () => {
        release();
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
