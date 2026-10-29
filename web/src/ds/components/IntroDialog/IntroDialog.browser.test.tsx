/**
 * The intro dialog under a real keyboard. Playwright presses these keys, so the browser's own
 * handling of a modal dialog runs too (by default Escape closes one), which the stories' simulated
 * keys never reach.
 */
import { composeStory } from '@storybook/react-vite';
import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import meta, { Default } from './IntroDialog.stories.tsx';

const story = composeStory({ ...Default, play: undefined }, meta, undefined, 'Default');

/** Renders the story without its play; each run replaces the last one's render. */
async function openDialog(): Promise<{ dialog: HTMLDialogElement; field: HTMLInputElement; button: HTMLButtonElement }> {
  await story.run();
  expect(document.querySelectorAll('dialog.cd-intro')).toHaveLength(1);
  const dialog = document.querySelector<HTMLDialogElement>('dialog.cd-intro');
  const field = dialog?.querySelector<HTMLInputElement>('input[type="password"]');
  const button = dialog?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!dialog || !field || !button) throw new Error('the intro dialog did not render');
  return { dialog, field, button };
}

it('escape_never_closes_it_with_a_real_keyboard', async () => {
  const { dialog, field } = await openDialog();
  expect(dialog.open).toBe(true);
  expect(document.activeElement).toBe(field);
  // Twice: Chrome lets a page cancel only one Escape between user activations, unless the key
  // never reaches the dialog's own handling.
  await userEvent.keyboard('{Escape}');
  await userEvent.keyboard('{Escape}');
  expect(dialog.open).toBe(true);
  expect(dialog.isConnected).toBe(true);
});

it('tab_stays_inside_with_a_real_keyboard', async () => {
  const { field, button } = await openDialog();
  await userEvent.keyboard('rivera-demo');
  expect(button.disabled).toBe(false);
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(field);
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(field);
});
