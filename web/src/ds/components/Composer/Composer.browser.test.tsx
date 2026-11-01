import axe from 'axe-core';
import { expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { Composer } from './Composer.tsx';
import { FailedLong } from './Composer.stories.tsx';

/** Native keyboard scrolling animates even with reduced motion; keyup isn't its completion. */
async function scrollByKey(element: HTMLElement, key: '{ArrowDown}' | '{End}') {
  const finished = new Promise<void>((resolve) => element.addEventListener('scrollend', () => resolve(), { once: true }));
  await userEvent.keyboard(key);
  await finished;
}

it('long_failed_answer_story_is_keyboard_scrollable_and_axe_clean_at_390', async () => {
  await page.viewport(390, 844);
  await expect.poll(() => [window.innerWidth, window.innerHeight]).toEqual([390, 844]);
  const failed = FailedLong.args?.failed;
  const label = FailedLong.args?.label;
  if (!failed || !label) throw new Error('the long failed story must supply its words and label');
  const screen = await render(<Composer variant="owner" label={label} placeholder={label} onSend={() => {}} failed={failed} />);
  const region = screen.getByRole('region', { name: label });
  const kept = region.element() as HTMLElement;
  await document.fonts.ready;
  expect(kept.clientHeight).toBe(6 * Number.parseFloat(getComputedStyle(kept).lineHeight));
  expect(kept.scrollHeight).toBeGreaterThan(kept.clientHeight);
  await userEvent.keyboard('{Tab}');
  await expect.element(region).toHaveFocus();
  expect(getComputedStyle(kept).outlineColor).toBe('rgb(126, 174, 218)');
  expect(getComputedStyle(kept).outlineWidth).toBe('2px');
  expect(getComputedStyle(kept).outlineOffset).toBe('2px');
  const before = kept.scrollTop;
  await scrollByKey(kept, '{ArrowDown}');
  await expect.poll(() => kept.scrollTop).toBeGreaterThan(before);
  await scrollByKey(kept, '{End}');
  await expect.poll(() => kept.scrollHeight - kept.clientHeight - kept.scrollTop).toBeLessThanOrEqual(1);
  await userEvent.keyboard('{Tab}');
  const retry = screen.getByRole('button', { name: 'Try again', exact: true });
  await expect.element(retry).toHaveFocus();
  expect(retry.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
  const result = await axe.run(screen.container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
  expect(result.violations).toEqual([]);
});
