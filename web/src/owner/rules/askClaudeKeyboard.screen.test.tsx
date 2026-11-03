/**
 * Ask Claude opened from one of Turner's suggestions on Rules by keyboard, in a real browser against
 * the mock API: Tab to the suggestion, Enter, and once Claude's review is in, closing the panel
 * (Escape, or Tab to Close and Enter) gives focus back to the suggestion, as a click does; when the
 * suggestion has gone, its change now in effect, to the composer above the suggestions. Beside the
 * page at 1440 px, and as a sheet over it at 900 px (under 640 px Rules shows no suggestions).
 */
import { describe, expect, it } from 'vitest';
import { userEvent, type Locator } from 'vitest/browser';

import { coarsePointer } from '../../ds/test/touch.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { renderRoute } from '../../test/renderRoute.tsx';

const RULES = `/app/${RIVERA.deskId}/rules`;

/** Where Ask Claude opens: beside the page, or as a sheet over it. */
type Place = 'beside the page' | 'as a sheet';

const WINDOWS: Record<Place, { width: number; height: number }> = {
  'beside the page': { width: 1440, height: 900 },
  'as a sheet': { width: 900, height: 900 },
};

/** How the owner closes Ask Claude by keyboard. */
type Closing = 'Escape' | 'Close';

const CASES: [Closing, Place][] = [
  ['Escape', 'beside the page'],
  ['Close', 'beside the page'],
  ['Escape', 'as a sheet'],
  ['Close', 'as a sheet'],
];

/** Presses Tab, or Shift+Tab when `back`, until `target` has focus. */
async function tabTo(target: Element, { back = false } = {}): Promise<void> {
  for (let presses = 0; presses < 40 && document.activeElement !== target; presses += 1) await userEvent.tab({ shift: back });
  expect(document.activeElement, 'Tab reaches it').toBe(target);
}

/**
 * Rules, with Ask Claude opened by Tab from the composer to Turner's suggestion `words` and Enter,
 * and Claude's review of the change it drafted in.
 */
async function openFromSuggestionByKeyboard(place: Place, words: string) {
  const { screen } = await renderRoute(RULES, { viewport: WINDOWS[place], seed: 'rivera_quiet' });
  const composer = screen.getByRole('textbox', { name: 'Ask Claude to change a rule' });
  const chip = screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: words, exact: true });
  await expect.element(chip, { timeout: 4_000 }).toBeVisible();
  composer.element().focus();
  await tabTo(chip.element());
  await userEvent.keyboard('{Enter}');
  const panel = screen.getByRole(place === 'as a sheet' ? 'dialog' : 'complementary', { name: 'Ask Claude' });
  const log = panel.getByRole('log');
  await expect.element(log.getByRole('button', { name: 'Confirm change' }), { timeout: 4_000 }).toBeEnabled();
  return { screen, composer, chip, panel, log };
}

/**
 * Closes Ask Claude by keyboard, with Escape or with Shift+Tab to Close and Enter, and waits until
 * it has gone, beside the page once it has slid out, so nothing it does as it leaves is missed.
 */
async function closeByKeyboard(panel: Locator, closing: Closing): Promise<void> {
  if (closing === 'Escape') {
    await userEvent.keyboard('{Escape}');
  } else {
    await tabTo(panel.getByRole('button', { name: 'Close' }).element(), { back: true });
    await userEvent.keyboard('{Enter}');
  }
  await expect.element(panel, { timeout: 4_000 }).not.toBeInTheDocument();
  await expect.poll(() => document.querySelector('.cd-app-shell__panel'), { timeout: 4_000 }).toBeNull();
}

describe('ask claude opened from a suggestion by keyboard', () => {
  it('the_page_composer_keeps_focus_when_asking_with_the_panel_open', { timeout: 25_000 }, async () => {
    const { composer, panel } = await openFromSuggestionByKeyboard('beside the page', 'Stop quoting on weekends');
    await composer.fill('Keep weekday quotes as they are');
    await userEvent.keyboard('{Enter}');
    await expect.element(panel.getByRole('log').getByText('Keep weekday quotes as they are', { exact: true }), { timeout: 4_000 }).toBeVisible();
    await expect.element(composer, { timeout: 4_000 }).toHaveFocus();
  });

  it('the_phone_panel_send_keeps_focus_in_its_composer_without_visiting_close', async () => {
    await coarsePointer();
    const { screen } = await renderRoute(RULES, { viewport: 'phone' });
    await screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).fill('Stop quoting on weekends');
    await userEvent.keyboard('{Enter}');
    const panel = screen.getByRole('dialog', { name: 'Ask Claude' });
    await expect.element(panel.getByRole('button', { name: 'Keep my rules' }), { timeout: 4_000 }).toBeEnabled();
    const composer = panel.getByRole('textbox', { name: 'Ask Claude' });
    await composer.fill('Keep weekday quotes as they are');
    const close = panel.getByRole('button', { name: 'Close' }).element();
    let visitedClose = false;
    const visit = () => { visitedClose = true; };
    close.addEventListener('focus', visit);
    try {
      await panel.getByRole('button', { name: 'Send', exact: true }).click();
      await expect.element(composer, { timeout: 4_000 }).toHaveFocus();
      expect(visitedClose).toBe(false);
    } finally {
      close.removeEventListener('focus', visit);
    }
  });

  it.each(['keyboard', 'touch'] as const)('a_suggestion_in_an_open_panel_hands_focus_on_by_%s', { timeout: 25_000 }, async (input) => {
    if (input === 'touch') await coarsePointer();
    const { screen, panel } = await openFromSuggestionByKeyboard('beside the page', 'Stop quoting on weekends');
    const words = 'Quote water heater installs up to $600';
    const chip = screen.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: words, exact: true });
    if (input === 'keyboard') {
      chip.element().focus();
      await userEvent.keyboard('{Enter}');
      await expect.element(panel.getByRole('textbox', { name: 'Ask Claude' }), { timeout: 4_000 }).toHaveFocus();
    } else {
      await chip.click();
      await expect.element(panel.getByRole('button', { name: 'Close' }), { timeout: 4_000 }).toHaveFocus();
      expect(document.activeElement?.matches(':focus-visible')).toBe(false);
    }
    await expect.element(panel.getByRole('log').getByText(words, { exact: true }), { timeout: 4_000 }).toBeVisible();
  });

  it.each(['desktop', 'phone'] as const)('keeping_rules_returns_focus_to_the_panel_composer_on_%s', async (viewport) => {
    const { screen } = await renderRoute(RULES, { viewport });
    await screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).fill('Stop quoting on weekends');
    await userEvent.keyboard('{Enter}');
    const panel = screen.getByRole(viewport === 'phone' ? 'dialog' : 'complementary', { name: 'Ask Claude' });
    const keep = panel.getByRole('button', { name: 'Keep my rules' });
    await expect.element(keep, { timeout: 4_000 }).toBeEnabled();
    await tabTo(keep.element(), { back: true });
    await userEvent.keyboard('{Enter}');
    await expect.element(panel.getByText('Nothing changed. Your rules stay as they are.'), { timeout: 4_000 }).toBeVisible();
    await expect.element(panel.getByRole('textbox', { name: 'Ask Claude' }), { timeout: 4_000 }).toHaveFocus();
  });

  it('keeping_rules_by_touch_hands_focus_on_without_opening_the_keyboard', async () => {
    await coarsePointer();
    const { screen } = await renderRoute(RULES, { viewport: 'phone' });
    await screen.getByRole('textbox', { name: 'Ask Claude to change a rule' }).fill('Stop quoting on weekends');
    await userEvent.keyboard('{Enter}');
    const panel = screen.getByRole('dialog', { name: 'Ask Claude' });
    const keep = panel.getByRole('button', { name: 'Keep my rules' });
    await expect.element(keep, { timeout: 4_000 }).toBeEnabled();
    await keep.click();
    await expect.element(panel.getByText('Nothing changed. Your rules stay as they are.'), { timeout: 4_000 }).toBeVisible();
    await expect.element(panel.getByRole('button', { name: 'Close' }), { timeout: 4_000 }).toHaveFocus();
    expect(document.activeElement?.matches(':focus-visible')).toBe(false);
  });

  it.each(CASES)('closing_with_%s_gives_focus_back_to_the_suggestion %s', { timeout: 25_000 }, async (closing, place) => {
    const { chip, panel } = await openFromSuggestionByKeyboard(place, 'Quote water heater installs up to $600');
    await closeByKeyboard(panel, closing);
    // Focus comes back on the frame after the panel closes, which can land after the panel has gone.
    await expect.element(chip, { timeout: 4_000 }).toHaveFocus();
  });

  it.each(CASES)('closing_with_%s_once_its_change_applies_gives_focus_to_the_composer %s', { timeout: 40_000 }, async (closing, place) => {
    const { composer, chip, panel, log } = await openFromSuggestionByKeyboard(place, 'Stop quoting on weekends');
    // Shift+Tab from Ask Claude's composer reaches "Keep my rules", then "Confirm change".
    await tabTo(log.getByRole('button', { name: 'Confirm change' }).element(), { back: true });
    await userEvent.keyboard('{Enter}');
    await expect.element(log.getByText(/^Confirmed\. Version \d+ of your rules, checked against the always-on rules\.$/), { timeout: 4_000 }).toBeVisible();
    // Quotes no longer go out on their own at weekends, so the suggestion has gone.
    await expect.element(chip, { timeout: 4_000 }).not.toBeInTheDocument();
    await expect.element(panel.getByRole('textbox', { name: 'Ask Claude' }), { timeout: 4_000 }).toHaveFocus();

    await closeByKeyboard(panel, closing);
    await expect.element(composer, { timeout: 4_000 }).toHaveFocus();
  });
});
