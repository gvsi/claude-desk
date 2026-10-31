/**
 * The setup interview's bar (`SetupFrame` in `parts.tsx`) at the widths its board doesn't draw. A
 * phone's top bar carries no lockup badge (owner, 2026-10-30), so below the About pages' compact
 * breakpoint the bar shows the bell and "Claude Desk" alone, and "Save and exit" keeps its one line
 * inside the bar; from that breakpoint up the badge is back.
 */
import { composeStory } from '@storybook/react-vite';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';

import meta, { Board } from './SetupSituations.stories.tsx';

const story = composeStory({ ...Board, play: undefined }, meta, undefined, 'Board');

afterEach(async () => {
  await page.viewport(1280, 820);
});

/** The board's bar at a window of `width` × `height`; each run replaces the last one's render. */
async function barAt(width: number, height: number): Promise<HTMLElement> {
  await page.viewport(width, height);
  await story.run();
  const bar = document.querySelector<HTMLElement>('.board-setup__bar');
  if (!bar) throw new Error(`at ${width}: the setup bar did not render`);
  return bar;
}

/** How many lines `el`'s text takes: its text's boxes, one row per distinct top. */
function lines(el: Element): number {
  const range = document.createRange();
  range.selectNodeContents(el);
  return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
}

it('setup_bar_on_a_phone_drops_the_badge_and_keeps_save_and_exit_on_one_line', async () => {
  for (const [width, height] of [
    [390, 844],
    [320, 640],
  ] as const) {
    const where = `at ${width}`;
    const bar = await barAt(width, height);
    expect(bar.querySelector('.cd-wordmark')?.textContent, where).toBe('Claude Desk');
    expect(bar.querySelector('.cd-pill'), where).toBeNull();
    const button = [...bar.querySelectorAll('button')].find((el) => el.textContent === 'Save and exit');
    const label = button?.querySelector('.cd-button__label');
    if (!button || !label) throw new Error(`${where}: no "Save and exit"`);
    expect(lines(label), where).toBe(1);
    const [box, frame] = [button.getBoundingClientRect(), bar.getBoundingClientRect()];
    expect(frame.height, where).toBe(65);
    expect(box.height, where).toBeLessThanOrEqual(65);
    expect(box.top >= frame.top && box.bottom <= frame.bottom, `${where}: the button stays inside the bar`).toBe(true);
    expect(box.right, where).toBeLessThanOrEqual(width - 16);
    expect(document.documentElement.scrollWidth, where).toBeLessThanOrEqual(width);
  }
});

it('setup_bar_keeps_the_badge_from_the_about_bars_breakpoint_up', async () => {
  // The About pages turn compact below 1100 px; so does this bar.
  expect((await barAt(1099, 900)).querySelector('.cd-pill')).toBeNull();
  for (const [width, height] of [
    [1100, 900],
    [1512, 982],
  ] as const) {
    const bar = await barAt(width, height);
    expect(bar.querySelector('.cd-wordmark')?.textContent, `at ${width}`).toBe('Claude DeskPreview');
    expect(bar.querySelector('.cd-pill')?.textContent, `at ${width}`).toBe('Preview');
  }
});
