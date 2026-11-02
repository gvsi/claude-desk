import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, waitFor } from 'storybook/test';

import { rivera } from '../../fixtures';
import { expectComputed } from '../../test/expectComputed.ts';
import { OutcomeMenu } from './OutcomeMenu.tsx';

const link = rivera.ruleCards['rv-link'];
const shared = rivera.sharedChargeCard;

const meta = {
  title: 'Rules/OutcomeMenu',
  component: OutcomeMenu,
  args: { label: link.reason, value: 'auto', onChange: fn() },
  render: (args) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', maxWidth: 560, minHeight: 200 }}>
      <OutcomeMenu {...args} />
    </div>
  ),
  parameters: { layout: 'padded', canvas: 'N-Conn-02-Payments' },
} satisfies Meta<typeof OutcomeMenu>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The menu button as the boards draw it: 32 px, an outline in line-control, 8 px radius, no fill. */
const MENU_BUTTON = {
  height: '32px',
  borderTopWidth: '1px',
  borderTopColor: 'rgba(250, 249, 245, 0.22)',
  borderTopLeftRadius: '8px',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  paddingLeft: '12px',
  paddingRight: '10px',
  color: 'rgba(250, 249, 245, 0.92)',
  fontSize: '15px',
} as const;

export const ReadOnly: Story = {
  args: { onChange: undefined },
  play: async ({ canvas, canvasElement }) => {
    // outcome_read_only_without_on_change: the words and the dot, and no button.
    await expect(canvas.queryByRole('button')).toBeNull();
    await expect(canvas.getByText('Automatic')).toBeVisible();
    await expect(canvasElement.querySelector('.cd-status-dot--handled')).toHaveAttribute('aria-hidden', 'true');
  },
};

export const Automatic: Story = {
  play: async ({ args, canvas, userEvent }) => {
    // outcome_named_for_screen_readers
    const button = canvas.getByRole('button', {
      name: 'Automatic. Change the outcome of: Payment links up to $300, checked by the reviewer.',
    });
    expectComputed(button, MENU_BUTTON);
    await expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button.querySelector('.cd-status-dot--handled')).not.toBeNull();

    // outcome_menu_by_keyboard: Tab to the button, Enter opens the menu on its first item.
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const menu = canvas.getByRole('menu');
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const items = canvas.getAllByRole('menuitemradio');
    await expect(items.map((item) => item.textContent)).toEqual(['Automatic', 'Ask me first', 'Never']);
    await expect(canvas.getByRole('menuitemradio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'true');
    await expect(canvas.getByRole('menuitemradio', { name: 'Never' })).toHaveAttribute('aria-checked', 'false');
    await expect(items[0]).toHaveFocus();
    await expect(menu).toBeVisible();

    // Down twice, then Enter: Never, chosen once; the menu closes and focus is back on the button,
    // which still shows the outcome the screen passed, since a change applies only after review.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    await expect(canvas.getByRole('menuitemradio', { name: 'Never' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onChange).toHaveBeenCalledTimes(1);
    await expect(args.onChange).toHaveBeenCalledWith('never');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(button).toHaveFocus();
    await expect(button).toHaveTextContent('Automatic');

    // Open again, then Escape: closed, focus on the button, no call.
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('menu')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(button).toHaveFocus();
    await expect(args.onChange).toHaveBeenCalledTimes(1);

    // Up opens it on the last item; Down wraps to the first.
    await userEvent.keyboard('{ArrowUp}');
    await expect(canvas.getByRole('menuitemradio', { name: 'Never' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    await expect(canvas.getByRole('menuitemradio', { name: 'Automatic' })).toHaveFocus();
    // Tab closes it too, and gives focus back to the button.
    await userEvent.keyboard('{Tab}');
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(button).toHaveFocus();
    await expect(args.onChange).toHaveBeenCalledTimes(1);
  },
};

export const AutomaticWithLimit: Story = {
  args: { label: shared.reason, limit: '$20' },
  play: async ({ canvas }) => {
    // limit_reads_automatic_up_to: an auto card with an amount limit holds anything over it.
    const button = canvas.getByRole('button', {
      name: `Automatic up to $20; over $20, ask me first. Change the outcome of: ${shared.reason}`,
    });
    await expect(button).toHaveTextContent('Automatic up to $20; over $20, ask me first');
  },
};

export const AskMeFirst: Story = {
  args: { label: rivera.ruleCards['rv-refund'].reason, value: 'ask', limit: '$20' },
  play: async ({ args, canvas, userEvent }) => {
    // An ask card shows no limit, whatever the screen passes.
    const button = canvas.getByRole('button', { name: 'Ask me first. Change the outcome of: Refunds to a customer wait for your answer.' });
    await expect(button.querySelector('.cd-status-dot--held')).not.toBeNull();
    // A click opens it; picking the current word only closes it.
    await userEvent.click(button);
    await expect(canvas.getByRole('menuitemradio', { name: 'Ask me first' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(canvas.getByRole('menuitemradio', { name: 'Ask me first' }));
    await expect(canvas.queryByRole('menu')).toBeNull();
    await expect(args.onChange).not.toHaveBeenCalled();
    // A click outside closes it with no call.
    await userEvent.click(button);
    await expect(canvas.getByRole('menu')).toBeVisible();
    await userEvent.click(document.body);
    await waitFor(() => expect(canvas.queryByRole('menu')).toBeNull());
    await expect(args.onChange).not.toHaveBeenCalled();
  },
};

export const Never: Story = {
  args: { label: 'No bookings on Sundays.', value: 'never' },
  play: async ({ args, canvas, userEvent }) => {
    const button = canvas.getByRole('button', { name: 'Never. Change the outcome of: No bookings on Sundays.' });
    await expect(button.querySelector('.cd-status-dot--refused')).not.toBeNull();
    // A click on another word chooses it once.
    await userEvent.click(button);
    await userEvent.click(canvas.getByRole('menuitemradio', { name: 'Automatic' }));
    await expect(args.onChange).toHaveBeenCalledTimes(1);
    await expect(args.onChange).toHaveBeenCalledWith('auto');
    await expect(button).toHaveFocus();
  },
};
