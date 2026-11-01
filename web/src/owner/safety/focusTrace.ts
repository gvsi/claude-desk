/** From this width Safety draws the list and the open attempt or trace side by side (Safety.css). */
export const SIDE_BY_SIDE = '(min-width: 1280px)';

/**
 * Moves focus to the full trace drawn in `box`, so a keyboard or screen reader user lands in it.
 * Beside the list, the trace's column scrolls on its own: focus leaves the page where it is, and the
 * column scrolls to the trace's top, so a trace taller than the window never moves the list (owner
 * comment, 2026-11-01). Stacked under the list, the owner app's main area scrolls only when the
 * trace's title row isn't already in view, and then brings the trace's top just under its edge, so
 * a trace taller than the window opens with its title and close button showing.
 */
export function focusTrace(box: HTMLElement | null): void {
  const trace = box?.querySelector<HTMLElement>('.cd-full-trace');
  if (!trace) return;
  const column = trace.closest<HTMLElement>('.cd-safety__beside');
  const scroller = column !== null && window.matchMedia(SIDE_BY_SIDE).matches ? column : trace.closest<HTMLElement>('.cd-app-shell__main');
  if (scroller === null) {
    trace.focus();
    return;
  }
  trace.focus({ preventScroll: true });
  if (scroller !== column && inView(trace.querySelector<HTMLElement>('.cd-full-trace__top') ?? trace, scroller)) return;
  const inset = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0;
  scroller.scrollTop += trace.getBoundingClientRect().top - scroller.getBoundingClientRect().top - inset;
}

/** Whether all of `el` shows inside `scroller`'s visible box. */
function inView(el: HTMLElement, scroller: HTMLElement): boolean {
  const box = el.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return box.top >= view.top && box.bottom <= view.bottom;
}
