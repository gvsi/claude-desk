/**
 * The intro dialog under a real keyboard and pointer. Playwright presses these keys and clicks, so
 * the browser's own handling of a modal dialog runs too (by default Escape closes one), which the
 * stories' simulated events never reach. Also the README's promises that no story shows.
 */
import { composeStory } from '@storybook/react-vite';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { INTRO_ERROR_COPY, type IntroErrorCode } from './introCopy.ts';
import { IntroDialog, type IntroDialogProps } from './IntroDialog.tsx';
import meta, { Default } from './IntroDialog.stories.tsx';

const story = composeStory({ ...Default, play: undefined }, meta, undefined, 'Default');

/** The Default story with other args, rendered without its play. */
async function runWith(args: Partial<Omit<IntroDialogProps, 'onSubmit'>>): Promise<HTMLDialogElement> {
  await composeStory({ ...Default, args, play: undefined }, meta, undefined, 'Default').run();
  expect(document.querySelectorAll('dialog.cd-intro')).toHaveLength(1);
  const dialog = document.querySelector<HTMLDialogElement>('dialog.cd-intro');
  if (!dialog) throw new Error('the intro dialog did not render');
  return dialog;
}

// First, so no story render from another test is on the page: a page that wraps the dialog in
// an inert element by mistake. The modal dialog escapes inertness in the browser, and Tab must
// still go round its own controls rather than finding none.
it('tab_stays_inside_even_inside_an_inert_wrapper', async () => {
  const host = document.createElement('div');
  host.setAttribute('inert', '');
  document.body.append(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(<IntroDialog {...(meta.args as IntroDialogProps)} />));
    const dialog = host.querySelector('dialog');
    const field = host.querySelector('input');
    const button = host.querySelector('button');
    expect(dialog?.open).toBe(true);
    expect(document.activeElement).toBe(field);
    await userEvent.keyboard('rivera-demo');
    expect(button?.disabled).toBe(false);
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(field);
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(button);
  } finally {
    root.unmount();
    host.remove();
  }
});

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

it('a_real_press_on_the_scrim_changes_nothing', async () => {
  const { dialog, field } = await openDialog();
  // 8 px in from the window's corner: the scrim, well outside the panel.
  await userEvent.click(dialog, { position: { x: 8, y: 8 } });
  expect(dialog.open).toBe(true);
  expect(dialog.isConnected).toBe(true);
  expect(document.activeElement).toBe(field);
});

it('an_item_without_icon_or_detail_shows_neither', async () => {
  const dialog = await runWith({
    thingsToTry: [{ title: 'Look around' }, { title: 'Chat as a customer', detail: 'Rivera’s public page opens beside you.', icon: 'person' }],
  });
  const items = [...dialog.querySelectorAll('li')];
  expect(items).toHaveLength(2);
  expect(items[0]?.querySelector('svg')).toBeNull();
  expect(items[0]?.querySelector('.cd-intro__thing-detail')).toBeNull();
  expect(items[0]?.textContent).toBe('Look around');
  expect(items[1]?.querySelector('svg')).not.toBeNull();
  expect(items[1]?.querySelector('.cd-intro__thing-detail')?.textContent).toBe('Rivera’s public page opens beside you.');
});

it('an_unknown_error_code_reads_as_unreachable', async () => {
  const dialog = await runWith({ error: 'brand_new_code' as IntroErrorCode });
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(INTRO_ERROR_COPY.unreachable);
  expect(dialog.querySelector('input')?.getAttribute('aria-invalid')).toBe('true');
  expect(document.body.innerHTML).not.toContain('brand_new_code');
});
