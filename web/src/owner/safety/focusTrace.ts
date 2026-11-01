/** From this width Safety draws the list and the open trace side by side (Safety.css). */
const SIDE_BY_SIDE = '(min-width: 1280px)';

/**
 * Moves focus to the full trace drawn in `box`, so a keyboard or screen reader user lands in it.
 * Beside the list, the trace's column scrolls on its own: focus leaves the page where it is, and the
 * column scrolls to the trace's top, so a trace taller than the window never moves the list (owner
 * comment, 2026-11-01). Stacked under the list, focus brings the trace into view as usual.
 */
export function focusTrace(box: HTMLElement | null): void {
  const trace = box?.querySelector<HTMLElement>('.cd-full-trace');
  if (!trace) return;
  const column = trace.closest<HTMLElement>('.cd-safety__beside');
  if (column === null || !window.matchMedia(SIDE_BY_SIDE).matches) {
    trace.focus();
    return;
  }
  trace.focus({ preventScroll: true });
  const inset = Number.parseFloat(getComputedStyle(column).paddingTop) || 0;
  column.scrollTop += trace.getBoundingClientRect().top - column.getBoundingClientRect().top - inset;
}
