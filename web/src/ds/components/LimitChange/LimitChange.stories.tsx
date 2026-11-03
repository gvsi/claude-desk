import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { LimitChange } from './LimitChange.tsx';

const meta = {
  title: 'Rules/LimitChange',
  component: LimitChange,
  args: rivera.limitRaise,
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <LimitChange {...args} />
    </div>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Conn-20-Ceiling-Review',
    canvasNote:
      "The board sets the new limit at the serif's optical size 18; the summary style is optical size 20 on every summary line, so the line is about 2% narrower.",
  },
} satisfies Meta<typeof LimitChange>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Raise: Story = {
  play: async ({ args, canvas }) => {
    // limit_change_reads_both_amounts: one card says the new limit, then what it was.
    const card = canvas.getByRole('region', { name: 'Payment limit' });
    expectComputed(card, { paddingTop: '20px', paddingLeft: '20px', borderTopLeftRadius: '12px' });
    await expect(card.textContent).toBe(`${args.now}${args.was}`);
    const now = within(card).getByText(args.now);
    const was = within(card).getByText(args.was);
    // The new limit in Claude's serif, the old one in secondary meta at the right, on one baseline.
    expectComputed(now, { fontFamily: '"Source Serif 4", Georgia, serif', fontSize: '20px', lineHeight: '30px', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(was, { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)' });
    const row = now.parentElement;
    if (row === null || row !== was.parentElement) throw new Error('The amounts are not on one row');
    expectComputed(row, { alignItems: 'baseline' });
    const inner = card.getBoundingClientRect().right - 1 - 20;
    await expect(was.getBoundingClientRect().right).toBeCloseTo(inner, 0);
    await expect(was.getBoundingClientRect().left).toBeGreaterThan(now.getBoundingClientRect().right);
  },
};
