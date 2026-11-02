import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';

import { ConversationListItem } from './ConversationListItem.tsx';

it('a read row has the shared left column, without unread ink, dot or spoken prefix', async () => {
  const screen = await render(<ConversationListItem name="Visitor" time="10:58 am" href="#chat" quote="Hello." />);
  try {
    const row = screen.getByRole('link', { name: 'Visitor 10:58 am “Hello.”' }).element();
    expect(row.classList.contains('cd-conversation-item--unread')).toBe(false);
    expect(row.querySelector('.cd-conversation-item__unread-dot')).toBeNull();
    expect(row.querySelector('.cd-sr-only')).toBeNull();
    expect(getComputedStyle(row).paddingLeft).toBe('26px');
    expect(getComputedStyle(row).backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(row.querySelector('.cd-conversation-item__name')!).fontWeight).toBe('420');
  } finally {
    await screen.unmount();
  }
});

it.each([false, true])('an unread row deepens on real hover, including while current=%s', async (current) => {
  const screen = await render(<ConversationListItem name="Visitor" time="10:58 am" href="#chat" unread current={current} />);
  try {
    const row = screen.getByRole('link', { name: 'Unread: Visitor 10:58 am' }).element();
    expect(row.classList.contains('cd-conversation-item--unread')).toBe(true);
    expect(row.querySelector('.cd-conversation-item__unread-dot')?.getAttribute('aria-hidden')).toBe('true');
    expect(row.querySelector('.cd-sr-only')?.textContent).toBe('Unread: ');
    expect(getComputedStyle(row).paddingLeft).toBe('26px');
    expect(getComputedStyle(row).backgroundColor).toBe('rgba(250, 249, 245, 0.06)');
    await userEvent.hover(row);
    expect(row.matches(':hover')).toBe(true);
    expect(getComputedStyle(row).backgroundColor).toBe('rgba(250, 249, 245, 0.15)');
  } finally {
    await screen.unmount();
  }
});
