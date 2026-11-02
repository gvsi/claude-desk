/**
 * The mark in either theme: on the app's grounds its ink is light in the dark theme and the
 * drawing's dark ink in the light one, chosen or by the system. The clay dome, a mark drawn for a
 * light ground and the app icon's tiled bell stay as drawn.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, onTestFinished } from 'vitest';

import { chooseTheme, systemPrefersLight } from '../../test/theme.ts';
import { Mark, MarkAppIcon } from './Mark.tsx';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const PAPER_INK = 'rgb(250, 249, 245)'; // mark-ink-light
const DARK_INK = 'rgb(20, 20, 19)'; // mark-ink
const CLAY = 'rgb(217, 119, 87)'; // mark-clay

/** The three marks drawn, and each one's ink, dome and tile fills as computed. */
function drawMarks() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <>
        <Mark />
        <Mark ground="light" />
        <MarkAppIcon size="compact" />
      </>,
    ),
  );
  onTestFinished(() => {
    act(() => root.unmount());
    host.remove();
  });
  return () =>
    [...host.querySelectorAll('svg')].map((mark) => ({
      ink: getComputedStyle(mark.querySelector('.cd-mark__ink') as Element).fill,
      clay: getComputedStyle(mark.querySelector('.cd-mark__clay') as Element).fill,
      tile: mark.querySelector('.cd-mark__tile') === null ? null : getComputedStyle(mark.querySelector('.cd-mark__tile') as Element).fill,
    }));
}

const asDrawn = (appInk: string) => [
  { ink: appInk, clay: CLAY, tile: null },
  { ink: DARK_INK, clay: CLAY, tile: null },
  { ink: DARK_INK, clay: CLAY, tile: 'rgb(255, 255, 255)' },
];

it('the_marks_ink_follows_the_theme_on_the_apps_grounds', async () => {
  const fills = drawMarks();
  // The dark theme: the system's (this context prefers dark), then chosen.
  expect(fills()).toEqual(asDrawn(PAPER_INK));
  chooseTheme('dark');
  expect(fills()).toEqual(asDrawn(PAPER_INK));
  // The light theme, chosen in this browser.
  chooseTheme('light');
  expect(fills()).toEqual(asDrawn(DARK_INK));
});

it('the_marks_ink_follows_a_system_that_prefers_light_unless_dark_is_chosen', async () => {
  await systemPrefersLight();
  const fills = drawMarks();
  expect(fills()).toEqual(asDrawn(DARK_INK));
  chooseTheme('dark');
  expect(fills()).toEqual(asDrawn(PAPER_INK));
});
