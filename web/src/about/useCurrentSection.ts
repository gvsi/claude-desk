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
 * The page's own moves of the window live here too, so the mark and the moves share one account of who moved it:
 * `moveToSection` for a contents link, `keepSectionWhileTypeLoads` for an address's section. Both go through one
 * owner, `place`, of where the page means the window to be.
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
 * Calls `onScroll` whenever the reader sets out to move the window themselves: the wheel, a touch that moves, a key
 * that scrolls, or Back and Forward. The one test of the reader moving on, for the page's own moves and the contents
 * list's mark alike. Returns what stops listening.
 */
function onReaderScroll(onScroll: (event: Event) => void): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) onScroll(event);
  };
  window.addEventListener('wheel', onScroll, { passive: true });
  window.addEventListener('touchmove', onScroll, { passive: true });
  window.addEventListener('popstate', onScroll);
  window.addEventListener('keydown', onKey);
  return () => {
    window.removeEventListener('wheel', onScroll);
    window.removeEventListener('touchmove', onScroll);
    window.removeEventListener('popstate', onScroll);
    window.removeEventListener('keydown', onKey);
  };
}

/**
 * Waits on a jump the page started, for the ways it can end other than arriving: the reader moving on calls
 * `onTakenOver`; a second with no scroll calls `onQuiet`, so a long glide isn't cut short and a jump that never moves
 * doesn't wait forever. Returns what stops waiting.
 */
function waitForJump(onTakenOver: () => void, onQuiet: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stop();
      onQuiet();
    }, JUMP_WAIT);
  };
  const stopListening = onReaderScroll(() => {
    stop();
    onTakenOver();
  });
  function stop() {
    clearTimeout(timer);
    window.removeEventListener('scroll', later);
    stopListening();
  }
  window.addEventListener('scroll', later, { passive: true });
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
 * What ends the wait on the reading type for an address's section: any pointer or key, as well as a scroll, Back and
 * Forward included. Only that wait uses it; the reader moving on otherwise is `onReaderScroll`.
 */
const READER_ACTIONS = ['wheel', 'touchmove', 'pointerdown', 'keydown', 'popstate'] as const;

/** How many times one hold follows its heading again when the page has moved it, so a page that keeps changing can't loop. */
const FOLLOWS = 3;

/** Where the page means the window to be: the heading it last moved the window to, by a contents link or an address. */
interface Place {
  heading: HTMLElement;
  /** The page is moving the window there now, in a glide or a correction that hasn't come to rest. */
  moving: boolean;
  /** The page is waiting on the reading type, to follow the heading again once its swap has moved the page. */
  keeping: boolean;
  /** Ends it; `stopGlide` also stops a glide still under way, as when navigation leaves the section. */
  end: (stopGlide?: boolean) => void;
}

/** The one owner of where the page means the window to be. One at a time: a new move or keep ends the one before. */
let place: Place | null = null;

/**
 * Whether a scroll now is the page's, not the reader's: the page is moving the window to its place, or waiting on the
 * type (whose swap, and the browser's anchoring of the window through it, shift the page under the window), or the
 * window is still at the place, the page's end allowed for. A scroll that leaves the place otherwise is the reader's.
 */
function scrollIsThePages(): boolean {
  return place !== null && (place.moving || place.keeping || atPlaceOf(place.heading));
}

/**
 * Takes the window to `heading` (when `move`) and holds it there as the page means it to be, until the reader moves on,
 * the window is moved off it, a new move or keep starts, or the returned function ends it.
 *
 * A move heads for where the heading is when it starts; if the page grows above the section on the way, it ends short,
 * so once it has come to rest where it was going, a heading that has moved is followed again. While the reading type
 * is still loading, the hold waits for it: its swap shifts the page under the window, and the browser's anchoring
 * holds the window to some other element than the heading, so once the type has loaded and the window is at rest, the
 * heading is followed again, unless the reader has acted first.
 */
function hold(heading: HTMLElement, behavior: ScrollBehavior, move: boolean): () => void {
  place?.end();
  const { fonts } = document;
  const self: Place = { heading, moving: false, keeping: Boolean(fonts && fonts.status === 'loading'), end };
  place = self;
  let going = placeOf(heading);
  let follows = 0;
  let rest: ReturnType<typeof setTimeout> | undefined;
  let quiet: ReturnType<typeof setTimeout> | undefined;

  /** Moves the window to the heading; the page is moving it until it comes to rest there. */
  function go() {
    going = placeOf(heading);
    heading.scrollIntoView({ behavior, block: 'start' });
    self.moving = Math.abs(window.scrollY - going) > 1;
    if (self.moving) arm();
  }
  /**
   * The move's own timers, armed by its start and each of its scrolls: a rest heard as the window going still (a
   * browser can skip the end of a glide that starts while an earlier scroll's end is still due), and a quiet second
   * after which a move that never arrived is over.
   */
  function arm() {
    clearTimeout(rest);
    clearTimeout(quiet);
    rest = setTimeout(rested, REST_WAIT);
    quiet = setTimeout(() => {
      if (!self.moving) return;
      self.moving = false;
      if (!atPlaceOf(heading)) end();
    }, JUMP_WAIT);
  }
  /** At rest where the move was going: arrived. A rest anywhere else is an earlier scroll's or a frame that came late. */
  function rested() {
    if (!self.moving || Math.abs(window.scrollY - going) > 1) return;
    self.moving = false;
    clearTimeout(quiet);
    settle();
  }
  /** Follows the heading again if the page has moved it, unless the type is still to come. */
  function settle() {
    if (!heading.isConnected) return end();
    if (self.keeping || atPlaceOf(heading) || follows >= FOLLOWS) return;
    follows += 1;
    go();
  }
  function onScroll() {
    if (self.moving) arm();
    // Off its place, with nothing the page is waiting for: the reader moved the window, as by dragging the scrollbar.
    else if (!self.keeping && !atPlaceOf(heading)) end();
  }
  function onAction() {
    if (!self.keeping) return;
    self.keeping = false;
    if (!move) end();
  }
  const stops = [
    onScrollRest(rested),
    onReaderScroll((event) => end(event.type === 'popstate')),
    () => {
      clearTimeout(rest);
      clearTimeout(quiet);
      window.removeEventListener('scroll', onScroll);
      for (const kind of READER_ACTIONS) window.removeEventListener(kind, onAction);
    },
  ];
  window.addEventListener('scroll', onScroll, { passive: true });
  if (self.keeping) for (const kind of READER_ACTIONS) window.addEventListener(kind, onAction, { passive: true });
  function end(stopGlide = false) {
    if (place !== self) return;
    place = null;
    // A glide carries on by itself; an instant move to where the window is now stops it, and history's restore of the
    // reader's place on Back still wins.
    if (stopGlide && self.moving) window.scrollTo({ top: window.scrollY, behavior: 'instant' });
    for (const stop of stops) stop();
  }
  if (move) go();
  void fonts?.ready.then(() => {
    if (place !== self || !self.keeping) return;
    self.keeping = false;
    if (!self.moving) settle();
  });
  return () => end(true);
}

/**
 * Moves the window to a contents link's section: to `heading`, below its scroll margin, gliding unless `behavior` is
 * instant, and holds it there (`hold`). Returns what ends the hold and stops the glide, as when navigation changes the
 * reading place.
 */
export function moveToSection(heading: HTMLElement, behavior: ScrollBehavior): () => void {
  return hold(heading, behavior, true);
}

/**
 * Keeps the window at a section an address opened until the reading type's web font has loaded (`hold`): on a cold
 * load its swap shifts the page under the window, about 2 px on the prediction. Ended by the reader's first pointer or
 * key as well as a scroll, Back and Forward included, or by the returned function, as when the document goes.
 */
export function keepSectionWhileTypeLoads(heading: HTMLElement, behavior: ScrollBehavior = 'instant'): () => void {
  if (document.fonts?.status !== 'loading') return () => {};
  return hold(heading, behavior, false);
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
    // What stops listening for the reader moving on from an arrived jump.
    let stopListening = () => {};
    function scrolledOn() {
      // A scroll the page made, or that keeps the window where the page means it to be, isn't the reader's.
      if (!scrollIsThePages()) forget();
    }
    function forget() {
      arrived = false;
      window.removeEventListener('scroll', scrolledOn);
      stopListening();
      stopListening = () => {};
    }
    function arrive() {
      release();
      arrived = true;
      window.addEventListener('scroll', scrolledOn, { passive: true });
      // The reader moving on, even while the page's own correction is still settling: what they scroll to is marked by
      // the rule again, once their scroll rests.
      stopListening = onReaderScroll(forget);
    }
    function letGo() {
      release();
      forget();
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
      forget();
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
        forget();
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
