import { animationDeadline, animationLabel, animationWithin } from './animationWithin.ts';

/**
 * Waits until nothing under `root` is still arriving, so a test measures a screen at rest rather
 * than partway through its one moment. Loops (a busy button's spinner) never end, so they don't
 * count; an animation cancelled on the way counts as done.
 */
export async function settled(root: Element): Promise<void> {
  const ending = root
    .getAnimations({ subtree: true })
    .filter((animation) => animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY);
  await Promise.all(
    ending.map((animation) => animationWithin(animation.finished.catch(() => undefined), animationLabel(animation), animationDeadline(animation))),
  );
}
