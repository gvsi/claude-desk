import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { chen, rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { expectMockBesideExternalNames } from '../../test/expectMockBadges.ts';
import { ConnectorOfferCard } from './ConnectorOfferCard.tsx';

const meta = {
  title: 'Connectors/ConnectorOfferCard',
  component: ConnectorOfferCard,
  args: { ...chen.paymentsOffer, onReview: fn() },
  // As wide as the Ask Claude panel's conversation.
  render: (args) => (
    <div style={{ maxWidth: 350 }}>
      <ConnectorOfferCard {...args} />
    </div>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Conn-12-Chat',
    canvasNote:
      'The card names the always-on rule that covers both tools, where the board says no rule of the owner\'s covers them yet.',
  },
} satisfies Meta<typeof ConnectorOfferCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AddPayments: Story = {
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    // A card named by its connector: the tile, the name with "Built in", the tools and what covers them.
    const card = canvas.getByRole('article', { name: 'Payments' });
    expectComputed(card, { paddingTop: '16px', borderTopLeftRadius: '12px' });
    expectComputed(canvasElement.querySelector('.cd-connector-icon') as Element, { width: '36px' });
    await expect(within(card).getByText('Built in')).toBeVisible();
    await expect(within(card).getByText(args.toolsLine)).toBeVisible();
    await expect(within(card).getByText(chen.paymentsOffer.coverage)).toBeVisible();
    expectComputed(within(card).getByText(args.toolsLine), { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    // offer_card_only_opens_the_review: one button, which only opens the review.
    const buttons = within(card).getAllByRole('button');
    await expect(buttons).toHaveLength(1);
    await userEvent.click(within(card).getByRole('button', { name: 'Review and add' }));
    await expect(args.onReview).toHaveBeenCalledTimes(1);
    await expect(args.onReview).toHaveBeenCalledWith();
  },
};

export const Disconnect: Story = {
  args: {
    connector: rivera.connectors.views.stripe,
    toolsLine: '2 tools · See charges, Refund',
    coverage: undefined,
    action: 'disconnect',
  },
  parameters: {
    canvas: 'none',
    canvasNote: "Claude's card for disconnecting Turner's Stripe; no board draws it (nearest: N-Conn-12-Chat). It leads into the plain confirm, never past it.",
  },
  play: async ({ args, canvas, canvasElement, userEvent }) => {
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
    await userEvent.click(canvas.getByRole('button', { name: 'Review and disconnect' }));
    await expect(args.onReview).toHaveBeenCalledTimes(1);
  },
};

export const ComingSoon: Story = {
  args: chen.calendarOffer,
  parameters: {
    canvas: 'none',
    canvasNote: "Claude's card for a connector that is coming soon in the demo; no board draws it (nearest: N-Conn-12-Chat).",
  },
  play: async ({ canvas, canvasElement }) => {
    // offer_card_only_opens_the_review: coming soon has no button.
    await expect(canvas.getByText('Coming soon in this demo.')).toBeVisible();
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(expectMockBesideExternalNames(canvasElement)).toBe(1);
  },
};
