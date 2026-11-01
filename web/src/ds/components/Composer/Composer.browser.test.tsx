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

it('send_held_keeps_typing_and_focus_but_holds_send_and_enter_until_it_lifts', async () => {
  const sent: string[] = [];
  const props = { variant: 'owner', label: 'Ask Claude', placeholder: 'Ask Claude', onSend: (text: string) => sent.push(text) } as const;
  const screen = await render(<Composer {...props} />);
  const input = screen.getByRole('textbox', { name: 'Ask Claude' });
  const send = screen.getByRole('button', { name: 'Send' });
  const box = input.element() as HTMLTextAreaElement;
  await input.click();
  // A reply starts coming in while the box has focus: it keeps it, and typing works.
  await screen.rerender(<Composer {...props} sendHeld />);
  await expect.element(input).toBeEnabled();
  expect(document.activeElement).toBe(box);
  await userEvent.keyboard('Is $500 fine?');
  expect(box.value).toBe('Is $500 fine?');
  // Only Send and Enter wait: nothing is sent, and the words stay.
  await expect.element(send).toBeDisabled();
  await userEvent.keyboard('{Enter}');
  expect(sent).toEqual([]);
  expect(box.value).toBe('Is $500 fine?');
  // Shift+Enter still starts a new line.
  await userEvent.keyboard('{Shift>}{Enter}{/Shift}Or less?');
  expect(box.value).toBe('Is $500 fine?\nOr less?');
  expect(document.activeElement).toBe(box);
  // The reply has come in: focus stays, and the words typed meanwhile send.
  await screen.rerender(<Composer {...props} />);
  expect(document.activeElement).toBe(box);
  expect(box.value).toBe('Is $500 fine?\nOr less?');
  await expect.element(send).toBeEnabled();
  await userEvent.keyboard('{Enter}');
  expect(sent).toEqual(['Is $500 fine?\nOr less?']);
  expect(box.value).toBe('');
});

/** Where a press on `variant`'s box lands away from its controls: the owner's tools row, or the single row's padding. */
async function clickBoxSurface(variant: 'owner' | 'visitor' | 'whisper', input: HTMLElement): Promise<void> {
  const box = input.closest<HTMLElement>('.cd-composer__box')!;
  if (variant === 'owner') {
    // The middle of the row under the text, where no control is: the empty part Send leaves.
    await userEvent.click(box.querySelector<HTMLElement>('.cd-composer__tools')!);
    return;
  }
  await userEvent.click(box, { position: { x: 6, y: Math.round(box.getBoundingClientRect().height / 2) } });
}

for (const variant of ['owner', 'visitor', 'whisper'] as const) {
  it(`a_click_on_the_${variant}_box_away_from_its_controls_puts_the_caret_at_the_end_of_the_text`, async () => {
    const sent: string[] = [];
    const screen = await render(
      <div>
        <button type="button">Elsewhere</button>
        <Composer variant={variant} label="Message" placeholder="Message" onSend={(text) => sent.push(text)} />
      </div>,
    );
    const input = screen.getByRole('textbox', { name: 'Message' });
    const box = input.element() as HTMLTextAreaElement;
    await input.click();
    await userEvent.keyboard('Thursday works');
    await screen.getByRole('button', { name: 'Elsewhere' }).click();
    expect(document.activeElement).not.toBe(box);
    await clickBoxSurface(variant, box);
    expect(document.activeElement).toBe(box);
    expect(box.selectionStart).toBe('Thursday works'.length);
    expect(box.selectionEnd).toBe('Thursday works'.length);
    // Send keeps its own click: the words go, and the box clears.
    await screen.getByRole('button', { name: variant === 'whisper' ? 'Send whisper' : 'Send' }).click();
    expect(sent).toEqual(['Thursday works']);
    expect(box.value).toBe('');
  });
}

it('a_click_on_the_box_keeps_a_selection_in_the_text_and_does_nothing_while_disabled', async () => {
  const props = { variant: 'owner', label: 'Message', placeholder: 'Message', onSend: () => {} } as const;
  const screen = await render(<Composer {...props} />);
  const input = screen.getByRole('textbox', { name: 'Message' });
  const box = input.element() as HTMLTextAreaElement;
  await input.click();
  await userEvent.keyboard('Thursday works');
  box.setSelectionRange(0, 8);
  await clickBoxSurface('owner', box);
  expect(document.activeElement).toBe(box);
  expect([box.selectionStart, box.selectionEnd]).toEqual([0, 8]);
  box.blur();
  await screen.rerender(<Composer {...props} disabled />);
  await clickBoxSurface('owner', box);
  expect(document.activeElement).not.toBe(box);
});

it('a_send_tried_again_and_held_leaves_focus_to_the_screen_until_its_reply_has_come_in', async () => {
  const props = { variant: 'owner', label: 'Your answer', placeholder: 'Your answer', onSend: () => {} } as const;
  const failed = { text: 'Both, about evenly', line: 'I couldn’t answer just now. Your answer is still here; try again.', onRetry: () => {} };
  const screen = await render(<Composer {...props} failed={failed} />);
  const retry = screen.getByRole('button', { name: 'Try again', exact: true });
  await retry.click();
  await expect.element(retry).toHaveFocus();
  // Sent again, the box comes back while the reply is on its way: it takes no focus of its own, so a
  // phone's keyboard doesn't open, and the screen places focus once the reply has come in.
  await screen.rerender(<Composer {...props} sendHeld />);
  const box = screen.getByRole('textbox', { name: 'Your answer' });
  await expect.element(box).toBeEnabled();
  expect(document.activeElement).not.toBe(box.element());
});

it('a_click_on_the_box_focuses_the_text_inside_an_ancestor_that_takes_focus', async () => {
  // An owner page's main region, or Ask Claude's sheet, takes focus itself (tabIndex -1): a click on
  // the box's empty row still puts the caret in the text.
  const screen = await render(
    <div tabIndex={-1}>
      <Composer variant="owner" label="Message" placeholder="Message" onSend={() => {}} />
    </div>,
  );
  const input = screen.getByRole('textbox', { name: 'Message' });
  const box = input.element() as HTMLTextAreaElement;
  await input.click();
  await userEvent.keyboard('Thursday works');
  box.blur();
  await clickBoxSurface('owner', box);
  expect(document.activeElement).toBe(box);
  expect(box.selectionStart).toBe('Thursday works'.length);
});
