/**
 * A busy button under prefers-reduced-motion: reduce, which this project's browser context
 * emulates. The BusyReducedMotion story runs with its play, so its reduced-motion branch is the one
 * checked: the spinner is a still arc, and the button is still named by its label. And the button's
 * ref, which lets go while the button is still on the page.
 */
import { composeStory } from '@storybook/react-vite';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';

import { Button } from './Button.tsx';
import meta, { BusyReducedMotion } from './Button.stories.tsx';

declare global {
  // Tells React this test drives its updates inside act().
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

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

it('button_ref_lets_go_while_the_button_is_on_the_page', () => {
  // `buttonRef` is the <button> itself, and React lets go of it (calls it with null) before it takes
  // the button off the page, so a screen can still read then whether the button had focus.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls: { element: string; connected?: boolean; focused?: boolean }[] = [];
  const held: { button: HTMLButtonElement | null } = { button: null };
  const ref = (element: HTMLButtonElement | null) => {
    const { button } = held;
    if (element === null) calls.push({ element: 'null', connected: button?.isConnected, focused: button !== null && document.activeElement === button });
    else calls.push({ element: element.localName });
    held.button = element;
  };
  try {
    act(() => root.render(<Button variant="secondary" buttonRef={ref}>Ask for Maria Rivera</Button>));
    held.button?.focus();
    act(() => root.render(null));
    expect(calls).toEqual([{ element: 'button' }, { element: 'null', connected: true, focused: true }]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
