import { useContext, useLayoutEffect, useRef } from 'react';
import { UNSAFE_NavigationContext, useLocation, useNavigationType } from 'react-router';

import { keepSectionWhileTypeLoads } from './useCurrentSection.ts';

/**
 * The section an address's fragment names, decoded, or null when it names none. A fragment that isn't valid
 * percent-encoding, such as a percent sign with no two hex digits after it, names no section, so the page
 * opens at its top.
 */
function sectionAnchor(hash: string): string | null {
  if (hash.length <= 1) return null;
  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return null;
  }
}

/** What one router's About and vision pages remember: whether one has drawn yet, and where the window last was in each. */
interface Reading {
  drawn: boolean;
  places: Partial<Record<string, number>>;
}

/** By router, which the app makes once per window, so each window, and each test's router, starts afresh. */
const READING = new WeakMap<object, Reading>();

/**
 * Where the window goes when a document draws. Opened by a link or in place of the current page, it starts at
 * its top, or at the section its address names, whose anchor exists only once the page has drawn. Back and
 * Forward return to where the reader last was in that document: the browser's own restoring races the router's
 * drawing of the page, and loses when the page it leaves is shorter. The router counts the address a window
 * loads as a move back, so its first page opens as the address says. This runs only when a document draws, not
 * on every hash: the contents list's links move within the page by themselves. These moves are instant whatever
 * the page's styles say, so a glide never passes, or records, a place on the way. A section the address opened is
 * kept in place while the reading type loads, until the document goes.
 */
export function usePagePlace(id: string) {
  // The router's navigator: one object for as long as the router lives.
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const navigationType = useNavigationType();
  const { pathname, hash } = useLocation();
  // The window's address while the router shows this page, taken again when the same document's address
  // changes, as when the page's own link drops a trailing slash.
  const own = useRef('');
  useLayoutEffect(() => {
    own.current = window.location.pathname;
  }, [pathname]);
  // How this document opened, decided once for it: React's StrictMode runs the effect below twice for one opening,
  // and the second run must open it the same way, not take the first run's drawing for a move back.
  const opening = useRef<{ id: string; back: boolean } | null>(null);
  useLayoutEffect(() => {
    const reading = READING.get(navigator) ?? { drawn: false, places: {} };
    READING.set(navigator, reading);
    if (opening.current?.id !== id) opening.current = { id, back: navigationType === 'POP' && reading.drawn };
    // What stops keeping an address's section in place while the type loads, once this document goes.
    let stopKeeping = () => {};
    if (opening.current.back) {
      window.scrollTo({ top: reading.places[id] ?? 0, behavior: 'instant' });
    } else {
      const anchor = sectionAnchor(hash);
      const section = anchor ? document.getElementById(anchor) : null;
      if (section) {
        section.scrollIntoView({ behavior: 'instant' });
        stopKeeping = keepSectionWhileTypeLoads(section);
      } else {
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
    }
    reading.drawn = true;
    // Back changes the window's address, and the browser restores the next page's place, before the router
    // draws that page; a scroll heard after the address moved on is the next page's, not the reader's.
    const remember = () => {
      if (window.location.pathname === own.current) reading.places[id] = window.scrollY;
    };
    remember();
    window.addEventListener('scroll', remember, { passive: true });
    return () => {
      window.removeEventListener('scroll', remember);
      stopKeeping();
    };
  }, [id]);
}
