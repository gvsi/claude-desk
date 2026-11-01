import { afterEach, expect, it, vi } from 'vitest';

import { animationWithin } from './animationWithin.ts';

afterEach(() => vi.useRealTimers());

it('names_the_animation_when_its_promise_never_settles', async () => {
  vi.useFakeTimers();
  const result = animationWithin(new Promise<never>(() => {}), 'cd-intro-draw');
  const failed = expect(result).rejects.toThrow('cd-intro-draw did not settle within 2000 ms');
  await vi.advanceTimersByTimeAsync(2000);
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
