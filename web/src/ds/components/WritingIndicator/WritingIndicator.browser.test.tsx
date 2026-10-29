/**
 * The typing dots under prefers-reduced-motion: reduce, which this project's browser context
 * emulates. The ReducedMotion and PersonReducedMotion stories run with their plays, so their
 * reduced-motion branches are the ones checked: the dots stay still in text-secondary, and who is
 * typing is still said.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it } from 'vitest';

import meta, { PersonReducedMotion, ReducedMotion } from './WritingIndicator.stories.tsx';

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

it('person_typing_is_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(PersonReducedMotion, meta);
  await story.run();

  const status = document.querySelector<HTMLElement>('.cd-writing-indicator--person [role="status"]');
  expect(status?.textContent).toBe('Maria Rivera is typing');
  const dots = [...document.querySelectorAll<HTMLElement>('.cd-writing-indicator--person .cd-writing-indicator__dot')];
  expect(dots).toHaveLength(3);
  for (const dot of dots) {
    const style = getComputedStyle(dot);
    expect(style.animationName).toBe('none');
    expect(style.backgroundColor).toBe('rgba(250, 249, 245, 0.64)');
  }
});
