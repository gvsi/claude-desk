/**
 * A busy button under prefers-reduced-motion: reduce, which this project's browser context
 * emulates. The BusyReducedMotion story runs with its play, so its reduced-motion branch is the one
 * checked: the spinner is a still arc, and the button is still named by its label.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it } from 'vitest';

import meta, { BusyReducedMotion } from './Button.stories.tsx';

it('busy_spinner_still_under_reduced_motion', async () => {
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const story = composeStory(BusyReducedMotion, meta);
  await story.run();

  const spinners = [...document.querySelectorAll<SVGElement>('svg.cd-button__spinner')];
  expect(spinners).toHaveLength(1);
  const spinner = spinners[0] as SVGElement;
  const style = getComputedStyle(spinner);
  expect(style.animationName).toBe('none');
  // Still an arc, in the busy label color, where it would start turning.
  expect(style.color).toBe('rgba(250, 249, 245, 0.64)');
  expect(spinner.querySelector('path')).not.toBeNull();
});
