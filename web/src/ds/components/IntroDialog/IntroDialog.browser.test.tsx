/**
 * The intro dialog under a real keyboard and pointer. Playwright presses these keys and clicks, so
 * the browser's own handling of a modal dialog runs too (by default Escape closes one), which the
 * stories' simulated events never reach. Also the README's promises that no story shows.
 */
import { composeStory } from '@storybook/react-vite';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';

import { CAPS_BADGE } from '../../test/copy.ts';
import { INTRO_ERROR_COPY, type IntroErrorCode } from './introCopy.ts';
import { IntroDialog, type IntroDialogProps } from './IntroDialog.tsx';
import meta, { Default } from './IntroDialog.stories.tsx';

const story = composeStory({ ...Default, play: undefined }, meta, undefined, 'Default');

/** The Default story with other args, rendered without its play. */
async function runWith(args: Partial<Omit<IntroDialogProps, 'onSubmit' | 'onClosed'>>): Promise<HTMLDialogElement> {
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
    const author = host.querySelector('[data-ds="concept-footer"] a');
    expect(document.activeElement).toBe(field);
    await userEvent.keyboard('rivera-demo');
    expect(button?.disabled).toBe(false);
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(button);
    // The footer's author link, inside the dialog, then round to the field.
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(author);
    await userEvent.keyboard('{Tab}');
    expect(document.activeElement).toBe(field);
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
    expect(document.activeElement).toBe(author);
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
  const { dialog, field, button } = await openDialog();
  const author = dialog.querySelector('[data-ds="concept-footer"] a');
  await userEvent.keyboard('rivera-demo');
  expect(button.disabled).toBe(false);
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(author);
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(field);
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(author);
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

it('the_illustration_is_whole_from_the_start_under_reduced_motion', async () => {
  // This project emulates reduced motion: the panel, the two cards, the booking's check and the
  // receipts show at rest from the first frame, and the check is drawn rather than waiting to be.
  expect(window.matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
  const { dialog } = await openDialog();
  const art = dialog.querySelector('.cd-intro__illustration') as HTMLElement;
  const still = [
    dialog.querySelector('.cd-intro__panel'),
    ...art.querySelectorAll(':scope > .cd-intro__card'),
    ...art.querySelectorAll('.cd-intro__receipt'),
  ] as HTMLElement[];
  expect(still).toHaveLength(5);
  for (const el of still) {
    const style = getComputedStyle(el);
    expect([style.animationName, style.opacity, style.transform]).toEqual(['none', '1', 'none']);
  }
  const check = getComputedStyle(art.querySelector('.cd-intro__check path') as Element);
  expect([check.animationName, check.strokeDasharray, check.strokeDashoffset]).toEqual(['none', 'none', '0px']);
  expect(dialog.getAnimations({ subtree: true })).toEqual([]);
});

it('the_exit_closes_at_once_under_reduced_motion', async () => {
  // Under reduced motion there is no exit to wait for: as the page says the passcode worked, the
  // dialog closes before the browser draws a frame of it leaving, and says so once. It says so to
  // the page as that render left it: the `onClosed` passed with `leaving`, never an earlier one,
  // which a page like Arrival's would read with no Desk to go on to, leaving the visitor on the
  // preview.
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onClosedBefore = vi.fn();
  const onClosed = vi.fn();
  const props = meta.args as IntroDialogProps;
  try {
    flushSync(() => root.render(<IntroDialog {...props} onClosed={onClosedBefore} busy />));
    const dialog = host.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    flushSync(() => root.render(<IntroDialog {...props} onClosed={onClosed} leaving />));
    expect(dialog.classList.contains('cd-intro--leaving')).toBe(true);
    expect(dialog.open).toBe(false);
    expect(onClosedBefore).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
    const panel = dialog.querySelector('.cd-intro__panel') as HTMLElement;
    expect([getComputedStyle(dialog).animationName, getComputedStyle(panel).animationName]).toEqual(['none', 'none']);
    // Nothing was left waiting to close it again.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onClosedBefore).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledTimes(1);
  } finally {
    root.unmount();
    host.remove();
  }
});

it('an_item_without_icon_or_detail_shows_neither', async () => {
  const dialog = await runWith({
    thingsToTry: [{ title: 'Look around' }, { title: 'Chat as a customer', detail: 'Turner’s public page opens in a new tab.', icon: 'person' }],
  });
  const items = [...dialog.querySelectorAll('li')];
  expect(items).toHaveLength(2);
  expect(items[0]?.querySelector('svg')).toBeNull();
  expect(items[0]?.querySelector('.cd-intro__thing-detail')).toBeNull();
  expect(items[0]?.textContent).toBe('Look around');
  expect(items[1]?.querySelector('svg')).not.toBeNull();
  expect(items[1]?.querySelector('.cd-intro__thing-detail')?.textContent).toBe('Turner’s public page opens in a new tab.');
});

it('an_unknown_error_code_reads_as_unreachable', async () => {
  const dialog = await runWith({ error: 'brand_new_code' as IntroErrorCode });
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(INTRO_ERROR_COPY.unreachable);
  expect(dialog.querySelector('input')?.getAttribute('aria-invalid')).toBe('true');
  expect(document.body.innerHTML).not.toContain('brand_new_code');
});

afterEach(async () => {
  await page.viewport(1280, 820);
});

it('brand_row_shows_the_preview_badge_as_the_lockup_does', async () => {
  // The brand row is the mark and the Wordmark with its Preview badge, the one label the product
  // shows beside its name (owner, 2026-10-30), set as the sidebar's lockup sets it: the badge 8 px
  // from the name, each centred on the mark, the name on one line. The mark keeps the intro board's
  // 20 px and 8 px. At a phone's width the row still fits on one line.
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    const where = `at ${width}`;
    await page.viewport(width, height);
    const { dialog } = await openDialog();
    const brand = dialog.querySelector<HTMLElement>('.cd-intro__brand');
    expect(brand?.textContent, where).toBe('Claude Desk Preview');
    const mark = brand?.querySelector(':scope > svg.cd-mark');
    const name = brand?.querySelector(':scope > .cd-wordmark > .cd-type-wordmark');
    const badge = brand?.querySelector(`:scope > .cd-wordmark > ${CAPS_BADGE.selector}`);
    if (!mark || !name || !badge) throw new Error(`${where}: the brand row has no mark, name or badge`);
    expect([mark.getAttribute('width'), mark.getAttribute('height')], where).toEqual(['20', '20']);
    const [m, n, b] = [mark, name, badge].map((el) => el.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect];
    expect(n.left - m.right, where).toBe(8);
    expect(b.left - n.right, where).toBe(8);
    expect(n.height, where).toBe(22);
    const middle = (r: DOMRect) => r.top + r.height / 2;
    expect(Math.abs(middle(n) - middle(m)), where).toBeLessThanOrEqual(0.5);
    expect(Math.abs(middle(b) - middle(m)), where).toBeLessThanOrEqual(0.5);
    expect(b.right, where).toBeLessThanOrEqual((brand?.getBoundingClientRect().right ?? 0) + 0.5);
  }
});
