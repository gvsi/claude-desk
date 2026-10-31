/**
 * The page tests' own board helpers, on a page of three plain buttons, in a real browser: where
 * Tab starts matters, and only a browser moves focus as a person's Tab does.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-react';

import { expectTabOrderFromTop } from './boards.ts';

async function threeButtons(): Promise<[HTMLElement, HTMLElement, HTMLElement]> {
  const screen = await render(
    <main>
      <button type="button">First</button>
      <button type="button">Second</button>
      <button type="button">Third</button>
    </main>,
  );
  const button = (name: string) => screen.getByRole('button', { name }).element() as HTMLElement;
  return [button('First'), button('Second'), button('Third')];
}

describe('expectTabOrderFromTop', () => {
  it('starts_at_the_top_of_the_page_whatever_had_focus', async () => {
    const [first, second, third] = await threeButtons();
    // Focus left on a later control, as an earlier check or an earlier test in the file can
    // leave it: the next Tab would start from there.
    second.focus();
    await expectTabOrderFromTop([first, second, third]);
  });

  it('leaves_the_page_as_it_found_it', async () => {
    const stops = await threeButtons();
    const before = document.body.innerHTML;
    await expectTabOrderFromTop(stops);
    expect(document.body.innerHTML).toBe(before);
  });

  it('leaves_the_page_as_it_found_it_when_the_order_is_wrong', async () => {
    const [first, , third] = await threeButtons();
    const before = document.body.innerHTML;
    await expect(expectTabOrderFromTop([third, first])).rejects.toThrow();
    expect(document.body.innerHTML).toBe(before);
  });
});
