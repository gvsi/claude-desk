/**
 * The Storybook theme toolbar: every story draws in the dark theme, whatever the system prefers,
 * unless its `theme` global asks for light (`&globals=theme:light` in a story's address).
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it, onTestFinished } from 'vitest';

import { systemPrefersLight } from './theme.ts';

const meta = { title: 'Test/Theme' };
const noBoard = { canvas: 'none', canvasNote: 'A probe story for the theme toolbar.' };

function probe(globals?: Record<string, string>) {
  return composeStory(
    { render: () => <p className="cd-type-body">Here are the details.</p>, parameters: noBoard, ...(globals === undefined ? {} : { globals }) },
    meta,
    undefined,
    'Probe',
  );
}

/** The theme the story's document is marked with, and the page's ground as drawn. */
function drawn() {
  return [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor];
}

const DARK = ['dark', 'rgb(28, 27, 25)'];
const LIGHT = ['light', 'rgb(246, 244, 238)'];

it('stories_draw_dark_unless_the_theme_global_asks_for_light', async () => {
  onTestFinished(() => {
    delete document.documentElement.dataset.theme;
  });
  await probe().run();
  expect(drawn()).toEqual(DARK);
  await probe({ theme: 'light' }).run();
  expect(drawn()).toEqual(LIGHT);
  await probe({ theme: 'dark' }).run();
  expect(drawn()).toEqual(DARK);
  // A system that prefers light still gets the dark theme by default, so a story looks the same
  // on every machine.
  await systemPrefersLight();
  await probe().run();
  expect(drawn()).toEqual(DARK);
});
