/**
 * The typing bubble under prefers-reduced-motion: reduce, which this project's browser context
 * emulates. The ReducedMotion story runs with its play, so its reduced-motion branch is the one
 * checked: the dots stay still in text-secondary, and "Dana is typing" is still said.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it } from 'vitest';

import meta, { ReducedMotion } from './WritingIndicator.stories.tsx';

it('typing_bubble_is_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(ReducedMotion, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('[role="status"]');
  expect(status?.textContent).toBe('Dana is typing');
  const dots = [...document.querySelectorAll<HTMLElement>('.cd-writing-indicator__dot')];
  expect(dots).toHaveLength(3);
  for (const dot of dots) {
    const style = getComputedStyle(dot);
    expect(style.animationName).toBe('none');
    expect(style.backgroundColor).toBe('rgba(250, 249, 245, 0.64)');
  }
});
