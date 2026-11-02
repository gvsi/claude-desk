import { useSyncExternalStore } from 'react';

/** From this width Safety draws the list and the open attempt or trace side by side (Safety.css). */
export const SIDE_BY_SIDE = '(min-width: 1280px)';

/**
 * What scrolls inside itself beside the list (Safety.css): an attempt's card, or every entry's
 * trace, which then is its own scroller.
 */
const SCROLLS_ITSELF = '.cd-safety__opened > .cd-card, .cd-safety__beside > .cd-full-trace';

function watchSideBySide(changed: () => void): () => void {
  const query = window.matchMedia(SIDE_BY_SIDE);
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}

/**
 * Whether the window is wide enough for the list and the open attempt or trace side by side, where
 * the open one scrolls inside itself and so takes a place in the Tab order. It follows the window.
 */
export function useSideBySide(): boolean {
  return useSyncExternalStore(
    watchSideBySide,
    () => window.matchMedia(SIDE_BY_SIDE).matches,
    () => false,
  );
}

/**
 * Moves focus to the full trace drawn in `box`, so a keyboard or screen reader user lands in it.
 * Beside the list, the page fits the window and what is open scrolls inside itself: focus leaves
 * the page where it is, an attempt's card scrolls to the trace's top, and a trace that scrolls
 * itself starts at its own top, the one before included, so a trace taller than the window never
 * moves the list (owner comments, 2026-11-01 and 2026-11-02). Stacked under the list, focus brings
 * the trace into view as usual.
 */
export function focusTrace(box: HTMLElement | null): void {
  const trace = box?.querySelector<HTMLElement>('.cd-full-trace');
  if (!trace) return;
  const scroller = trace.closest<HTMLElement>(SCROLLS_ITSELF);
  if (scroller === null || !window.matchMedia(SIDE_BY_SIDE).matches) {
    trace.focus();
    return;
  }
  trace.focus({ preventScroll: true });
  if (scroller === trace) {
    trace.scrollTop = 0;
    return;
  }
  const inset = scroller.clientTop + (Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0);
  scroller.scrollTop += trace.getBoundingClientRect().top - scroller.getBoundingClientRect().top - inset;
}
