import { withinDeadline } from './fonts.ts';

/** The deadline for a simple animation phase or a frame that never arrives. */
export const ANIMATION_DEADLINE_MS = 2000;

/** Animation waits fail at their own phase, well before Storybook's whole-story ceiling. */
export function animationWithin<T>(promise: Promise<T>, name: string, ms = ANIMATION_DEADLINE_MS): Promise<T> {
  return withinDeadline(promise, ms, name, `${name} did not settle within ${ms} ms`);
}

/** Time left on the animation's clock, plus 1.5 s for a busy runner to deliver its end. */
export function animationDeadline(animation: Animation): number {
  const end = Number(animation.effect?.getComputedTiming().endTime ?? Infinity);
  const current = Number(animation.currentTime ?? 0);
  const rate = animation.playbackRate;
  // A stopped or unreadable clock must still fail within a finite, named deadline.
  if (!Number.isFinite(end) || !Number.isFinite(current) || !Number.isFinite(rate) || rate === 0) return ANIMATION_DEADLINE_MS;
  const remaining = rate > 0 ? (end - current) / rate : current / -rate;
  return Math.ceil(Math.max(0, remaining) + 1500);
}

/** Name the CSS animation, transition property or scripted animation in a stalled wait. */
export function animationLabel(animation: Animation): string {
  if (animation instanceof CSSAnimation) return animation.animationName;
  if (animation instanceof CSSTransition) return `${animation.transitionProperty} transition`;
  return animation.id || 'unnamed animation';
}
