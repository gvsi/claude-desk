import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { BillingPreview } from '../../owner/settings/BillingPage.tsx';
import '../../owner/settings/Settings.css';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { SettingsPage } from './parts.tsx';
import { SPEC, expectFooter, expectFooterAtFoot, expectSettingsPage, one } from './spec.ts';

function SettingsBilling() {
  return (
    <SettingsPage current="billing">
      <BillingPreview business={{ name: rivera.business.name, desks: [{ desk_id: 'billing-main', name: rivera.business.deskName }] }} />
    </SettingsPage>
  );
}

const meta = {
  title: 'Boards/Settings, billing',
  render: () => <SettingsBilling />,
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Live-REV-BIL-1512',
    canvasNote: 'Signed on 2026-11-01. Static sample usage and invoices, with nothing billed. The shared note supplies its pill word.',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The signed content: 24 px between parts, compact cards, and the type of every line. */
async function expectBilling(root: HTMLElement, phone = false) {
  const content = one(root, '.cd-billing');
  const page = within(content);
  const gap = (a: Element, b: Element) => Math.round(b.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
  const parts = [...content.children];
  await expect(parts.slice(1).map((part, i) => gap(parts[i]!, part))).toEqual([24, 24, 24, 24]);
  await expect(page.getByText('Nothing is billed in this prototype. The usage and invoices below are samples.')).toBeVisible();
  for (const heading of page.getAllByRole('heading')) {
    expectComputed(heading, { fontSize: '16px', lineHeight: '21px', fontWeight: '520' });
    await expect(heading.tagName).toBe('H2');
  }
  for (const line of content.querySelectorAll('.cd-type-body')) {
    expectComputed(line, { fontFamily: /^"Hanken Grotesk"/, fontSize: '15px', lineHeight: '21px', color: 'rgba(250, 249, 245, 0.92)' });
  }
  for (const line of content.querySelectorAll('.cd-type-meta')) {
    expectComputed(line, { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)' });
  }
  for (const section of content.querySelectorAll('.cd-billing__section')) {
    await expect(gap(one(section, '.cd-section-header'), one(section, '.cd-card'))).toBe(12);
  }
  const plan = page.getByRole('region', { name: 'Plan' });
  expectComputed(plan, { ...SPEC.card, paddingTop: '16px', paddingLeft: '16px' });
  const name = within(plan).getByRole('heading', { name: 'Plan' });
  const offer = page.getByText('One business, up to three Desks.', { exact: true });
  const free = page.getByText('Free while Claude Desk is a prototype.');
  await expect([gap(name, offer), gap(offer, free)]).toEqual([8, 8]);
  await expect(Math.round(plan.getBoundingClientRect().height)).toBe(111);
  for (const row of content.querySelectorAll('.cd-billing__row')) expectComputed(row, { padding: '16px' });
  for (const line of content.querySelectorAll('.cd-billing__number')) expectComputed(line, { fontVariantNumeric: 'tabular-nums' });
  const usage = one(content, '.cd-billing__usage');
  await expect([...usage.querySelectorAll('.cd-billing__stat')].map((stat) => stat.textContent)).toEqual(['128Conversations', '41Actions', '$18.40Model spend']);
  await expect(page.getByText('Up to two more Desks on this plan.')).toBeVisible();
  const names = one(usage, '.cd-billing__names');
  const stats = [...usage.querySelectorAll('.cd-billing__stat')];
  await expect(stats.map((stat) => Math.round(stat.getBoundingClientRect().top))).toEqual(Array(3).fill(Math.round(stats[0]!.getBoundingClientRect().top)));
  if (phone) {
    await expect(gap(names, stats[0]!)).toBe(12);
    expectComputed(one(names, '.cd-billing__business'), { display: 'none' });
  } else {
    await expect(Math.round(names.getBoundingClientRect().top)).toBe(Math.round(stats[0]!.getBoundingClientRect().top));
    await expect(page.getByText('Turner Plumbing', { exact: true })).toBeVisible();
  }
  const track = one(content, '.cd-billing__budget-track');
  expectComputed(track, { height: '6px', backgroundColor: 'rgba(250, 249, 245, 0.1)' });
  expectComputed(one(track, '.cd-billing__budget-fill'), { backgroundColor: 'rgba(250, 249, 245, 0.64)' });
  await expect(Math.round(one(track, '.cd-billing__budget-fill').getBoundingClientRect().width / track.getBoundingClientRect().width * 100)).toBe(37);
  await expect(page.getByText('$18.40 of $50 this month')).toBeVisible();
  await expect([...content.querySelectorAll('.cd-billing__invoice')].map((row) => row.textContent)).toEqual([
    'October 2026Oct 1 to 31 · One business, up to three Desks$0.00',
    'September 2026Sep 1 to 30 · One business, up to three Desks$0.00',
  ]);
  await expect(content.querySelectorAll('button, a, input')).toHaveLength(0);
  await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  await expectFooter(root);
}

export const Board: Story = {
  play: async ({ canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectSettingsPage(canvasElement, 'Billing');
    await expectBilling(canvasElement);
    await expectFooterAtFoot(canvasElement);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'N-Live-REV-BIL-390' },
  play: async ({ canvasElement }) => {
    await expect([window.innerWidth, window.innerHeight]).toEqual([390, 844]);
    await expectBilling(canvasElement, true);
  },
};
