import { describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { request } from '../api/http.ts';
import { coarsePointer } from '../ds/test/touch.ts';
import { RIVERA } from '../mocks/seed.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute, type Viewport } from '../test/renderRoute.tsx';

async function heldRequest(viewport: Viewport) {
  const view = await renderRoute(`/d/${RIVERA.slug}`, { viewport, strict: true });
  const box = view.screen.getByRole('textbox', { name: 'Message Turner Plumbing' });
  await expect.element(box).toBeEnabled();
  await box.fill('Can I get 15% off a drain clearing?');
  await userEvent.keyboard('{Enter}');
  const cancel = view.screen.getByRole('button', { name: 'Cancel this request' });
  await expect.element(cancel).toBeVisible();
  await expect.poll(() => document.querySelector('.cd-claude-message--revealing, .cd-claude-message--following')).toBeNull();
  const held = mockStore.visitorSession(RIVERA.slug)?.events.find(({ ev }) => ev.type === 'held')?.ev;
  if (held?.type !== 'held') throw new Error('the discount was held');
  return { ...view, box, cancel, decisionId: held.decision_id };
}

describe.each(['desktop', 'phone'] as const)('request focus at %s size', (viewport) => {
  it('returns keyboard focus to the composer after the visitor cancels', async () => {
    if (viewport === 'phone') await coarsePointer();
    const { box, cancel } = await heldRequest(viewport);
    await userEvent.tab({ shift: true });
    await expect.element(cancel).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect.element(cancel).not.toBeInTheDocument();
    await expect.element(box).toHaveFocus();
  });

  it('returns focus to the composer after an own cancel whose mouse click leaves focus on the body', async () => {
    const { box, cancel } = await heldRequest(viewport);
    (box.element() as HTMLElement).blur();
    // Safari and Firefox mouse clicks do not focus a button.
    cancel.element().addEventListener('mousedown', (event) => event.preventDefault(), { once: true });
    cancel.element().addEventListener('click', () => expect(document.activeElement).toBe(document.body), { once: true });
    await cancel.click();
    await expect.element(cancel).not.toBeInTheDocument();
    await expect.element(box).toHaveFocus();
  });

  it.each(['allow_once', 'deny_once'] as const)('returns keyboard focus to the composer after %s', async (answer) => {
    if (viewport === 'phone') await coarsePointer();
    const { box, cancel, decisionId } = await heldRequest(viewport);
    await box.fill('An unsent draft');
    await userEvent.tab({ shift: true });
    await expect.element(cancel).toHaveFocus();
    await request('answer', { params: { decision_id: decisionId }, body: { answer } });
    await expect.element(cancel).not.toBeInTheDocument();
    await expect.element(box).toHaveFocus();
    await expect.element(box).toHaveValue('An unsent draft');
  });

  it('keeps focus elsewhere when the visitor leaves the cancel before the owner answers', async () => {
    const { screen, box, cancel, decisionId } = await heldRequest(viewport);
    await userEvent.tab({ shift: true });
    await expect.element(cancel).toHaveFocus();
    const ask = screen.getByRole('button', { name: 'Ask for Mike Turner' });
    (ask.element() as HTMLElement).focus();
    await expect.element(ask).toHaveFocus();
    await request('answer', { params: { decision_id: decisionId }, body: { answer: 'deny_once' } });
    await expect.element(cancel).not.toBeInTheDocument();
    await expect.element(ask).toHaveFocus();
    await expect.element(box).not.toHaveFocus();
  });
});

it('returns focus to the composer after the visitor cancels with a coarse pointer', async () => {
  await coarsePointer();
  const { box, cancel } = await heldRequest('phone');
  await cancel.click();
  await expect.element(cancel).not.toBeInTheDocument();
  await expect.element(box).toHaveFocus();
});

it.each(['desktop', 'phone'] as const)('keeps focus on Start a new chat after cancellation ends the chat and the owner answers at %s size', async (viewport) => {
  if (viewport === 'phone') await coarsePointer();
  const { screen, box, cancel, decisionId } = await heldRequest(viewport);
  await userEvent.tab({ shift: true });
  await expect.element(cancel).toHaveFocus();
  mockStore.inject({ route: 'cancelRequest', status: 401 });
  await userEvent.keyboard('{Enter}');
  await expect.element(cancel).not.toBeInTheDocument();
  await expect.element(box).toBeDisabled();
  const start = screen.getByRole('button', { name: 'Start a new chat' });
  await expect.element(start).toHaveFocus();
  await request('answer', { params: { decision_id: decisionId }, body: { answer: 'deny_once' } });
  await expect.element(screen.getByText('Mike Turner decided not to go ahead', { exact: true })).toBeVisible();
  await expect.element(start).toHaveFocus();
  await expect.element(box).not.toHaveFocus();
});

it.each(['allow_once', 'deny_once'] as const)('focuses the outcome after a touch visitor views the request and the owner answers %s', async (answer) => {
  await coarsePointer();
  const { screen, box, cancel, decisionId } = await heldRequest('phone');
  for (const text of ['How much is drain clearing?', 'Can someone come Tuesday?', 'Is that the regular price?']) {
    const before = mockStore.visitorSession(RIVERA.slug)?.events.length ?? 0;
    await box.fill(text);
    await expect.element(screen.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => {
      const events = mockStore.visitorSession(RIVERA.slug)?.events ?? [];
      return events.length > before && events.at(-1)?.ev.type === 'turn_end';
    }).toBe(true);
    await expect.poll(() => document.querySelector('.cd-claude-message--revealing, .cd-claude-message--following')).toBeNull();
  }
  await screen.getByRole('button', { name: 'View request' }).click();
  await expect.element(cancel).toHaveFocus();
  expect(cancel.element().matches(':focus-visible')).toBe(false);
  await request('answer', { params: { decision_id: decisionId }, body: { answer } });
  await expect.element(cancel).not.toBeInTheDocument();
  const line = answer === 'allow_once' ? 'Mike Turner approved this' : 'Mike Turner decided not to go ahead';
  await expect.poll(() => document.activeElement?.textContent?.trim()).toBe(line);
  expect(document.activeElement?.classList.contains('cd-margin-receipt')).toBe(true);
  await expect.element(box).not.toHaveFocus();
});
