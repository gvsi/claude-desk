import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { ToolChangedItem } from './ToolChangedItem.tsx';

const { changedRefund } = rivera;

const meta = {
  title: 'Connectors/ToolChangedItem',
  component: ToolChangedItem,
  args: {
    connector: changedRefund.connector,
    tool: changedRefund.tool,
    noticed: changedRefund.noticedToday,
    consequence: changedRefund.consequence,
    onReview: fn(),
  },
  render: (args) => (
    <div style={{ maxWidth: 960 }}>
      <ToolChangedItem {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-13-Changed-Today' },
} satisfies Meta<typeof ToolChangedItem>;

export default meta;

type Story = StoryObj<typeof meta>;

export const StripeRefund: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // tool_changed_item_says_what_and_why: a card with a held dot, what changed, and why it matters.
    const title = "Stripe changed “Refund”, so it's off until you review it.";
    const card = canvas.getByRole('article', { name: title });
    expectComputed(card, { paddingTop: '16px', borderTopLeftRadius: '12px' });
    const titleLine = within(card).getByText(title);
    expectComputed(titleLine, { fontSize: '15px', color: 'rgba(250, 249, 245, 0.92)' });
    const dot = card.querySelector('.cd-status-dot--held');
    await expect(dot).not.toBeNull();
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
    // The meta line names the connector as a mock, when it was noticed, and what can't happen.
    const meta = within(card).getByText(`Stripe · Mock · ${args.noticed}. ${args.consequence}`);
    expectComputed(meta, { fontSize: '14px', color: 'rgba(250, 249, 245, 0.64)' });
    // "Review" opens the tool's page.
    await userEvent.click(within(card).getByRole('button', { name: 'Review' }));
    await expect(args.onReview).toHaveBeenCalledTimes(1);
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone', isRotated: false } },
  parameters: { canvasNote: "Today's item on a phone; no board draws it. The button drops under the words." },
  play: async ({ canvas, canvasElement }) => {
    const width = window.innerWidth;
    await expect(width).toBe(390);
    const review = canvas.getByRole('button', { name: 'Review' });
    const meta = canvas.getByText(/^Stripe · Mock/);
    await expect(review.getBoundingClientRect().top).toBeGreaterThanOrEqual(meta.getBoundingClientRect().bottom);
    const tooWide = [...canvasElement.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width);
    await expect(tooWide).toEqual([]);
  },
};
