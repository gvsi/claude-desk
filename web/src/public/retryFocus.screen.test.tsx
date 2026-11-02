import { expect, it } from 'vitest';
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
