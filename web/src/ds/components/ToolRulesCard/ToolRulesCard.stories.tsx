import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { RuleCard } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectSetOffName } from '../../test/expectSetOffName.ts';
import { expectSharedTitles } from '../../test/expectSharedTitles.ts';
import { expectListsKeepTheirRole } from '../../test/expectListRoles.ts';
import type { RuleRowProps } from '../RuleRow/RuleRow.tsx';
import { rulesForTool } from './toolRules.ts';
import { ToolRulesCard } from './ToolRulesCard.tsx';

type RiveraCardId = keyof typeof rivera.ruleWords;

const cards: RuleCard[] = [...Object.values(rivera.ruleCards), rivera.sharedChargeCard];

/** A rule row as the screen builds it: the card's words, its limit and, for an effect card, the shared line. */
function row(card: RuleCard, onChangeOutcome?: RuleRowProps['onChangeOutcome']): RuleRowProps {
  const id = card.card_id as RiveraCardId;
  const limits: Partial<Record<RiveraCardId, string>> = rivera.ruleLimits;
  return {
    rule: card,
    words: rivera.ruleWords[id],
    limit: limits[id],
    shared: card.applies_to.startsWith('effect:') ? rivera.sharedChargeShared : undefined,
    onChangeOutcome,
  };
}

const onChange = fn();

const meta = {
  title: 'Rules/ToolRulesCard',
  component: ToolRulesCard,
  args: {
    label: 'Payment link',
    tool: {
      name: 'Payment link',
      description: "Makes a one-time link for a quote. Charges money. Can't be undone.",
      href: '/connectors/payments/payment-link',
    },
    // The rules that govern the tool, most specific first: the agent's shared rule, then the tool's own.
    rules: rulesForTool({ tool: 'native.payment_link', effects: ['charge'] }, cards).map((card) => row(card, onChange)),
    onAddRule: fn(),
  },
  render: (args) => (
    <div style={{ maxWidth: 960, minHeight: 320 }}>
      <ToolRulesCard {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-02-Payments' },
} satisfies Meta<typeof ToolRulesCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PaymentLinkOnPayments: Story = {
  parameters: {
    canvasNote:
      "The shared rule is the demo agent's charges up to $20, automatic, read as \"Allow\"; the board's example is illustrative. A rule for one agent outranks the tool's own rule, so it comes first.",
  },
  play: async ({ args, canvas, canvasElement }) => {
    // list_semantics_kept: a list drawn without markers says role="list", so Safari keeps it a list.
    await expect(expectListsKeepTheirRole(canvasElement)).toBeGreaterThanOrEqual(1);
    const card = canvas.getByRole('region', { name: 'Payment link' });
    expectComputed(card, { paddingTop: '16px', borderTopLeftRadius: '12px' });
    // The tool's name and line are one link to its page, with a chevron.
    const link = canvas.getByRole('link', { name: /^Payment link/ });
    await expect(link).toHaveAttribute('href', '/connectors/payments/payment-link');
    // The tool's title is set off as the business's own words, first in its line.
    await expectSetOffName(link, 'Payment link');
    await expect(link).toHaveTextContent("Makes a one-time link for a quote. Charges money. Can't be undone.");
    await expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // A row per rule, the shared one first.
    const rows = canvas.getAllByRole('listitem');
    await expect(rows).toHaveLength(2);
    await expect(rows[0]).toHaveTextContent(`Shared rule. ${rivera.sharedChargeAppliesTo}`);
    await expectSharedTitles(rows[0] as HTMLElement);
    await expect(rows[0]).toHaveTextContent('Allow');
    await expect(rows[1]).toHaveTextContent(rivera.ruleCards['rv-link'].reason);
    await expect(rows[1]).toHaveTextContent('Allow');
    // fallback_and_add_a_rule
    await expect(canvas.getByText('Anything else here: ask me.')).toBeVisible();
    const add = canvas.getByRole('button', { name: 'Add a rule' });
    await add.click();
    await expect(args.onAddRule).toHaveBeenCalledTimes(1);
  },
};

export const WithoutLink: Story = {
  name: 'Without a link',
  args: {
    tool: { name: 'Payment link', description: "Makes a one-time link for a quote. Charges money. Can't be undone." },
  },
  parameters: {
    canvasNote:
      'Not a board of its own: Payment link as N-Conn-02-Payments draws it, for All rules while the tool pages are not built. Without an href the tool’s name and line are plain text, with no chevron and no tab stop.',
  },
  play: async ({ canvas }) => {
    const card = canvas.getByRole('region', { name: 'Payment link' });
    await expect(within(card).queryAllByRole('link')).toHaveLength(0);
    await expect(card.querySelectorAll('.cd-tool-rules__chevron')).toHaveLength(0);
    const name = within(card).getByText('Payment link', { selector: '.cd-tool-rules__tool-name' });
    expectComputed(name, { color: 'rgba(250, 249, 245, 0.92)', display: 'block' });
    await expect(within(card).getByText("Makes a one-time link for a quote. Charges money. Can't be undone.")).toBeVisible();
    // The rules and the fallback as with a link.
    await expect(within(card).getAllByRole('listitem')).toHaveLength(2);
    await expect(within(card).getByText('Anything else here: ask me.')).toBeVisible();
  },
};

export const NameOnly: Story = {
  name: 'Name only',
  args: {
    tool: { name: 'Payment link', description: '' },
  },
  play: async ({ canvas }) => {
    const card = canvas.getByRole('region', { name: 'Payment link' });
    await expect(card.querySelector('.cd-tool-rules__tool-description')).toBeNull();
    await expect(card).toHaveAccessibleName('Payment link');
    await expect(within(card).getByText('Payment link', { selector: '.cd-tool-rules__tool-name' })).toBeVisible();
  },
};

export const RefundOnItsPage: Story = {
  args: {
    label: 'Your rules for refund',
    tool: undefined,
    rules: rulesForTool({ tool: 'payments.create_refund', effects: ['pay_out', 'private_data'] }, cards).map((card) => row(card, onChange)),
  },
  parameters: { canvas: 'N-Conn-05-Refund' },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('region', { name: 'Your rules for refund' })).toBeVisible();
    // On the tool's own page there is no header link: only its rules and the fallback.
    await expect(canvas.queryByRole('link')).toBeNull();
    const rows = canvas.getAllByRole('listitem');
    await expect(rows).toHaveLength(1);
    await expect(rows[0]).toHaveTextContent('Refunds to a customer wait for your answer.');
    await expect(rows[0]).toHaveTextContent('The customer who paid, verified');
    // The first row has no hairline above it when nothing comes before it.
    expectComputed(rows[0] as Element, { borderTopWidth: '0px' });
    await expect(canvas.getByRole('button', { name: 'Ask me first. Change the outcome of: Refunds to a customer wait for your answer.' })).toBeVisible();
    await expect(canvas.getByText('Anything else here: ask me.')).toBeVisible();
  },
};

export const NoFallback: Story = {
  args: {
    rules: [
      {
        rule: { card_id: 'rv-no-links', mode: 'never', reason: 'No payment links for now.' },
        words: [{ field: 'who', text: 'Anyone' }],
        onChangeOutcome: onChange,
      },
    ],
    fallback: false,
  },
  parameters: { canvasNote: 'A tool a never card for anyone covers, so nothing else is left to ask about; no board draws it.' },
  play: async ({ canvas }) => {
    // fallback_and_add_a_rule: a never card for anyone covers the tool, so there is no fallback line.
    await expect(canvas.queryByText('Anything else here: ask me.')).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Add a rule' })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Never. Change the outcome of: No payment links for now.' })).toBeVisible();
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: "The Payments page's first card on a phone, each outcome on its own line. No board draws a connector's page on a phone; the nearest is N-Conn-24-Phone-Connectors.",
  },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    // Each rule's outcome sits on its own line under its words, and its phrase wraps inside it.
    for (const row of canvas.getAllByRole('listitem')) {
      const words = row.querySelector('.cd-rule-row__text');
      const button = within(row).getByRole('button');
      if (words === null) throw new Error('No words');
      await expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(words.getBoundingClientRect().bottom);
    }
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};

/** A business's own job on Rules, just after a confirmed change landed on it. */
const INTAKE_ASKS: RuleCard = {
  card_id: 'intake-asks',
  applies_to: 'desk.new-client-intake',
  mode: 'ask',
  who: 'anyone',
  person_id: null,
  agent_key_id: null,
  max_amount_cents: null,
  max_discount_bp: 0,
  hours: null,
  review: false,
  is_default: false,
  reason: 'New clients answer three questions, then wait for your answer.',
};

export const Landed: Story = {
  args: {
    label: 'New client intake',
    tool: { name: 'New client intake', description: 'Asks: Is this for you or for a business? Which tax years do you need help with?' },
    rules: [{ rule: INTAKE_ASKS, words: [{ field: 'who', text: 'Anyone' }] }],
    onAddRule: undefined,
    landed: 1,
  },
  parameters: {
    canvas: 'none',
    canvasNote:
      'No board draws a business job landing; the review board UXC-P701-After draws a tool row on Rules landing, and a job card lands the same way: lit in the selected fill, then let go, keeping "Updated" by its title. Storybook shows the motion your system asks for: under reduced motion the card is at its end state at once.',
  },
  play: async ({ canvas, canvasElement }) => {
    const body = canvasElement.querySelector<HTMLElement>('.cd-tool-rules');
    if (!body) throw new Error('no card body');
    await expect(body).toHaveAttribute('data-landed', '1');
    // "Updated" 8 px after the tool's name, centered on it.
    const name = canvas.getByText('New client intake', { selector: '.cd-tool-rules__tool-name' });
    const pill = canvas.getByText('Updated', { exact: true });
    await Promise.all((pill.parentElement ?? pill).getAnimations().map((arrival) => arrival.finished));
    await expect(Math.round(pill.getBoundingClientRect().left - name.getBoundingClientRect().right)).toBe(8);
    const middle = (el: Element) => (el.getBoundingClientRect().top + el.getBoundingClientRect().bottom) / 2;
    await expect(Math.abs(middle(pill) - middle(name))).toBeLessThan(1);
    // The fill covers the card out to its edge, behind its words.
    const glow = body.querySelector<HTMLElement>('.cd-landed-glow');
    if (!glow) throw new Error('no fill behind the landed card');
    const card = body.closest('.cd-card') as HTMLElement;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      expectComputed(glow, { display: 'none' });
      return;
    }
    await expect(Math.round(glow.getBoundingClientRect().left - card.getBoundingClientRect().left)).toBe(1);
    await expect(Math.round(card.getBoundingClientRect().bottom - glow.getBoundingClientRect().bottom)).toBe(1);
    expectComputed(glow, { animationName: 'cd-landed-light, cd-landed-let-go', animationDelay: '0s, 1.72s' });
  },
};
