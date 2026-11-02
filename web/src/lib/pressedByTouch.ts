/** A press on a touch-first screen, without keyboard focus to carry forward. */
export function pressedByTouch(): boolean {
  return window.matchMedia('(pointer: coarse)').matches && !document.activeElement?.matches(':focus-visible');
}
