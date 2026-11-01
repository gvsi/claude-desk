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

it('keeps_retry_on_one_line_inside_the_failed_box_beside_2000_characters_at_390', async () => {
  await page.viewport(390, 844);
  await expect.poll(() => [window.innerWidth, window.innerHeight]).toEqual([390, 844]);
  const failed = FailedLong.args?.failed;
  const label = FailedLong.args?.label;
  if (!failed || !label) throw new Error('the long failed story must supply its words and label');
  const shortAnswer = failed.text.split(' ')[0];
  if (!shortAnswer) throw new Error('the long failed story must supply a short answer for comparison');
  const longAnswer = failed.text.replace(/\n/g, ' ').repeat(2).slice(0, 2000);
  const screen = await render(
    <div style={{ padding: 'var(--space-16)' }}>
      <Composer variant="owner" label={label} placeholder={label} onSend={() => {}} failed={{ ...failed, text: shortAnswer }} />
      <Composer variant="owner" label={label} placeholder={label} onSend={() => {}} failed={{ ...failed, text: longAnswer }} />
    </div>,
  );
  await document.fonts.ready;
  const [shortRetry, retry] = screen.getByRole('button', { name: 'Try again', exact: true }).elements();
  if (!shortRetry || !retry) throw new Error('both failed composers must render a retry button');
  const box = retry.closest<HTMLElement>('.cd-composer__box')!;
  const kept = box.querySelector<HTMLElement>('.cd-composer__kept')!;
  const buttonRect = retry.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  const labelRange = document.createRange();
  labelRange.selectNodeContents(retry.querySelector('.cd-button__label')!);
  expect(new Set([...labelRange.getClientRects()].map((rect) => Math.round(rect.top))).size).toBe(1);
  expect(shortRetry.getBoundingClientRect().height).toBe(32);
  expect(buttonRect.height).toBe(shortRetry.getBoundingClientRect().height);
  expect(buttonRect.left).toBeGreaterThanOrEqual(kept.getBoundingClientRect().right);
  expect(buttonRect.left).toBeGreaterThanOrEqual(boxRect.left);
  expect(buttonRect.right).toBeLessThanOrEqual(boxRect.right);
  expect(buttonRect.top).toBeGreaterThanOrEqual(boxRect.top);
  expect(buttonRect.bottom).toBeLessThanOrEqual(boxRect.bottom);
  expect(box.scrollWidth).toBe(box.clientWidth);
  expect(kept.textContent).toBe(longAnswer);
});

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
  expect(getComputedStyle(kept).outlineColor).toBe('rgba(250, 249, 245, 0.64)');
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
