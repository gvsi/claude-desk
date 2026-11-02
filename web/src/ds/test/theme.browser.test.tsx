/**
 * The Storybook theme toolbar: every story draws in the dark theme, whatever the system prefers,
 * unless its `theme` global asks for light (`&globals=theme:light` in a story's address). And the
 * app's own default: a root marked neither follows the system, and a chosen theme overrides it.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it, onTestFinished } from 'vitest';

import { chooseTheme, systemPrefersLight } from './theme.ts';

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

it('a_root_marked_neither_follows_the_system_and_a_choice_overrides_it', async () => {
  // A first visit with nothing chosen: the device's own theme, with the browser's scheme in step.
  delete document.documentElement.dataset.theme;
  const look = () => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).colorScheme];
  const dark = ['rgb(28, 27, 25)', 'dark'];
  const light = ['rgb(246, 244, 238)', 'light'];
  // A device that prefers dark, as this project's test browsers do, draws dark; Light chosen overrides it.
  expect(look()).toEqual(dark);
  chooseTheme('light');
  expect(look()).toEqual(light);
  // A device that prefers light draws light; Dark chosen overrides it.
  delete document.documentElement.dataset.theme;
  await systemPrefersLight();
  expect(look()).toEqual(light);
  chooseTheme('dark');
  expect(look()).toEqual(dark);
});
