/**
 * Reading a breath as it is drawn, so a test can hold its faintest point to a contrast floor: the
 * lowest opacity the element's running breath reaches, and the opaque background it is drawn on.
 */

/** The lowest opacity `el`'s running animation reaches, read from its keyframes. Throws if nothing runs. */
export function faintestOpacity(el: Element): number {
  const [breath] = el.getAnimations();
  if (!breath?.effect) throw new Error('nothing breathes on the element');
  return Math.min(...(breath.effect as KeyframeEffect).getKeyframes().map((frame) => Number(frame.opacity ?? 1)));
}

/** The opaque background `el` is drawn on: the first one up its ancestors that paints one. */
export function paintedGroundOf(el: Element): string {
  for (let at = el.parentElement; at !== null; at = at.parentElement) {
    const color = getComputedStyle(at).backgroundColor;
    if (color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color;
  }
  throw new Error('nothing under the element paints a background');
}
