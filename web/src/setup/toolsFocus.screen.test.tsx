import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';

import { newIdempotencyKey } from '../api/http.ts';
import type { SetupState } from '../api/views.ts';
import { SETUP_QUESTIONS } from '../mocks/setup.ts';
import { mockStore } from '../mocks/store.ts';
import { renderRoute } from '../test/renderRoute.tsx';
import { expectNoHorizontalScroll } from '../test/screen.ts';

/** Reach each control with Tab and activate it with Enter. */
async function press(button: Element): Promise<void> {
  for (let i = 0; i < 40 && document.activeElement !== button; i += 1) await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(button);
  await userEvent.keyboard('{Enter}');
}

it.each([
  ['desktop', 'Payments', 'Add'], ['phone', 'Payments', 'Add'],
  ['desktop', 'Stripe', 'Connect'], ['phone', 'Stripe', 'Connect'],
] as const)('tools_keep_keyboard_focus_on_%s_when_owners_%s_%s', async (viewport, name, verb) => {
  const started = await mockStore.dispatch('startSetup', { body: {
    description: "Turner Plumbing. I'm Mike, a plumber in Oakland.",
    timezone: 'America/Los_Angeles', idempotency_key: newIdempotencyKey(),
  } });
  if ('network' in started || started.status !== 201) throw new Error('the mock starts setup');
  const state = started.body as SetupState;
  const params = { id: state.interview_id };
  await mockStore.dispatch('setupConsent', { params, body: { allow: true } });
  for (const question of SETUP_QUESTIONS) await mockStore.dispatch('setupAnswer', { params, body: {
    question: question.key, text: question.key === 'money_limit' ? '$500 is fine.' : 'Yes, that works.',
  } });
  const desk = mockStore.world.desk(state.desk_id);
  if (!desk) throw new Error('setup has a Desk');
  // A long covering rule keeps the review scrollable even after the list has been replaced.
  desk.policy.cards.push({
    card_id: 'long-tool-review', applies_to: name === 'Payments' ? 'native.payment_link' : 'payments.create_refund',
    mode: 'ask', who: 'anyone', reason: 'Ask me before taking a payment for a new customer. '.repeat(20),
  });
  const { screen } = await renderRoute(`/app/setup/${state.interview_id}`, { viewport });
  const opening = screen.getByRole('button', { name: `${verb} ${name}`, exact: true });
  await expect.element(opening).toBeVisible();
  if (viewport === 'phone') {
    (opening.element() as HTMLElement).focus({ preventScroll: true });
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    expect(window.scrollY).toBeGreaterThan(0);
  }
  await press(opening.element());

  const heading = screen.getByRole('heading', { level: 1, name: new RegExp(`^Review what Claude could do with ${name}`) });
  await expect.element(heading).toHaveFocus();
  expect(window.scrollY).toBe(0);
  expect(heading.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(heading.element().tabIndex).toBe(-1);
  expect(getComputedStyle(heading.element()).boxShadow).toBe('none');
  await press(screen.getByRole('button', { name: 'Cancel', exact: true }).element());
  await expect.element(opening).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect.element(heading).toHaveFocus();

  if (name === 'Stripe') {
    await press(screen.getByRole('button', { name: 'Connect Stripe', exact: true }).element());
    await expect.element(screen.getByRole('button', { name: 'Turn it on', exact: true })).toBeEnabled();
  }
  const turnOn = screen.getByRole('button', { name: 'Turn it on', exact: true });
  if (viewport === 'phone') {
    (turnOn.element() as HTMLElement).focus({ preventScroll: true });
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    expect(window.scrollY).toBeGreaterThan(0);
  }
  await press(turnOn.element());
  const confirmHeading = screen.getByRole('heading', { level: 1, name: `Turn on ${name}`, exact: true });
  await expect.element(confirmHeading).toHaveFocus();
  expect(window.scrollY).toBe(0);
  expect(confirmHeading.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
  expect(confirmHeading.element().tabIndex).toBe(-1);
  expect(getComputedStyle(confirmHeading.element()).boxShadow).toBe('none');

  // Back returns to the list's opener, including Stripe's new Review button after connecting.
  await press(screen.getByRole('button', { name: 'Back', exact: true }).element());
  const returning = screen.getByRole('button', { name: `${name === 'Stripe' ? 'Review' : verb} ${name}`, exact: true });
  await expect.element(returning).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect.element(heading).toHaveFocus();
  await press(screen.getByRole('button', { name: 'Turn it on', exact: true }).element());
  await expect.element(confirmHeading).toHaveFocus();
  await press(screen.getByRole('button', { name: 'Confirm and turn on', exact: true }).element());

  const row = screen.getByRole('listitem').filter({ hasText: new RegExp(`^${name}`) });
  await expect.element(row.getByText('On', { exact: true })).toBeVisible();
  await expect.element(row).toHaveFocus();
  expect(row.element().tabIndex).toBe(-1);
  expect(getComputedStyle(row.element()).boxShadow).toBe('none');
  await expectNoHorizontalScroll();
});
