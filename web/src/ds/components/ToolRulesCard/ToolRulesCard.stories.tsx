import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import type { RuleCard } from '../../../api/contracts.ts';
import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
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
    shared: card.applies_to.startsWith('effect:') ? { appliesTo: rivera.sharedChargeAppliesTo } : undefined,
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
      description: 'Makes a one-time link for a quote. Charges money. Can be undone.',
      href: '/rules/payments/payment-link',
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
      "The shared rule is the demo agent's charges up to $20, automatic, read as \"Automatic up to $20; over $20, ask me first\"; the board's example is illustrative. A rule for one agent outranks the tool's own rule, so it comes first.",
  },
  play: async ({ args, canvas }) => {
    const card = canvas.getByRole('region', { name: 'Payment link' });
    expectComputed(card, { paddingTop: '16px', borderTopLeftRadius: '12px' });
    // The tool's name and line are one link to its page, with a chevron.
    const link = canvas.getByRole('link', { name: /^Payment link/ });
    await expect(link).toHaveAttribute('href', '/rules/payments/payment-link');
    await expect(link).toHaveTextContent('Makes a one-time link for a quote. Charges money. Can be undone.');
    await expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // A row per rule, the shared one first.
    const rows = canvas.getAllByRole('listitem');
    await expect(rows).toHaveLength(2);
    await expect(rows[0]).toHaveTextContent(`Shared rule. ${rivera.sharedChargeAppliesTo}`);
    await expect(rows[0]).toHaveTextContent('Automatic up to $20; over $20, ask me first');
    await expect(rows[1]).toHaveTextContent(rivera.ruleCards['rv-link'].reason);
    await expect(rows[1]).toHaveTextContent('Automatic up to $300; over $300, ask me first');
    // fallback_and_add_a_rule
    await expect(canvas.getByText('Anything else here: ask me.')).toBeVisible();
    const add = canvas.getByRole('button', { name: 'Add a rule' });
    await add.click();
    await expect(args.onAddRule).toHaveBeenCalledTimes(1);
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
    canvas: 'N-Conn-16-Phone-Rules',
    canvasNote: "The Payments page's first card on a phone, following the updated phone board: each outcome on its own line.",
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
