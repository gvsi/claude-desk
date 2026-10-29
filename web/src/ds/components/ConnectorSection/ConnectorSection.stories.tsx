import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { chen, rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { outcomePhrase } from '../OutcomeMenu/outcomeWords.ts';
import { ConnectorSection, type ConnectorSectionProps, type ToolSummaryView } from './ConnectorSection.tsx';

const sections: readonly ConnectorSectionProps[] = rivera.connectors.sections;
const [quotes, , , , , payments, stripe] = sections;
if (!quotes || !payments || !stripe) throw new Error('The Rivera hub fixture lost a section');

const meta = {
  title: 'Connectors/ConnectorSection',
  component: ConnectorSection,
  args: payments,
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ConnectorSection {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-01-Rules' },
} satisfies Meta<typeof ConnectorSection>;

export default meta;

type Story = StoryObj<typeof meta>;

/** "{name}: {summary}, {outcome}. Open", each tool row's name. */
function rowName(tool: ToolSummaryView, outcome: string): string {
  return `${tool.name}: ${tool.summary}, ${outcome}. Open`;
}

export const Quotes: Story = {
  args: quotes,
  play: async ({ canvas, canvasElement }) => {
    const section = canvas.getByRole('region', { name: 'Quotes' });
    expectComputed(section, { paddingTop: '0px', borderTopLeftRadius: '12px', backgroundColor: 'rgba(250, 249, 245, 0.03)' });
    const [header, row] = canvas.getAllByRole('link');
    if (!header || !row) throw new Error('Expected the header and one tool row');
    // The header: 14 px 16 px of padding; a tool row: 12 px 16 px, under a hairline.
    expectComputed(header, { paddingTop: '14px', paddingLeft: '16px' });
    const item = row.closest('li');
    if (item === null) throw new Error('The tool link is not in its row');
    expectComputed(item, { paddingTop: '12px', paddingLeft: '16px', borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    // The whole row opens the tool: the link's overlay covers it.
    const overlay = getComputedStyle(row, '::after');
    await expect([overlay.position, overlay.top, overlay.bottom]).toEqual(['absolute', '0px', '0px']);
    await expect(header).toHaveTextContent('1 tool');
    // The tool's name in weight 520, its line in secondary meta, the summary and the outcome at the right.
    expectComputed(canvas.getByText('Quote'), { fontWeight: '520', fontSize: '14px' });
    expectComputed(canvas.getByText('Prices a job from your price list. Changes something. Can be undone.'), {
      fontSize: '13px',
      color: 'rgba(250, 249, 245, 0.64)',
    });
    await expect(canvas.getByText('Anyone · No discounts')).toBeVisible();
    await expect(canvas.getByText('Automatic')).toBeVisible();
    await expect(canvasElement.querySelectorAll('.cd-status-dot--handled')).toHaveLength(1);
  },
};

export const Payments: Story = {
  play: async ({ args, canvas }) => {
    // section_header_and_rows_are_links: the header is one link to the connector's page, naming it.
    const header = canvas.getByRole('link', { name: /^Payments Built in .* 2 tools$/ });
    await expect(header).toHaveAttribute('href', args.href);
    // Each tool row is a link to its page, named by its name, summary and outcome; an automatic
    // rule with an amount limit reads its limit phrase.
    await expect(args.tools.map((tool) => outcomePhrase(tool.mode, tool.limit))).toEqual([
      'Automatic up to $300; over $300, ask me first',
      'Automatic up to $20; over $20, ask me first',
    ]);
    for (const tool of args.tools) {
      const row = canvas.getByRole('link', { name: rowName(tool, outcomePhrase(tool.mode, tool.limit)) });
      await expect(row).toHaveAttribute('href', tool.href);
      // Its line is its description.
      await expect(row).toHaveAccessibleDescription(tool.description);
    }
    await expect(canvas.getAllByRole('link')).toHaveLength(3);
  },
};

export const Stripe: Story = {
  args: stripe,
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('region', { name: 'Stripe' })).toBeVisible();
    // mock_badge_always_beside_external_names
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    // The brand tile, and the refund's held outcome.
    await expect(canvasElement.querySelector('.cd-connector-icon--brand')).not.toBeNull();
    const refund = stripe.tools[1];
    if (!refund) throw new Error('The Stripe fixture lost Refund');
    await expect(canvas.getByRole('link', { name: rowName(refund, 'Ask me first') })).toBeVisible();
  },
};

const changedRefund: ConnectorSectionProps = {
  ...stripe,
  tools: stripe.tools.map((tool) => (tool.key === 'payments.create_refund' ? { ...tool, status: 'needs_review' } : tool)),
};

export const NeedsReview: Story = {
  args: changedRefund,
  parameters: { canvas: 'N-Conn-13-Changed-Today' },
  play: async ({ canvas, canvasElement }) => {
    // status_shows_in_words: a changed tool says so where its outcome was, beside a held dot.
    const refund = changedRefund.tools[1];
    if (!refund) throw new Error('The Stripe fixture lost Refund');
    const row = canvas.getByRole('link', { name: rowName(refund, 'Needs your review') }).closest('li');
    if (row === null) throw new Error('The tool link is not in its row');
    await expect(row).toHaveTextContent('Needs your review');
    await expect(row).not.toHaveTextContent('Ask me first');
    await expect(row.querySelector('.cd-status-dot--held')).not.toBeNull();
    // A tool that is off says so too.
    await expect(canvasElement.querySelectorAll('.cd-status-dot--held')).toHaveLength(1);
  },
};

const addedPayments: ConnectorSectionProps = {
  connector: chen.connectors.views.payments,
  href: '/rules/payments',
  addedNote: 'Added just now',
  tools: [
    {
      key: 'native.payment_link',
      name: 'Payment link',
      description: 'Makes a one-time link for an invoice. Charges money. Can be undone.',
      summary: 'No rule yet',
      mode: 'ask',
      status: 'enabled',
      href: '/rules/payments/payment-link',
    },
    {
      key: 'native.charge_mandate',
      name: 'Charge within a signed limit',
      description: "Lets a visiting agent pay from its owner's signed limit. Charges money. Can be undone.",
      summary: 'No rule yet',
      mode: 'ask',
      status: 'disabled',
      href: '/rules/payments/charge-within-a-signed-limit',
    },
  ],
};

export const AddedJustNow: Story = {
  args: addedPayments,
  parameters: {
    canvas: 'N-Conn-11-GCal-Done',
    canvasNote: "Chen & Co. CPA's Payments right after it was added, each tool at Ask me first; one tool shows how an off tool reads.",
  },
  play: async ({ canvas }) => {
    const note = canvas.getByText('Added just now');
    expectComputed(note, { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(canvas.getByRole('link', { name: /^Payments Built in .* Added just now 2 tools$/ })).toBeVisible();
    const [link, mandate] = addedPayments.tools;
    if (!link || !mandate) throw new Error('Expected two tools');
    await expect(canvas.getByRole('link', { name: rowName(link, 'Ask me first') })).toBeVisible();
    // An off tool reads "Off", beside a hollow info dot.
    const off = canvas.getByRole('link', { name: rowName(mandate, 'Off') }).closest('li');
    await expect(off?.querySelector('.cd-status-dot--info')).not.toBeNull();
  },
};

export const Phone: Story = {
  args: stripe,
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvas: 'N-Conn-16-Phone-Rules' },
  play: async ({ canvas, canvasElement }) => {
    // phone_hides_descriptions: at 390 px the connector's line and count and each tool's line go.
    const width = window.innerWidth;
    await expect(width).toBe(390);
    await expect(canvas.getByText(stripe.connector.description)).not.toBeVisible();
    await expect(canvas.getByText('2 tools')).not.toBeVisible();
    for (const tool of stripe.tools) {
      await expect(canvas.getByText(tool.description)).not.toBeVisible();
      // The summary sits under the tool's name, and the outcome on its own line under that, all
      // lined up, as the updated phone board draws them.
      const name = canvas.getByText(tool.name).getBoundingClientRect();
      const summary = canvas.getByText(tool.summary).getBoundingClientRect();
      const outcome = canvas.getByText(outcomePhrase(tool.mode, tool.limit)).getBoundingClientRect();
      await expect(summary.top).toBeGreaterThanOrEqual(name.bottom - 1);
      await expect(Math.round(summary.left)).toBe(Math.round(name.left));
      await expect(outcome.top).toBeGreaterThanOrEqual(summary.bottom - 1);
      await expect(Math.round(outcome.left)).toBeLessThanOrEqual(Math.round(name.left) + 14);
    }
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    // Nothing is wider than the window, and nothing scrolls sideways.
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};

/** Payments with the largest limit a rule can carry on its payment link. */
const paymentsAtTheCeiling: ConnectorSectionProps = {
  ...payments,
  tools: payments.tools.map((tool) => (tool.key === 'native.payment_link' ? { ...tool, limit: '$10,000' } : tool)),
};

export const NarrowMaxLimit: Story = {
  args: paymentsAtTheCeiling,
  globals: { viewport: { value: 'narrow', isRotated: false } },
  parameters: {
    canvas: 'N-Conn-16-Phone-Rules',
    canvasNote: 'The largest limit at the narrowest phone width, following the updated phone board: the outcome on its own line.',
    viewport: { options: { narrow: { name: 'Narrow phone', styles: { width: '320px', height: '640px' }, type: 'mobile' } } },
  },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(320);
    const phrase = 'Automatic up to $10,000; over $10,000, ask me first';
    const outcome = canvas.getByText(phrase);
    const summary = canvas.getAllByText('2 rules · 1 shared')[0];
    if (summary === undefined) throw new Error('No summary');
    await expect(outcome.getBoundingClientRect().top).toBeGreaterThanOrEqual(summary.getBoundingClientRect().bottom - 1);
    // The phrase wraps on its line, and nothing scrolls sideways.
    await expect(outcome.getBoundingClientRect().height).toBeGreaterThan(18);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};
