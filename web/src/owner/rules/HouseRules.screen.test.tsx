import { expect, it } from 'vitest';

import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;

it('Your tools gives Payments and Stripe C4 sentences with dots alone', async () => {
  const { screen } = await renderRoute(`${DESK}/rules/all`);
  await expect.element(screen.getByRole('heading', { level: 1, name: 'Your tools' })).toBeVisible();
  const payments = screen.getByRole('region', { name: 'Payments', exact: true });
  await expect.element(payments.getByText('Built in', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Claude can send payment links up to $300', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Over $300, Claude asks you first', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Claude can take agent payments up to $20 from a signed limit', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Over $20, Claude asks you first', { exact: true })).toBeVisible();
  await expect.element(payments.getByText('Any payment over $500 asks you first', { exact: true })).toBeVisible();
  const stripe = screen.getByRole('region', { name: 'Stripe', exact: true });
  await expect.element(stripe.getByText('Mock', { exact: true })).toBeVisible();
  await expect.element(stripe.getByText("Claude can show customers their own charges, once they've confirmed it's them", { exact: true })).toBeVisible();
  await expect.element(stripe.getByText('Claude asks you before any refund', { exact: true })).toBeVisible();
  expect(stripe.element().querySelectorAll('.cd-status-dot')).toHaveLength(3);
  expect(stripe.getByText('Allow', { exact: true }).elements()).toHaveLength(0);
  expect(stripe.getByText('Ask me first', { exact: true }).elements()).toHaveLength(0);
  expect(screen.container.textContent).not.toContain('Checked by the reviewer');
  expect(screen.container.textContent).not.toContain('Anything else here: ask me.');
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it('at 390, a shared card and the money cap each show in full only once across connectors', async () => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  desk.policy.cards.push({ ...base, card_id: 'shared-private', applies_to: 'effect:private_data', mode: 'never', who: 'anyone' });
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport: 'phone' });
  const documents = screen.getByRole('region', { name: 'Documents', exact: true });
  await expect.element(documents.getByText('Claude never shares private data', { exact: true })).toBeVisible();
  const shared = documents.element().querySelector('.cd-house-rules__shared');
  expect(shared?.textContent).toBe('Shared rule. Also applies to:See charges and Refund');
  expect([...shared!.querySelectorAll('[data-copy="user"]')].map((title) => title.textContent)).toEqual(['See charges', 'Refund']);
  const stripe = screen.getByRole('region', { name: 'Stripe', exact: true });
  expect(stripe.getByText('Claude never shares private data · Shared rule, as above', { exact: true }).elements()).toHaveLength(2);
  expect(screen.getByText('Any payment over $500 asks you first', { exact: true }).elements()).toHaveLength(1);
  expect(screen.getByText('Any payment over $500 asks you first · Shared rule, as above', { exact: true }).elements()).toHaveLength(2);
  const payments = screen.getByRole('region', { name: 'Payments', exact: true });
  expect(payments.element().querySelector('.cd-house-rules__shared')?.textContent)
    .toBe('Shared rule. Also applies to:Charge within a signed limit and Refund');
  expect([...payments.element().querySelectorAll('strong')].map((value) => value.textContent)).toContain('$500');
  expect(screen.container.querySelectorAll('.cd-house-rules__tool-name[data-copy="user"]')).toHaveLength(12);
  expect(screen.container.textContent).not.toMatch(/input_schema|Cedar|Checked by the reviewer/);
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});
