import { expect } from 'storybook/test';

import { expectComputed } from './expectComputed.ts';

/**
 * Checks that `name`, a name someone chose (a visitor's, an agent's), is set off in `line` as user
 * text: one `.cd-user-name` element marked `data-copy="user"`, isolated so its direction marks
 * can't reorder the words around it, in `text-primary` at weight 520 so it reads apart from the
 * interface's words, and first in its line, so no system sentence runs into it. Returns it.
 */
export async function expectSetOffName(line: HTMLElement, name: string): Promise<HTMLElement> {
  const found = [...line.querySelectorAll<HTMLElement>('.cd-user-name')].filter((el) => el.textContent === name);
  if (found.length !== 1) {
    throw new Error(`expected the name "${name}" set off once in "${line.textContent ?? ''}", found ${found.length}`);
  }
  const el = found[0] as HTMLElement;
  await expect(el).toHaveAttribute('data-copy', 'user');
  expectComputed(el, { unicodeBidi: 'isolate', color: 'rgba(250, 249, 245, 0.92)', fontWeight: '520' });
  const before = line.ownerDocument.createRange();
  before.setStart(line, 0);
  before.setEndBefore(el);
  await expect(before.toString().trim(), `words before "${name}"`).toBe('');
  return el;
}
