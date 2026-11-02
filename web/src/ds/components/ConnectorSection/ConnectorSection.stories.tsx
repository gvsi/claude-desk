import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { chen, rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectSetOffName } from '../../test/expectSetOffName.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import { outcomePhrase } from '../OutcomeMenu/outcomeWords.ts';
import { ConnectorSection, type ConnectorSectionProps, type ToolSummaryView } from './ConnectorSection.tsx';

const sections: readonly ConnectorSectionProps[] = rivera.connectors.sections;
const [quotes, , , , , payments, stripe] = sections;
if (!quotes || !payments || !stripe) throw new Error('The Turner hub fixture lost a section');

const meta = {
  title: 'Connectors/ConnectorSection',
  component: ConnectorSection,
  args: payments,
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ConnectorSection {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-12-Chat' },
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
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    const section = canvas.getByRole('region', { name: 'Quotes' });
    expectComputed(section, { paddingTop: '0px', borderTopLeftRadius: '12px', backgroundColor: 'rgba(250, 249, 245, 0.03)' });
    const [header, row] = canvas.getAllByRole('link');
    if (!header || !row) throw new Error('Expected the header and one tool row');
    // The header: 14 px 16 px of padding; a tool row: 12 px 16 px, under a hairline.
    expectComputed(header, { paddingTop: '14px', paddingLeft: '16px' });
    // The tool's title is set off as the business's own words, first in its link.
    await expectSetOffName(row, quotes.tools[0]?.name ?? '');
    const item = row.closest('li');
    if (item === null) throw new Error('The tool link is not in its row');
    expectComputed(item, { paddingTop: '12px', paddingLeft: '16px', borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    // The whole row opens the tool: the link's overlay covers it.
    const overlay = getComputedStyle(row, '::after');
    await expect([overlay.position, overlay.top, overlay.bottom]).toEqual(['absolute', '0px', '0px']);
    await expect(header).toHaveTextContent('1 tool');
    // The tool's name in weight 520, its line in secondary meta, the summary and the outcome at the right.
    expectComputed(canvas.getByText('Quote'), { fontWeight: '520', fontSize: '15px' });
    expectComputed(canvas.getByText('Prices a job from your price list. Changes something. Can be undone.'), {
      fontSize: '14px',
      color: 'rgba(250, 249, 245, 0.64)',
    });
    await expect(canvas.getByText('Anyone · No discounts')).toBeVisible();
    await expect(canvas.getByText('Automatic')).toBeVisible();
    await expect(canvasElement.querySelectorAll('.cd-status-dot--handled')).toHaveLength(1);
  },
};

/** Quotes on a Rules page whose connector and tool pages aren't built: the same rows, nothing to open. */
const quotesWithoutPages: ConnectorSectionProps = {
  ...quotes,
  href: undefined,
  tools: quotes.tools.map((tool) => ({ ...tool, href: undefined })),
};

export const WithoutLinks: Story = {
  name: 'Without links',
  args: quotesWithoutPages,
  parameters: {
    canvasNote:
      'Not a board of its own: Quotes as N-Conn-12-Chat draws it, for a Rules page whose connector and tool pages are not built yet. Without an href the header and each tool row draw the same words in the same type, with no chevron, no link and no tab stop.',
  },
  play: async ({ canvas, canvasElement }) => {
    const section = canvas.getByRole('region', { name: 'Quotes' });
    // Nothing to open: no link, nothing in the tab order, no chevron.
    await expect(canvas.queryAllByRole('link')).toHaveLength(0);
    await expect(section.querySelectorAll('a, [tabindex]')).toHaveLength(0);
    await expect(section.querySelectorAll('.cd-connector-section__chevron')).toHaveLength(0);
    // The header keeps its words and its 14 px 16 px of padding.
    const header = section.querySelector<HTMLElement>('.cd-connector-section__header');
    if (header === null) throw new Error('no header');
    expectComputed(header, { paddingTop: '14px', paddingLeft: '16px', display: 'flex' });
    await expect(header).toHaveTextContent('Quotes');
    await expect(header).toHaveTextContent('1 tool');
    // The tool's name in the linked row's type and weight, plain, with no overlay over the row.
    const name = canvas.getByText('Quote');
    expectComputed(name, { fontWeight: '520', fontSize: '15px', color: 'rgba(250, 249, 245, 0.92)' });
    await expect(getComputedStyle(name, '::after').content).toBe('none');
    // The words and the outcome still at the row's right edge, where the chevron no longer is.
    const item = name.closest('li');
    if (item === null) throw new Error('The tool name is not in its row');
    const outcome = item.querySelector<HTMLElement>('.cd-connector-section__tool-outcome');
    if (outcome === null) throw new Error('no outcome');
    await expect(Math.round(item.getBoundingClientRect().right - outcome.getBoundingClientRect().right)).toBe(16);
    await expect(canvas.getByText('Anyone · No discounts')).toBeVisible();
    await expect(canvas.getByText('Automatic')).toBeVisible();
  },
};

export const Payments: Story = {
  play: async ({ args, canvas }) => {
    // section_header_and_rows_are_links: the header is one link to the connector's page under
    // Connectors, naming it with no "Built in" (the Rules page groups outcomes, not where tools come from).
    const header = canvas.getByRole('link', { name: /^Payments Payment links .* 2 tools$/ });
    await expect(header).toHaveAttribute('href', args.href);
    await expect(args.href).toMatch(/^\/connectors\//);
    await expect(header).not.toHaveTextContent('Built in');
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
    // Stripe's own mark, and the refund's held outcome.
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
  href: '/connectors/payments',
  addedNote: 'Added just now',
  tools: [
    {
      key: 'native.payment_link',
      name: 'Payment link',
      description: "Makes a one-time link for an invoice. Charges money. Can't be undone.",
      summary: 'No rule yet',
      mode: 'ask',
      status: 'enabled',
      href: '/connectors/payments/payment-link',
    },
    {
      key: 'native.charge_mandate',
      name: 'Charge within a signed limit',
      description: "Lets a visiting agent pay from its owner's signed limit. Charges money. Can't be undone.",
      summary: 'No rule yet',
      mode: 'ask',
      status: 'disabled',
      href: '/connectors/payments/charge-within-a-signed-limit',
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
    expectComputed(note, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    await expect(canvas.getByRole('link', { name: /^Payments Lets clients .* Added just now 2 tools$/ })).toBeVisible();
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
  parameters: { canvas: 'none', canvasNote: 'No board on this branch draws the Rules page on a phone (its phone board is checked where the presets are built); the nearest is N-Conn-24-Phone-Connectors.' },
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
    canvas: 'none',
    canvasNote: 'The largest limit at the narrowest phone width: the outcome on its own line. No board on this branch draws the Rules page on a phone (its phone board is checked where the presets are built); the nearest is N-Conn-24-Phone-Connectors.',
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

/** A placeholder for what the screen puts above the tools, as the payment limit line sits there. */
const LIMIT_LINE = 'No payment over $500 goes through without asking you, whatever the rules below say.';

export const LineAboveTools: Story = {
  args: { ...payments, aboveTools: <p className="cd-type-body">{LIMIT_LINE}</p> },
  parameters: {
    canvas: 'N-Conn-12-Chat',
    canvasNote:
      'The line between the header and the tools is the screen’s: on Payments and Stripe the payment limit, which the follow-up builds with its Change button; here a placeholder line.',
  },
  play: async ({ canvas }) => {
    // aboveTools: one row between the header and the first tool, padded as a tool row, under a hairline.
    const line = canvas.getByText(LIMIT_LINE);
    const row = line.closest<HTMLElement>('.cd-connector-section__above');
    if (!row) throw new Error('The line is not in its row');
    expectComputed(row, { paddingTop: '12px', paddingLeft: '16px', borderTopWidth: '1px', borderTopColor: 'rgba(250, 249, 245, 0.12)' });
    const [header, firstTool] = canvas.getAllByRole('link');
    await expect(row.getBoundingClientRect().top).toBeGreaterThanOrEqual((header as HTMLElement).getBoundingClientRect().bottom);
    await expect(row.getBoundingClientRect().bottom).toBeLessThanOrEqual((firstTool as HTMLElement).closest('li')?.getBoundingClientRect().top ?? 0);
  },
};

/** Quotes just after "Stop quoting on weekends" was confirmed: the Quote row landed, with its new words. */
const quotesLanded: ConnectorSectionProps = {
  ...quotes,
  tools: quotes.tools.map((tool) => ({ ...tool, summary: 'Anyone · No discounts · Weekdays, all day', landed: 1 })),
};

export const Landed: Story = {
  args: quotesLanded,
  parameters: {
    canvasNote:
      'The signed board draws the hub at rest; the review board UXC-P701-After draws the Quote row just after the change was confirmed: lit in the selected fill, then let go, keeping "Updated". Storybook shows the motion your system asks for: under reduced motion the row is at its end state at once.',
  },
  play: async ({ canvas, canvasElement }) => {
    const row = canvasElement.querySelector<HTMLElement>('.cd-connector-section__tool');
    if (!row) throw new Error('no tool row');
    // "Updated" after the name, 8 px from it, centered on it: a Pill, never filled.
    const name = canvas.getByText('Quote');
    const pill = canvas.getByText('Updated', { exact: true });
    await expect(pill).toHaveClass('cd-pill');
    await Promise.all((pill.parentElement ?? pill).getAnimations().map((arrival) => arrival.finished));
    const gap = pill.getBoundingClientRect().left - name.getBoundingClientRect().right;
    await expect(Math.round(gap)).toBe(8);
    const middle = (el: Element) => (el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) / 2;
    await expect(Math.abs(middle(pill) - middle(name))).toBeLessThan(1);
    // The link's name starts with the words it shows, says the row was updated, and has its new words.
    await expect(canvas.getByRole('link', { name: 'Quote, updated: Anyone · No discounts · Weekdays, all day, Automatic. Open' })).toBeVisible();
    await expect(row).toHaveAttribute('data-landed', '1');
    const glow = row.querySelector<HTMLElement>('.cd-landed-glow');
    if (!glow) throw new Error('no glow behind the landed row');
    await expect(glow).toHaveAttribute('aria-hidden', 'true');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // The end state at once: no fill, and "Updated" already there.
      expectComputed(glow, { display: 'none' });
      expectComputed(pill.parentElement ?? pill, { animationName: 'none' });
      return;
    }
    // Lit in the selected fill behind its words, on motion-fast, then let go on motion-base after a 1.6 s hold.
    expectComputed(glow, {
      animationName: 'cd-landed-light, cd-landed-let-go',
      animationDuration: '0.12s, 0.2s',
      animationDelay: '0s, 1.72s',
    });
  },
};
