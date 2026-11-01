import { expect, waitFor } from 'storybook/test';

import { ANIMATION_DEADLINE_MS, animationLabel, animationWithin } from './animationWithin.ts';

/**
 * check_draws_short_arm_first: a check that draws once draws as a hand writes one, short arm first.
 * 50 ms into its draw (after any delay it waits for), the stroke shows from the check path's end,
 * the short arm's tip at (4, 12), while its start, the long arm's tip at (20, 6), is still hidden.
 * The dash covers the whole path and the offset runs from minus the dash to 0, so the hidden part
 * is [0, -offset].
 *
 * It looks without changing the motion: the draw is read at that moment and put back where it was,
 * still playing, with nothing awaited in between, so a sequence the check is part of plays on as
 * it would have. A draw already held by a test is finished deterministically; a playing draw gets
 * a deadline so sequences can still prove their natural event order, with the check whole.
 */
export async function expectDrawsShortArmFirst(stroke: SVGPathElement): Promise<void> {
  const [draw] = stroke.getAnimations();
  if (!draw) throw new Error('no draw on the check');
  const length = stroke.getTotalLength();
  const dash = Number.parseFloat(getComputedStyle(stroke).strokeDasharray);

  const ended = draw.playState === 'finished';
  const held = draw.playState === 'paused';
  const was = draw.currentTime;
  draw.pause();
  draw.currentTime = (draw.effect?.getTiming().delay ?? 0) + 50;
  const hiddenUpTo = -Number.parseFloat(getComputedStyle(stroke).strokeDashoffset);
  if (ended || held) {
    draw.finish();
  } else {
    draw.currentTime = was;
    draw.play();
  }

  await expect(dash).toBeGreaterThanOrEqual(length);
  await expect(hiddenUpTo).toBeGreaterThan(0);
  await expect(hiddenUpTo).toBeLessThan(length);
  const tip = (at: number) => {
    const point = stroke.getPointAtLength(at);
    return [Math.round(point.x), Math.round(point.y)];
  };
  await expect(tip(0)).toEqual([20, 6]);
  await expect(tip(length)).toEqual([4, 12]);

  await animationWithin(draw.finished, animationLabel(draw));
  await waitFor(() => expect(getComputedStyle(stroke).strokeDashoffset, `${animationLabel(draw)} ends with the check whole`).toBe('0px'), { timeout: ANIMATION_DEADLINE_MS });
}
