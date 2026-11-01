import { afterEach, expect, it, vi } from 'vitest';

import { ANIMATION_DEADLINE_MS } from './animationWithin.ts';
import { expectDrawsShortArmFirst } from './expectDrawsShortArmFirst.ts';
import { framesWithin } from './framesWithin.ts';
import { settled } from './settled.ts';

const root = document.createElement('div');
document.body.append(root);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const animation of root.getAnimations({ subtree: true })) animation.cancel();
  root.replaceChildren();
});

it('rejects_a_paused_fade_and_ignores_an_infinite_spinner', async () => {
  const fade = root.animate({ opacity: [0, 1] }, { duration: 500, fill: 'forwards', id: 'held-fade' });
  fade.pause();
  const spinner = root.animate({ rotate: ['0deg', '360deg'] }, { duration: 1000, iterations: Infinity });
  await expect(settled(root)).rejects.toThrow(`held-fade did not settle within ${ANIMATION_DEADLINE_MS} ms`);
  expect(fade.playState).toBe('paused');
  expect(spinner.playState).toBe('running');
});

it('rejects_a_paused_zero_rate_fade_without_finishing_or_leaking_a_rejection', async () => {
  const fade = root.animate({ opacity: [0, 1] }, { duration: 10_000, id: 'stalled-fade' });
  fade.pause();
  fade.playbackRate = 0;
  await expect(settled(root)).rejects.toThrow(`stalled-fade did not settle within ${ANIMATION_DEADLINE_MS} ms`);
  expect(fade.playState).toBe('paused');
});

it('samples_and_finishes_a_held_check_draw', async () => {
  root.innerHTML = '<svg><path d="M20 6 L9 17 L4 12" /></svg>';
  const stroke = root.querySelector('path')!;
  const dash = Math.ceil(stroke.getTotalLength());
  stroke.style.strokeDasharray = `${dash}`;
  const draw = stroke.animate({ strokeDashoffset: [-dash, 0] }, { duration: 200, fill: 'forwards', id: 'held-check-draw' });
  draw.pause();
  await expectDrawsShortArmFirst(stroke);
  expect(draw.playState).toBe('finished');
  expect(getComputedStyle(stroke).strokeDashoffset).toBe('0px');
});

it('allows_a_correct_sequence_longer_than_the_simple_deadline', async () => {
  const fade = root.animate({ opacity: [0, 1] }, { duration: 2200, fill: 'forwards', id: 'long-sequence' });
  await settled(root);
  expect(fade.playState).toBe('finished');
});

it.each([
  { name: 'screen redraw frames', count: 2 },
  { name: 'cd-skeleton-sweep frame', count: 1 },
])('times_out_and_cancels_the_pending_$name', async ({ name, count }) => {
  vi.useFakeTimers();
  const callbacks: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => callbacks.push(callback));
  const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  const waiting = framesWithin(name, count).catch((error: unknown) => error);
  if (count === 2) callbacks[0]!(0);
  await vi.advanceTimersByTimeAsync(ANIMATION_DEADLINE_MS);
  const outcome = await Promise.race([waiting, Promise.resolve('still pending')]);
  expect(outcome).toEqual(new Error(`${name} did not settle within ${ANIMATION_DEADLINE_MS} ms`));
  expect(cancel).toHaveBeenCalledWith(count);
});
