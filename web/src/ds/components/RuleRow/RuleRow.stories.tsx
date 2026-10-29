import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { RuleRow } from './RuleRow.tsx';

const link = rivera.ruleCards['rv-link'];
const shared = rivera.sharedChargeCard;
const refund = rivera.ruleCards['rv-refund'];

const SHARED_APPLIES_TO = rivera.sharedChargeAppliesTo;

const meta = {
  title: 'Rules/RuleRow',
  component: RuleRow,
  args: { rule: link, words: rivera.ruleWords['rv-link'], limit: rivera.ruleLimits['rv-link'], onChangeOutcome: fn() },
  render: (args) => (
    <div style={{ maxWidth: 920, minHeight: 200 }}>
      <RuleRow {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-02-Payments' },
} satisfies Meta<typeof RuleRow>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PaymentLink: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // The reason, then the words that say what it enforces, joined by " · " in secondary meta.
    const reason = canvas.getByText(link.reason);
    expectComputed(reason, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.92)' });
    const words = canvas.getByText('Anyone · Up to $300 · Checked by the reviewer');
    expectComputed(words, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    // The outcome at the right, with the card's amount limit.
    const button = canvas.getByRole('button', {
      name: `Automatic up to $300; over $300, ask me first. Change the outcome of: ${link.reason}`,
    });
    await expect(button.getBoundingClientRect().left).toBeGreaterThan(words.getBoundingClientRect().right);
    // No shared line on a tool's own rule.
    await expect(canvas.queryByText(/Shared rule/)).toBeNull();
    // The pick goes to the screen, which shows the change before it applies.
    await userEvent.click(button);
    await userEvent.click(canvas.getByRole('menuitemradio', { name: 'Ask me first' }));
    await expect(args.onChangeOutcome).toHaveBeenCalledTimes(1);
    await expect(args.onChangeOutcome).toHaveBeenCalledWith('ask');
  },
};

export const Shared: Story = {
  args: {
    rule: shared,
    words: rivera.ruleWords['rv-agent-charges'],
    limit: rivera.ruleLimits['rv-agent-charges'],
    shared: { appliesTo: SHARED_APPLIES_TO },
  },
  parameters: {
    canvasNote: "The shared rule is the demo agent's charges up to $20, automatic, read as \"Automatic up to $20; over $20, ask me first\"; the board's example is illustrative.",
  },
  play: async ({ canvas, canvasElement }) => {
    // limit_reads_automatic_up_to
    const button = canvas.getByRole('button', { name: `Automatic up to $20; over $20, ask me first. Change the outcome of: ${shared.reason}` });
    await expect(button).toHaveTextContent('Automatic up to $20; over $20, ask me first');
    await expect(canvas.getByText("Alex Kim's assistant · Up to $20")).toBeVisible();
    // shared_rule_says_what_it_covers: the shared icon, hidden, and the words in caption type.
    const line = canvas.getByText(`Shared rule. ${SHARED_APPLIES_TO}`);
    expectComputed(line, { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });
    const icon = canvasElement.querySelector('.cd-rule-row__shared svg');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');
  },
};

export const ReadOnly: Story = {
  args: { rule: refund, words: rivera.ruleWords['rv-refund'], limit: undefined, onChangeOutcome: undefined },
  play: async ({ canvas }) => {
    await expect(canvas.getByText(refund.reason)).toBeVisible();
    await expect(canvas.getByText('The customer who paid, verified')).toBeVisible();
    // Without onChangeOutcome the outcome is words and a dot, not a button.
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.getByText('Ask me first')).toBeVisible();
  },
};
