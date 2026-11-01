import { afterEach, expect, it } from 'vitest';

import { expectDrawsShortArmFirst } from './expectDrawsShortArmFirst.ts';
import { settled } from './settled.ts';

const root = document.createElement('div');
document.body.append(root);

afterEach(() => {
  for (const animation of root.getAnimations({ subtree: true })) animation.cancel();
  root.replaceChildren();
});

it('finishes_a_held_fade_and_ignores_an_infinite_spinner', async () => {
  const fade = root.animate({ opacity: [0, 1] }, { duration: 10_000, fill: 'forwards', id: 'held-fade' });
  fade.pause();
  const spinner = root.animate({ rotate: ['0deg', '360deg'] }, { duration: 1000, iterations: Infinity });
  await settled(root);
  expect(fade.playState).toBe('finished');
  expect(getComputedStyle(root).opacity).toBe('1');
  expect(spinner.playState).toBe('running');
});

it('names_a_stalled_fade_instead_of_swallowing_its_deadline', async () => {
  const fade = root.animate({ opacity: [0, 1] }, { duration: 10_000, id: 'stalled-fade' });
  fade.playbackRate = 0;
  await expect(settled(root)).rejects.toThrow('stalled-fade did not settle within 2000 ms');
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
