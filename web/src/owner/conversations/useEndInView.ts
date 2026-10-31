/**
 * The end of the owner's transcript stays in view, as a chat's does. The transcript scrolls in its
 * own region between the conversation's head and the owner's controls, and opens at its end. While
 * that region is scrolled to the end, whatever arrives there (her words, the visitor's, the typing
 * bubble) and any change in the region's own height (the controls under it growing as she takes
 * over, the window resizing) leave it at the end. Scrolled back to read, she stays where she is
 * until she sends, and then the end comes back. While focus is inside the transcript, on a
 * receipt's trace or a held request she is answering, nothing moves under it. In a window too
 * short for the region, the open conversation scrolls as a whole and the region doesn't scroll, so
 * nothing here moves it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How far above the end the owner can be and still count as reading it. */
const AT_THE_END_PX = 48;

export interface EndInView {
  /** The transcript's scroll region. */
  ref: (region: HTMLElement | null) => void;
  /** Call when she sends: the end comes back into view, and stays. */
  follow: () => void;
}

export function useEndInView(): EndInView {
  const [region, setRegion] = useState<HTMLElement | null>(null);
  const atTheEnd = useRef(false);

  const toTheEnd = useCallback(() => {
    if (region) region.scrollTop = region.scrollHeight;
  }, [region]);

  useEffect(() => {
    if (!region) return undefined;
    // A chat opens at its end, as a chat does: the latest messages over the controls, where she
    // would write next, and kept there while held requests and fonts arrive above them.
    atTheEnd.current = true;
    toTheEnd();
    // From then on, where she is comes from the region's own scrolling.
    const notePlace = () => {
      atTheEnd.current = region.scrollHeight - region.clientHeight - region.scrollTop <= AT_THE_END_PX;
    };
    region.addEventListener('scroll', notePlace, { passive: true });
    if (typeof ResizeObserver === 'undefined') return () => region.removeEventListener('scroll', notePlace);
    // The region changing height, or what it holds growing, moves the end without a scroll.
    const keep = () => {
      if (atTheEnd.current && !region.contains(document.activeElement)) toTheEnd();
    };
    const observer = new ResizeObserver(keep);
    observer.observe(region);
    for (const child of region.children) observer.observe(child);
    return () => {
      region.removeEventListener('scroll', notePlace);
      observer.disconnect();
    };
  }, [region, toTheEnd]);

  const follow = useCallback(() => {
    atTheEnd.current = true;
    toTheEnd();
  }, [toTheEnd]);

  return { ref: setRegion, follow };
}
