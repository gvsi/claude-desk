/**
 * The section being read, for the About pages' contents list: the last section whose heading's top is above 40%
 * of the window, or the last section once the page is scrolled to its end, where a short last section's heading
 * may never reach the line. Null above the first heading.
 *
 * Intersection observers over the headings and over a sentinel at the page's end only say when to look again;
 * each look reads every heading's place, never the observers' own entries. A jump can carry headings straight
 * past the line without one coming into the observer's band or leaving it, so the hook also looks once each
 * scroll comes to rest: one look per scroll, not work on every frame.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How far down the window a section's heading has to have come for the section to be the one being read. */
const LINE = 0.4;

/** Where a browser has no `scrollend`, how long the window has to be still for a scroll to have come to rest. */
const REST_WAIT = 100;

/** How long a link's jump holds its section as current with no word that its scroll has ended. */
const JUMP_WAIT = 1000;

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
    // While a link's jump is under way: what lets it go if the scroll never says it has ended, such as a jump to
    // where the window already is.
    let jump: ReturnType<typeof setTimeout> | undefined;
    function look() {
      if (jump === undefined) setCurrent(sectionAt(sections));
    }
    function letGo() {
      clearTimeout(jump);
      jump = undefined;
      window.removeEventListener('scroll', waitLonger);
    }
    // Each scroll of the jump puts the fallback back, so a long glide isn't cut short.
    function waitLonger() {
      clearTimeout(jump);
      jump = setTimeout(() => {
        letGo();
        look();
      }, JUMP_WAIT);
    }
    following.current = (id) => {
      if (!sections.includes(id)) return;
      setCurrent(id);
      if (jump === undefined) window.addEventListener('scroll', waitLonger, { passive: true });
      waitLonger();
    };
    look();
    const stops = [
      onScrollRest(() => {
        letGo();
        look();
      }),
      () => {
        letGo();
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
