import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

import { rivera } from '../../fixtures/index.ts';
import { expectComputed } from '../../test/expectComputed.ts';
import { ConversationListItem, type ConversationListItemProps } from './ConversationListItem.tsx';

const meta = {
  title: 'Navigation/ConversationListItem',
  component: ConversationListItem,
  args: {
    name: rivera.conversations.danaLive.name,
    time: '12:04 pm',
    status: { tone: 'handled', text: 'Verified customer' },
    href: '#conversations/ses-dana-live',
  },
  // The board's list column: one link per conversation, in a list.
  render: (args: ConversationListItemProps) => (
    <ul style={{ width: 240, maxWidth: '100%', margin: 0, padding: 0, listStyle: 'none' }}>
      <li>
        <ConversationListItem {...args} />
      </li>
    </ul>
  ),
  parameters: {
    layout: 'padded',
    canvas: 'N-Conv-Run1',
    canvasNote:
      "The board's status lines are written per chat (\"Live, water heater\"); the screen's status says who is asking or what needs the owner, from one table, and the time is the screen's own string.",
  },
} satisfies Meta<typeof ConversationListItem>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Live: Story = {
  args: { current: true },
  play: async ({ args, canvas }) => {
    // One link to the conversation, named by who, when and its status.
    const link = canvas.getByRole('link', { name: 'Dana Whitfield 12:04 pm Verified customer' });
    await expect(link).toHaveAttribute('href', args.href);

    // The open conversation is marked current, on the selected fill.
    await expect(link).toHaveAttribute('aria-current', 'true');
    expectComputed(link, { backgroundColor: 'rgb(60, 57, 47)', borderTopLeftRadius: '8px', minHeight: '48px' });

    // The name is someone's own, in control type; the time and status in caption type, secondary.
    const name = canvas.getByText('Dana Whitfield');
    await expect(name).toHaveAttribute('data-copy', 'user');
    expectComputed(name, { fontSize: '14px', fontWeight: '420', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(canvas.getByText('12:04 pm'), { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)', fontVariantNumeric: 'tabular-nums' });

    // Status is words beside a dot, never the dot alone.
    const status = canvas.getByText('Verified customer');
    expectComputed(status, { fontSize: '12px', color: 'rgba(250, 249, 245, 0.64)' });
    const dot = status.parentElement?.querySelector('.cd-status-dot');
    await expect(dot).toHaveClass('cd-status-dot--handled');
    await expect(dot).toHaveAttribute('aria-hidden', 'true');
  },
};

export const NeedsYou: Story = {
  args: { name: 'Visitor', time: '10:58 am', status: { tone: 'held', text: 'Needs you' } },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: 'Visitor 10:58 am Needs you' });
    await expect(link).not.toHaveAttribute('aria-current');
    expectComputed(link, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    const dot = canvas.getByText('Needs you').parentElement?.querySelector('.cd-status-dot');
    await expect(dot).toHaveClass('cd-status-dot--held');
  },
};

export const Agent: Story = {
  args: {
    name: rivera.conversations.alexAgent.name,
    time: '11:42 am',
    status: { tone: 'info', text: 'Agent' },
  },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: "Alex Kim's assistant 11:42 am Agent" });
    await expect(link).not.toHaveAttribute('aria-current');
    const dot = canvas.getByText('Agent').parentElement?.querySelector('.cd-status-dot');
    await expect(dot).toHaveClass('cd-status-dot--info');

    // A long name ends in an ellipsis on its one line; the time keeps its place.
    const name = canvas.getByText(rivera.conversations.alexAgent.name);
    expectComputed(name, { textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflowX: 'hidden' });
    await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);
  },
};
