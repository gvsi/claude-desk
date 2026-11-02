import { expect } from 'storybook/test';

import { rivera } from '../fixtures/index.ts';
import { expectComputed } from './expectComputed.ts';

/**
 * Checks that a rule row's shared line names the tools of the shared payment rule on a line of their
 * own under its words: each title its own `.cd-user-name` user-text element, the first one right after
 * the line break, so no title sits mid-line among the app's words.
 */
export async function expectSharedTitles(row: HTMLElement): Promise<void> {
  const line = row.querySelector<HTMLElement>('.cd-rule-row__shared');
  if (line === null) throw new Error('No shared line in the row');
  const titles = [...line.querySelectorAll<HTMLElement>('[data-copy="user"]')];
  await expect(titles.map((el) => el.textContent)).toEqual(rivera.sharedChargeShared.titles);
  await expect(line.querySelector('br + [data-copy="user"]')).toBe(titles[0]);
  for (const title of titles) {
    await expect(title).toHaveClass('cd-user-name');
    expectComputed(title, { unicodeBidi: 'isolate', fontWeight: '520' });
  }
}
