import { expect, it } from 'vitest';

import type { RuleCard } from '../../api/contracts.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const DESK = `/app/${RIVERA.deskId}`;

it('an Allow private-data rule keeps its verified record-owner scope', async () => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  desk.policy.cards = [{ ...base, card_id: 'shared-owner', applies_to: 'effect:private_data', mode: 'auto', who: 'record_owner' }];
  const { screen } = await renderRoute(`${DESK}/rules/all`);
  const stripe = screen.getByRole('region', { name: 'Stripe', exact: true });
  await expect.element(stripe.getByText("Claude can share private data, once they've confirmed it's them", { exact: true })).toBeVisible();
  const rows = screen.container.querySelectorAll('[data-rule-id="shared-owner"]');
  expect(rows).toHaveLength(1);
  for (const row of rows) {
    const meta = row.querySelector('.cd-rule-sentence__meta');
    expect(meta?.textContent).toBe("The record's owner, verified");
    expect(meta?.classList.contains('cd-type-meta')).toBe(true);
  }
  expectNoHorizontalScroll();
});

it.each(['desktop', 'phone'] as const)('at %s, every outcome preserves each audience without adding an Anyone line', async (viewport) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  const scopes: { who: RuleCard['who']; text: string | null }[] = [
    { who: 'anyone', text: null },
    { who: 'verified', text: 'Verified customers' },
    { who: 'record_owner', text: "The record's owner, verified" },
    { who: 'person', text: 'Dana Whitfield, verified' },
    { who: 'agent', text: 'One agent' },
  ];
  desk.policy.cards = (['auto', 'ask', 'never'] as const).flatMap((mode) => [
    ...scopes.map(({ who }) => ({
      ...base, card_id: `${mode}:${who}`, mode, who,
      person_id: who === 'person' ? 'per-dana' : null,
      agent_key_id: who === 'agent' ? 'key-one-agent' : null,
    })),
    { ...base, card_id: `${mode}:paid`, mode, applies_to: 'payments.create_refund' },
  ]);
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport });
  await expect.element(screen.getByText('Dana Whitfield, verified', { exact: true }).first()).toBeVisible();
  for (const mode of ['auto', 'ask', 'never'] as const) {
    for (const { who, text } of [...scopes, { who: 'paid', text: 'The customer who paid, verified' }]) {
      const row = screen.container.querySelector(`[data-rule-id="${mode}:${who}"]`)!;
      const meta = row.querySelector('.cd-rule-sentence__meta');
      expect(meta?.textContent ?? null).toBe(text);
      const sentence = row.querySelector('.cd-rule-sentence__sentence')!;
      expect(sentence.textContent).toMatch(mode === 'auto' ? /^Claude can / : mode === 'ask' ? /^Claude asks you before / : /^Claude never /);
      if (meta !== null) {
        expect(meta.classList.contains('cd-type-meta')).toBe(true);
        expect(meta.compareDocumentPosition(sentence) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
      }
    }
  }
  await expectScreenBasics(screen.container, { owner: true });
  expectNoHorizontalScroll();
});

it.each(['ask', 'never'] as const)('at 390, a shared %s rule keeps its owner scope on the expanded row and references', async (mode) => {
  const desk = mockStore.world.desk(RIVERA.deskId)!;
  const base = desk.policy.cards.find((card) => card.applies_to === 'native.release_document')!;
  desk.policy.cards = [{ ...base, card_id: 'shared-owner', applies_to: 'effect:private_data', mode }];
  const { screen } = await renderRoute(`${DESK}/rules/all`, { viewport: 'phone' });
  await expect.element(screen.getByText("The record's owner, verified", { exact: true }).first()).toBeVisible();
  const rows = [...screen.container.querySelectorAll('[data-rule-id="shared-owner"]')];
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => row.classList.contains('cd-house-rules__rule--reference'))).toHaveLength(2);
  for (const row of rows) expect(row.querySelector('.cd-rule-sentence__meta')?.textContent).toBe("The record's owner, verified");
  expectNoHorizontalScroll();
});

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
