import { expect, it } from 'vitest';

import { one } from '../../ds/boards/spec.ts';
import { expectComputed } from '../../ds/test/expectComputed.ts';
import { businessOut } from '../../mocks/readModels.ts';
import { RIVERA } from '../../mocks/seed.ts';
import { mockStore } from '../../mocks/store.ts';
import { renderRoute } from '../../test/renderRoute.tsx';
import { expectNoHorizontalScroll, expectScreenBasics } from '../../test/screen.ts';

const BILLING = `/app/${RIVERA.deskId}/settings/billing`;
const NOTE = 'Nothing is billed in this prototype. The usage and invoices below are samples.';

it('billing_opens_with_the_sample_preview', async () => {
  const { screen } = await renderRoute(BILLING);
  await expect.element(screen.getByRole('main').getByText(NOTE, { exact: true })).toBeVisible();
  await expect.element(screen.getByRole('region', { name: 'Plan' }).getByText('Free while Claude Desk is a prototype.')).toBeVisible();
});

it.each(['desktop', 'phone'] as const)('billing_matches_the_signed_content_at_%s', async (viewport) => {
  const { screen } = await renderRoute(BILLING, { viewport });
  await expect.element(screen.getByRole('region', { name: 'Plan' })).toBeVisible();
  const content = one(screen.container, '.cd-billing');
  // Every visible line, in reading order, independent of the shared pill's wording.
  const lines = [...content.querySelectorAll('h2, p')].filter((el) => getComputedStyle(el).display !== 'none');
  expect(lines.map((line) => line.textContent)).toEqual([
    NOTE, 'Plan', 'One business, up to three Desks.', 'Free while Claude Desk is a prototype.',
    'Usage this month', 'Nov 1 to 30', 'Main line', ...(viewport === 'desktop' ? ['Turner Plumbing'] : []),
    '128', 'Conversations', '41', 'Actions', '$18.40', 'Model spend', 'Up to two more Desks on this plan.',
    'Budget', 'Model spend', '$18.40 of $50 this month', 'Invoices',
    'October 2026', 'Oct 1 to 31 · One business, up to three Desks', '$0.00',
    'September 2026', 'Sep 1 to 30 · One business, up to three Desks', '$0.00',
  ]);
  const parts = [...content.children];
  expect(parts.slice(1).map((part, i) => Math.round(part.getBoundingClientRect().top - parts[i]!.getBoundingClientRect().bottom))).toEqual([24, 24, 24, 24]);
  for (const heading of content.querySelectorAll('h2')) expectComputed(heading, { fontSize: '16px', lineHeight: '21px', fontWeight: '520' });
  for (const line of content.querySelectorAll('.cd-type-body')) expectComputed(line, { fontSize: '16px', lineHeight: '22px', color: 'rgba(250, 249, 245, 0.92)' });
  for (const line of content.querySelectorAll('.cd-type-meta')) expectComputed(line, { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)' });
  const track = one(content, '.cd-billing__budget-track');
  expectComputed(track, { height: '6px', marginTop: '8px', borderRadius: '999px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
  expect(track.getAttribute('aria-hidden')).toBe('true');
  expect(track.hasAttribute('role')).toBe(false);
  expect(Math.round(one(track, '.cd-billing__budget-fill').getBoundingClientRect().width / track.getBoundingClientRect().width * 100)).toBe(37);
  const usage = one(content, '.cd-billing__usage');
  const names = one(usage, '.cd-billing__names').getBoundingClientRect();
  const stats = [...usage.querySelectorAll('.cd-billing__stat')].map((el) => el.getBoundingClientRect());
  expect(stats.map((stat) => Math.round(stat.top))).toEqual(Array(3).fill(Math.round(stats[0]!.top)));
  expect(Math.round(stats[0]!.top - (viewport === 'phone' ? names.bottom : names.top))).toBe(viewport === 'phone' ? 12 : 0);
  expect(content.querySelectorAll('button, a, input, select, textarea, [tabindex]')).toHaveLength(0);
  expectNoHorizontalScroll();
  await expectScreenBasics(screen.container, { owner: true });
});

it.each([1, 2, 3])('billing_lists_each_of_%i_desks_with_the_plan_capacity', async (count) => {
  const main = mockStore.world.desks[0]!;
  main.summary.name = 'Repairs';
  for (let i = 2; i <= count; i += 1) {
    mockStore.world.addDesk({
      desk_id: `billing-desk-${i}`, slug: `billing-desk-${i}`, name: `Service ${i}`,
      hours: main.summary.hours, openStatus: main.openStatus,
    });
  }
  const { screen } = await renderRoute(BILLING, { viewport: 'phone' });
  await expect.element(screen.getByRole('region', { name: 'Usage this month' })).toBeVisible();
  const content = one(screen.container, '.cd-billing');
  const rows = [...content.querySelectorAll('.cd-billing__usage')];
  expect(rows.map((row) => one(row, '.cd-billing__names').textContent)).toEqual([
    'RepairsTurner Plumbing', ...Array.from({ length: count - 1 }, (_, i) => `Service ${i + 2}Turner Plumbing`),
  ]);
  for (const row of rows) {
    expect([...row.querySelectorAll('.cd-billing__stat')].map((stat) => stat.textContent)).toEqual(['128Conversations', '41Actions', '$18.40Model spend']);
  }
  const usage = screen.getByRole('region', { name: 'Usage this month' }).element();
  const capacity = [...usage.querySelectorAll('.cd-billing__row:not(.cd-billing__usage)')];
  expect(capacity.map((row) => row.textContent)).toEqual(count === 1 ? ['Up to two more Desks on this plan.'] : count === 2 ? ['Up to one more Desk on this plan.'] : []);
  expect(content.querySelectorAll('button, a, input')).toHaveLength(0);
  expectNoHorizontalScroll();
});

it('billing_uses_only_the_current_business_and_its_own_names', async () => {
  const business = businessOut(mockStore.world);
  const desk = business.desks[0]!;
  mockStore.inject({
    route: 'desks', status: 200, times: 10,
    body: [
      { ...business, business_id: 'other-business', name: 'Other business', desks: [{ ...desk, desk_id: 'other-desk', name: 'Other line' }] },
      { ...business, name: 'Oakland Repairs', desks: [{ ...desk, name: 'Appointments' }] },
    ],
  });
  const { screen } = await renderRoute(BILLING);
  await expect.element(screen.getByRole('region', { name: 'Usage this month' })).toBeVisible();
  const content = one(screen.container, '.cd-billing');
  expect([...content.querySelectorAll('.cd-billing__names')].map((el) => el.textContent)).toEqual(['AppointmentsOakland Repairs']);
  expect(content.textContent).toContain('Up to two more Desks on this plan.');
  expect(content.textContent).not.toMatch(/Other business|Other line|Turner Plumbing|Main line/);
});
