/**
 * The About pages' one reading of the reader's motion preference: for a figure deciding whether to play, and a
 * contents link deciding whether to glide.
 */

/** Whether the reader asked for reduced motion, or the browser can't say. */
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
