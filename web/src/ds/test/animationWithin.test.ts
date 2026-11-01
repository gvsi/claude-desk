import { afterEach, expect, it, vi } from 'vitest';

import { ANIMATION_DEADLINE_MS, animationDeadline, animationWithin } from './animationWithin.ts';

afterEach(() => vi.useRealTimers());

it('names_the_animation_when_its_promise_never_settles', async () => {
  vi.useFakeTimers();
  const result = animationWithin(new Promise<never>(() => {}), 'cd-intro-draw');
  const failed = expect(result).rejects.toThrow(`cd-intro-draw did not settle within ${ANIMATION_DEADLINE_MS} ms`);
  await vi.advanceTimersByTimeAsync(ANIMATION_DEADLINE_MS);
  await failed;
  expect(vi.getTimerCount()).toBe(0);
});

it('cleans_up_the_deadline_on_success_and_preserves_rejections', async () => {
  vi.useFakeTimers();
  await expect(animationWithin(Promise.resolve('finished'), 'cd-intro-tick')).resolves.toBe('finished');
  const cancelled = new Error('animation cancelled');
  await expect(animationWithin(Promise.reject(cancelled), 'cd-intro-tick')).rejects.toBe(cancelled);
  expect(vi.getTimerCount()).toBe(0);
});

it('uses_the_supplied_deadline_for_a_longer_sequence', async () => {
  vi.useFakeTimers();
  let failure: unknown;
  void animationWithin(new Promise<never>(() => {}), 'staggered rows', 3500).catch((error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(3499);
  expect(failure).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(failure).toEqual(new Error('staggered rows did not settle within 3500 ms'));
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  { end: 5000, current: 1000, rate: 2, deadline: 3500 },
  { end: 5000, current: 1000, rate: 0.5, deadline: 9500 },
  { end: 5000, current: 1000, rate: -2, deadline: ANIMATION_DEADLINE_MS },
  { end: 5000, current: 5000, rate: 1, deadline: 1500 },
  { end: 5000, current: 1000, rate: 0, deadline: ANIMATION_DEADLINE_MS },
  { end: Infinity, current: 1000, rate: 1, deadline: ANIMATION_DEADLINE_MS },
])('budgets_time_left_at_rate_$rate_with_end_$end', ({ end, current, rate, deadline }) => {
  const animation = {
    currentTime: current,
    playbackRate: rate,
    effect: { getComputedTiming: () => ({ endTime: end }) },
  } as Animation;
  expect(animationDeadline(animation)).toBe(deadline);
});
