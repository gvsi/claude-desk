import { expect, it, onTestFinished, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';

async function failedSend() {
  const view = await renderRoute(`/d/${RIVERA.slug}`);
  const box = view.screen.getByRole('textbox', { name: 'Message Turner Plumbing' });
  await expect.element(box).toBeEnabled();
  mockStore.inject({ route: 'sendMessage', status: 'network' });
  await box.fill('How much is drain clearing?');
  await userEvent.keyboard('{Enter}');
  const retry = view.screen.getByRole('alert').getByRole('button', { name: 'Try again' });
  await expect.element(retry).toBeVisible();
  await userEvent.tab({ shift: true });
  await expect.element(retry).toHaveFocus();
  return { ...view, box, retry };
}

it('returns keyboard focus to the composer after a successful retry', async () => {
  const { screen, box, retry } = await failedSend();
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByRole('article', { name: 'Quote', exact: true })).toBeVisible();
  await expect.element(retry).not.toBeInTheDocument();
  await expect.element(box).toHaveFocus();
});

it('returns keyboard focus to the new retry action when the send fails again', async () => {
  const { retry } = await failedSend();
  const previous = retry.element();
  mockStore.inject({ route: 'sendMessage', status: 'network' });
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => mockStore.requests.filter((r) => r.key === 'sendMessage').length).toBe(2);
  await expect.poll(() => retry.query() !== null && retry.query() !== previous).toBe(true);
  await expect.element(retry).toHaveFocus();
});


it('waits for a failed follow-up read before restoring focus to the new retry action', async () => {
  const { retry } = await failedSend();
  const previous = retry.element();
  const reads = mockStore.requests.filter((r) => r.key === 'visitorSession').length;
  mockStore.inject({ route: 'sendMessage', status: 'network' });
  mockStore.inject({ route: 'visitorSession', status: 'network' });
  await userEvent.keyboard('{Enter}');
  await expect.poll(() => retry.query() !== null && retry.query() !== previous, { timeout: 5_000 }).toBe(true);
  expect(mockStore.requests.filter((r) => r.key === 'visitorSession').length).toBeGreaterThanOrEqual(reads + 2);
  await expect.element(retry).toHaveFocus();
});

it('returns mouse focus to the composer after a successful retry', async () => {
  const { screen, box, retry } = await failedSend();
  await box.click();
  await retry.click();
  await expect.element(screen.getByRole('article', { name: 'Quote', exact: true })).toBeVisible();
  await expect.element(box).toHaveFocus();
});

it('does not focus the composer after a coarse pointer retry', async () => {
  const { screen, box, retry } = await failedSend();
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => query === '(pointer: coarse)'
    ? { ...matchMedia(query), matches: true }
    : matchMedia(query));
  onTestFinished(() => { vi.restoreAllMocks(); });
  await box.click();
  await retry.click();
  await expect.element(screen.getByRole('article', { name: 'Quote', exact: true })).toBeVisible();
  await expect.element(box).not.toHaveFocus();
});
