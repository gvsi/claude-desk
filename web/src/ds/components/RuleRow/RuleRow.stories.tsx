import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectUserText } from '../../test/expectUserText.ts';
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
    expectComputed(reason, { fontSize: '15px', color: 'rgba(250, 249, 245, 0.92)' });
    const words = canvas.getByText('Anyone · Up to $300 · Checked by the reviewer');
    expectComputed(words, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
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
    shared: rivera.sharedChargeShared,
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
    const line = canvasElement.querySelector<HTMLElement>('.cd-rule-row__shared > span');
    if (line === null) throw new Error('No shared line');
    await expect(line).toHaveTextContent(`Shared rule. ${SHARED_APPLIES_TO}`);
    await expect(line).toBeVisible();
    expectComputed(line, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    // Each tool's title is its own user-text item, set off on a line of its own under the app's words.
    for (const title of rivera.sharedChargeShared.titles) expectUserText(line, title);
    const titles = [...line.querySelectorAll<HTMLElement>('[data-copy="user"]')];
    await expect(line.querySelector('br + [data-copy="user"]')).not.toBeNull();
    for (const title of titles) expectComputed(title, { color: 'rgba(250, 249, 245, 0.92)', fontWeight: '520', unicodeBidi: 'isolate' });
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

export const NarrowMaxLimit: Story = {
  args: {
    rule: { card_id: 'rv-big-links', mode: 'auto', reason: 'Payment links up to $10,000 for verified customers.' },
    words: [
      { field: 'who', text: 'Verified customers' },
      { field: 'limits', text: 'Up to $10,000' },
    ],
    limit: '$10,000',
    shared: rivera.sharedChargeShared,
  },
  globals: { viewport: { value: 'narrow', isRotated: false } },
  parameters: {
    canvas: 'none',
    canvasNote: 'The largest limit a rule can carry, at the narrowest phone width: the outcome on its own line. No board on this branch draws the Rules page on a phone (its phone board is checked where the presets are built); the nearest is N-Conn-24-Phone-Connectors.',
    viewport: { options: { narrow: { name: 'Narrow phone', styles: { width: '320px', height: '640px' }, type: 'mobile' } } },
  },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(320);
    // Under 640 px the outcome sits on its own line, under the words, lined up with them.
    const words = canvas.getByText('Verified customers · Up to $10,000');
    const button = canvas.getByRole('button', { name: /^Automatic up to \$10,000; over \$10,000, ask me first\./ });
    await expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(words.getBoundingClientRect().bottom);
    await expect(Math.round(button.getBoundingClientRect().left)).toBe(Math.round(words.getBoundingClientRect().left));
    // The phrase wraps inside the button, and nothing scrolls sideways.
    await expect(button.getBoundingClientRect().height).toBeGreaterThan(32);
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};

export const NarrowColumn: Story = {
  args: { rule: refund, words: rivera.ruleWords['rv-refund'], limit: undefined },
  render: (args) => (
    <div style={{ width: 560 }}>
      <RuleRow {...args} />
    </div>
  ),
  parameters: {
    canvas: 'none',
    canvasNote: 'A row under 640 px wide, as on a phone or in a side panel: the outcome on its own line. No board on this branch draws the Rules page on a phone (its phone board is checked where the presets are built); the nearest is N-Conn-24-Phone-Connectors.',
  },
  play: async ({ canvas }) => {
    // Under 640 px of its own width, even a short outcome sits on its own line under the words.
    const words = canvas.getByText('The customer who paid, verified');
    const button = canvas.getByRole('button', { name: /^Ask me first\. Change the outcome of:/ });
    await expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(words.getBoundingClientRect().bottom);
    await expect(Math.round(button.getBoundingClientRect().left)).toBe(Math.round(words.getBoundingClientRect().left));
    await expect(button.getBoundingClientRect().height).toBe(32);
  },
};
