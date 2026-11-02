/**
 * The end of the owner's transcript stays in view, as a chat's does. The transcript scrolls in its
 * own region between the conversation's head and the owner's controls, and in a window too short
 * for that region the open conversation scrolls as a whole instead, the transcript in it. Either
 * way the chat opens at its end, unless it wants her: its first handoff card comes into view while
 * she is still where it opened. At the card, she stays until she scrolls to the end or sends.
 * While she is at the end, whatever arrives there (her words, the visitor's, the typing bubble)
 * and any change in size (the controls growing as she takes over,
 * the window resizing, from one way of scrolling to the other) leave her at the end. Scrolled back
 * to read, she stays where she is until she sends, and then the end comes back. While focus is
 * inside the transcript, on a receipt's trace or a held request she is answering, nothing moves
 * under it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** How far above the end the owner can be and still count as reading it. */
const AT_THE_END_PX = 48;

export interface EndInView {
  /** The transcript's region. */
  ref: (region: HTMLElement | null) => void;
  /** Call when she sends: the end comes back into view, and stays. */
  follow: () => void;
  /** Whether the transcript's region has mounted and opened at its end. */
  ready: boolean;
  /** Reveal the first handoff at the top, only while following the end and without focus inside. */
  reveal: (element: HTMLElement) => void;
}

/**
 * What scrolls the transcript now: the region itself, or, in a window too short for it, the open
 * conversation around it. Read from the styles each time it is needed, never kept, as a resize
 * swaps one for the other.
 */
function scrollerOf(region: HTMLElement): Element {
  for (let node: Element | null = region; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** How far a scroller scrolls at most: its end. */
const endOf = (scroller: Element) => scroller.scrollHeight - scroller.clientHeight;

export function useEndInView(): EndInView {
  const [region, setRegion] = useState<HTMLElement | null>(null);
  const atTheEnd = useRef(false);
  // Where the end of each scroller of the transcript was when last looked at. The chat can shrink
  // and grow under the end before a scroll is told, and the browser moves the view as it shrinks:
  // she has left the end only when the view is above the end both as it is and as it was.
  const ends = useRef(new WeakMap<Element, number>());

  const toTheEnd = useCallback((of: HTMLElement) => {
    const scroller = scrollerOf(of);
    scroller.scrollTop = scroller.scrollHeight;
    ends.current.set(scroller, endOf(scroller));
  }, []);

  useEffect(() => {
    if (!region) return undefined;
    // A chat opens at its end, as a chat does: the latest messages over the controls, where she
    // would write next, and kept there while held requests and fonts arrive above them.
    atTheEnd.current = true;
    toTheEnd(region);
    // From then on, where she is comes from the scrolling of whatever scrolls the transcript then.
    // Scrolling doesn't bubble, so the page's scrolls are caught on their way down to it.
    const notePlace = (event: Event) => {
      const scroller = scrollerOf(region);
      const target = event.target === document ? document.scrollingElement : event.target;
      if (target !== scroller) return;
      const top = scroller.scrollTop;
      const nearTo = (end: number | undefined) => end !== undefined && end - top <= AT_THE_END_PX;
      const was = ends.current.get(scroller);
      const end = endOf(scroller);
      ends.current.set(scroller, end);
      if (nearTo(end)) atTheEnd.current = true;
      else if (!nearTo(was)) atTheEnd.current = false;
    };
    document.addEventListener('scroll', notePlace, { capture: true, passive: true });
    if (typeof ResizeObserver === 'undefined') {
      return () => document.removeEventListener('scroll', notePlace, { capture: true });
    }
    // The end moves without a scroll when what the region holds grows, when the region or the
    // controls under it change height, and when the window resizes the column it all sits in.
    const keep = () => {
      if (atTheEnd.current && !region.contains(document.activeElement)) {
        toTheEnd(region);
      } else {
        const scroller = scrollerOf(region);
        ends.current.set(scroller, endOf(scroller));
      }
    };
    const observer = new ResizeObserver(keep);
    for (const child of region.children) observer.observe(child);
    for (let node: Element | null = region; node !== null; node = node.parentElement) observer.observe(node);
    // Needs you can arrive after the transcript. Its new wrapper must keep being measured too.
    const children = new MutationObserver((changes) => {
      for (const change of changes) {
        for (const child of change.removedNodes) if (child instanceof Element) observer.unobserve(child);
        for (const child of change.addedNodes) if (child instanceof Element) observer.observe(child);
      }
      keep();
    });
    children.observe(region, { childList: true });
    return () => {
      document.removeEventListener('scroll', notePlace, { capture: true });
      observer.disconnect();
      children.disconnect();
    };
  }, [region, toTheEnd]);

  const follow = useCallback(() => {
    atTheEnd.current = true;
    if (region) toTheEnd(region);
  }, [region, toTheEnd]);

  const reveal = useCallback((element: HTMLElement) => {
    if (!region || !atTheEnd.current || region.contains(document.activeElement)) return;
    const scroller = scrollerOf(region);
    atTheEnd.current = false;
    ends.current.set(scroller, endOf(scroller));
    // It stops where the scroller's padding and its own margin say, clear of the bar pinned there.
    const padding = Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    const margin = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0;
    scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop - padding - margin;
  }, [region]);

  return { ref: setRegion, follow, ready: region !== null, reveal };
}
