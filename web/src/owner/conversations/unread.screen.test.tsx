import { QueryClient } from '@tanstack/react-query';
import { expect, it, onTestFinished, vi } from 'vitest';

import { renderRoute } from '../../test/renderRoute.tsx';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';

const LIST = `/app/${RIVERA.deskId}/conversations`;
const HELD = 'ses-visitor-web';
const unreadRows = () => [...document.querySelectorAll('.cd-conversation-item--unread')];
const conversationPill = () => document.querySelector('.cd-sidebar a[href="' + LIST + '"] .cd-count-pill');
const posts = () => mockStore.requests.filter((request) => request.key === 'markConversationRead');
const heldChat = () => mockStore.world.sessions.get(HELD)!;
const newest = () => Math.max(...heldChat().items.map((item) => item.n));

it('seeds exactly the held visitor and visiting agent unread, with their sidebar count', async () => {
  const { screen } = await renderRoute(LIST);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Conversations' })).toBeVisible();
  await expect.poll(() => unreadRows().map((row) => row.getAttribute('href'))).toEqual([
    `${LIST}/${HELD}`, `${LIST}/ses-alex-agent`,
  ]);
  expect(unreadRows()[0]?.textContent).toContain('How much to clear a clogged drain? Can I get 15% off if I pay cash?');
  expect(unreadRows()[0]?.textContent).toContain('Needs you');
  expect(unreadRows()[1]?.textContent).toContain("Alex Kim's assistant");
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('2 unread');
});

it('shows the unread count in the phone menu and marks the opened phone transcript read', async () => {
  const { screen } = await renderRoute(LIST, { viewport: 'phone' });
  await expect.poll(() => unreadRows().length).toBe(2);
  await screen.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect.element(screen.getByRole('dialog', { name: 'Menu' })).toBeVisible();
  await expect.element(screen.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Conversations 2 unread' }).getByRole('img', { name: '2 unread' })).toBeVisible();
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('2 unread');
  await screen.getByRole('button', { name: 'Close menu' }).click();
  await screen.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name: /^Unread: Visitor/ }).click();
  await expect.element(screen.getByRole('log')).toBeVisible();
  await expect.poll(() => posts().map((post) => post.body)).toEqual([{ through: newest() }]);
  await screen.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect.element(screen.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Conversations 1 unread' }).getByRole('img', { name: '1 unread' })).toBeVisible();
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('1 unread');
});

it('waits for a visible tab and skips the unchanged cursor on visibility changes', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  onTestFinished(() => visibility.mockRestore());
  const { screen } = await renderRoute(`${LIST}/${HELD}`, { strict: true });
  await expect.element(screen.getByRole('log')).toBeInTheDocument();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(posts()).toHaveLength(0);
  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await expect.poll(() => posts().map((post) => post.body)).toEqual([{ through: newest() }]);
  visibility.mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  mockStore.world.visitorText(heldChat(), 'A message while hidden.');
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(posts()).toHaveLength(1);
  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await expect.element(screen.getByRole('log').getByText('A message while hidden.', { exact: true })).toBeVisible();
  await expect.poll(() => posts().at(-1)?.body).toEqual({ through: newest() });
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(posts()).toHaveLength(2);
});

it('keeps a failed marker silent and retries it when the conversation opens again', async () => {
  mockStore.inject({ route: 'markConversationRead', status: 503 });
  const { screen, router } = await renderRoute(`${LIST}/${HELD}`);
  await expect.element(screen.getByRole('log')).toBeVisible();
  await expect.poll(() => posts().length).toBe(1);
  const reads = mockStore.requests.filter((request) => request.key === 'conversation').length;
  await expect.poll(() => mockStore.requests.filter((request) => request.key === 'conversation').length).toBeGreaterThan(reads + 1);
  expect(posts()).toHaveLength(1);
  expect(screen.getByRole('alert').elements()).toHaveLength(0);
  expect(heldChat().readThrough).toBe(0);
  await router.navigate(LIST);
  await expect.poll(() => screen.getByRole('log').elements().length).toBe(0);
  await expect.poll(() => unreadRows().length).toBe(2);
  await router.navigate(`${LIST}/${HELD}`);
  await expect.poll(() => posts().length).toBe(2);
  await expect.poll(() => unreadRows().length).toBe(1);
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('1 unread');
});

it('marks the drawn cursor once, follows new rows while open, and leaves closed chats unread again', async () => {
  const { screen, router } = await renderRoute(LIST, { strict: true });
  await expect.poll(() => unreadRows().length).toBe(2);
  const firstCursor = newest();
  await router.navigate(`${LIST}/${HELD}`);
  await expect.element(screen.getByRole('log')).toBeVisible();
  await expect.poll(() => posts().map((post) => post.body)).toEqual([{ through: newest() }]);
  await expect.poll(() => unreadRows().length).toBe(1);
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('1 unread');
  const reads = mockStore.requests.filter((request) => request.key === 'conversation').length;
  await expect.poll(() => mockStore.requests.filter((request) => request.key === 'conversation').length).toBeGreaterThan(reads + 1);
  expect(posts()).toHaveLength(1);

  mockStore.world.visitorText(heldChat(), 'Can you come tomorrow instead?');
  await expect.element(screen.getByRole('log').getByText('Can you come tomorrow instead?', { exact: true })).toBeVisible();
  await expect.poll(() => posts().map((post) => post.body)).toEqual([
    { through: firstCursor }, { through: newest() },
  ]);

  await router.navigate(LIST);
  mockStore.world.visitorText(heldChat(), 'Friday also works.');
  await expect.poll(() => unreadRows().length).toBe(2);
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('2 unread');
  expect(posts()).toHaveLength(2);

  await router.navigate(`${LIST}/${HELD}`);
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('1 unread');
  await router.navigate(`${LIST}/ses-alex-agent`);
  await expect.poll(() => unreadRows().length).toBe(0);
  await expect.poll(conversationPill).toBeNull();
});

it('follows a later list read over a newer Desks count, even when the number is the same', async () => {
  // The list said 2, then a fresh Desks read said 1 (the held chat read meanwhile), then the visitor wrote again and
  // the list said 2 once more: the sidebar shows the list's newer 2, not the Desks read's 1.
  const mounted = vi.spyOn(QueryClient.prototype, 'mount');
  onTestFinished(() => mounted.mockRestore());
  await renderRoute(LIST, { pollScale: 100 });
  const client = mounted.mock.contexts.at(-1) as QueryClient;
  await expect.poll(() => unreadRows().length).toBe(2);
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('2 unread');
  heldChat().readThrough = newest();
  await client.refetchQueries({ queryKey: ['desks'] });
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('1 unread');
  mockStore.world.visitorText(heldChat(), 'One more question after that.');
  await client.refetchQueries({ queryKey: ['conversations', RIVERA.deskId] });
  await expect.poll(() => unreadRows().length).toBe(2);
  await expect.poll(() => conversationPill()?.getAttribute('aria-label')).toBe('2 unread');
});
