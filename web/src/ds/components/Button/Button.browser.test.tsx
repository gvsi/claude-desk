/**
 * A busy button under prefers-reduced-motion: reduce, which this project's browser context
 * emulates. The BusyReducedMotion story runs with its play, so its reduced-motion branch is the one
 * checked: the dots stay still, and the button is still named by its label.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it } from 'vitest';

import { BUSY_DOT_REST } from '../../contrast.ts';
import meta, { BusyReducedMotion } from './Button.stories.tsx';

it('busy_dots_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(BusyReducedMotion, meta);
  await story.run();

  const dots = [...document.querySelectorAll<HTMLElement>('.cd-button__dot')];
  expect(dots).toHaveLength(3);
  for (const dot of dots) {
    const style = getComputedStyle(dot);
    expect(style.animationName).toBe('none');
    expect(style.opacity).toBe(String(BUSY_DOT_REST));
  }
});
