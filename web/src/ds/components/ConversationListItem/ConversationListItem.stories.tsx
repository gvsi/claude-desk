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
    await expect(link).not.toHaveClass('cd-conversation-item--unread');
    await expect(link.querySelector('.cd-conversation-item__unread-dot')).toBeNull();
    await expect(canvas.queryByText('Unread:')).toBeNull();
    expectComputed(link, { paddingLeft: '26px' });
    expectComputed(link, { backgroundColor: 'rgb(60, 57, 47)', borderTopLeftRadius: '8px', minHeight: '48px' });

    // The name is someone's own, in control type; the time and status in caption type, secondary.
    const name = canvas.getByText('Dana Whitfield');
    await expect(name).toHaveAttribute('data-copy', 'user');
    expectComputed(name, { fontSize: '15px', fontWeight: '420', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(canvas.getByText('12:04 pm'), { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)', fontVariantNumeric: 'tabular-nums' });

    // Status is words beside a dot, never the dot alone.
    const status = canvas.getByText('Verified customer');
    expectComputed(status, { fontSize: '13px', color: 'rgba(250, 249, 245, 0.64)' });
    const dot = status.parentElement?.querySelector('.cd-status-dot');
    await expect(dot).toHaveClass('cd-status-dot--handled');
    await expect(dot).toHaveAttribute('aria-hidden', 'true');

    // A live conversation carries no Recorded tag.
    await expect(canvas.queryByText('Recorded')).toBeNull();
  },
};

export const NeedsYou: Story = {
  args: { name: 'Visitor', time: '10:58 am', status: { tone: 'held', text: 'Needs you' }, recorded: false },
  play: async ({ canvas }) => {
    // Not recorded: no tag, and nothing more in the row's name.
    const link = canvas.getByRole('link', { name: 'Visitor 10:58 am Needs you' });
    await expect(canvas.queryByText('Recorded')).toBeNull();
    await expect(link.querySelector('.cd-recorded-tag')).toBeNull();
    await expect(link).not.toHaveAttribute('aria-current');
    expectComputed(link, { backgroundColor: 'rgba(0, 0, 0, 0)' });
    const dot = canvas.getByText('Needs you').parentElement?.querySelector('.cd-status-dot');
    await expect(dot).toHaveClass('cd-status-dot--held');
  },
};

export const Unread: Story = {
  args: {
    name: 'Visitor', time: '10:58 am', unread: true,
    status: { tone: 'held', text: 'Needs you' },
    quote: 'How much to clear a clogged drain? Can I get 15% off if I pay cash?',
  },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: /^Unread: Visitor/ });
    await expect(link).toHaveClass('cd-conversation-item--unread');
    await expect(link.querySelector('.cd-conversation-item__unread-dot')).toHaveAttribute('aria-hidden', 'true');
    await expect(canvas.getByText('Unread:')).toHaveClass('cd-sr-only');
    expectComputed(link, { paddingLeft: '26px', position: 'relative', backgroundColor: 'rgba(250, 249, 245, 0.06)' });
    expectComputed(link.querySelector('.cd-conversation-item__unread-dot')!, {
      width: '10px', height: '10px', borderRadius: '50%', left: '10px', top: '13px',
      backgroundColor: 'rgb(126, 174, 218)',
    });
    expectComputed(canvas.getByText('Visitor'), { fontWeight: '600', color: 'rgba(250, 249, 245, 0.92)' });
    expectComputed(canvas.getByText('10:58 am'), { fontWeight: '520', color: 'rgb(126, 174, 218)' });
    expectComputed(link.querySelector('.cd-conversation-item__quote')!, { color: 'rgba(250, 249, 245, 0.92)' });
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

export const Unnamed: Story = {
  args: { name: 'Visitor', time: '12:06 pm', status: undefined },
  parameters: {
    canvas: 'none',
    canvasNote:
      'Nearest board N-Conv-Run1. A visitor who gave no name: the name line already says "Visitor", so the row has no status line rather than say it twice.',
  },
  play: async ({ canvas }) => {
    // One line, named by who and when; no status words and no dot alone.
    const link = canvas.getByRole('link', { name: 'Visitor 12:06 pm' });
    await expect(canvas.getAllByText('Visitor')).toHaveLength(1);
    await expect(link.querySelector('.cd-status-dot')).toBeNull();
    // The row keeps its height, its one line centered in it.
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(48);
    const name = canvas.getByText('Visitor').getBoundingClientRect();
    const row = link.getBoundingClientRect();
    await expect(Math.abs(name.top - row.top - (row.bottom - name.bottom))).toBeLessThanOrEqual(2);
  },
};

export const UnnamedRecorded: Story = {
  args: { name: 'Visitor', time: '10:10 pm', status: undefined, href: '#conversations/ses-recorded-2', recorded: true },
  parameters: {
    canvas: 'N-History-Conversations',
    canvasNote: 'The board writes "Visitor" on both lines; with no name the status is left out, and the Recorded tag keeps its place at the line’s end.',
  },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: 'Visitor 10:10 pm Recorded' });
    await expect(canvas.getAllByText('Visitor')).toHaveLength(1);
    await expect(link.querySelector('.cd-status-dot')).toBeNull();
    // Under the time, at the line's end, as on a row with a status.
    const tag = canvas.getByText('Recorded');
    const time = canvas.getByText('10:10 pm');
    await expect(Math.round(tag.getBoundingClientRect().right)).toBe(Math.round(time.getBoundingClientRect().right));
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(51);
  },
};

export const Recorded: Story = {
  args: {
    name: 'Visitor',
    time: '10:10 pm',
    status: { tone: 'handled', text: 'Visitor who asked for the number in plain digits' },
    href: '#conversations/ses-recorded-1',
    recorded: true,
  },
  parameters: {
    canvas: 'N-History-Conversations',
    canvasNote:
      'A replayed conversation, as the board marks it: the Recorded tag at the end of the status line. The status here is longer than the board\'s "Visitor", to show the words giving way to the tag.',
  },
  play: async ({ canvas }) => {
    // The tag is part of the row's one link, so a screen reader hears it with the status.
    const link = canvas.getByRole('link', { name: 'Visitor 10:10 pm Visitor who asked for the number in plain digits Recorded' });
    const tag = canvas.getByText('Recorded');
    await expect(tag).toHaveTextContent(/^Recorded$/);
    await expect(tag.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expectComputed(tag, { fontSize: '13px', lineHeight: '18px', color: 'rgba(250, 249, 245, 0.64)', whiteSpace: 'nowrap' });

    // On the status line, after the words, pushed to its end: level with the time above it.
    const status = canvas.getByText('Visitor who asked for the number in plain digits');
    const time = canvas.getByText('10:10 pm');
    await expect(tag.parentElement).toBe(status.parentElement);
    await expect(Math.round(tag.getBoundingClientRect().right)).toBe(Math.round(time.getBoundingClientRect().right));
    await expect(tag.getBoundingClientRect().left).toBeGreaterThan(status.getBoundingClientRect().right);

    // The status words ellipsize first; the tag keeps its whole width and the row never scrolls.
    expectComputed(status, { textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflowX: 'hidden' });
    await expect(status.scrollWidth).toBeGreaterThan(status.clientWidth);
    await expect(tag.scrollWidth).toBeLessThanOrEqual(tag.clientWidth);
    await expect(Math.round(tag.getBoundingClientRect().width)).toBeGreaterThanOrEqual(Math.round(tag.scrollWidth));
    await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);

    // The line keeps its height: the 14 px icon sits inside the caption's 18 px line.
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(51);
  },
};

export const Quoted: Story = {
  args: { name: 'Visitor', time: '1:55 am', status: undefined, quote: 'Tuesday at 2 works.' },
  parameters: {
    canvas: 'none',
    canvasNote: 'P8-02, UXC-P802-After (#artboard-a4106a75e939): Today’s Live now quotes what an unnamed visitor last wrote, under who it is.',
  },
  play: async ({ canvas }) => {
    // The quote is part of the row's one link, after who and when.
    const link = canvas.getByRole('link', { name: 'Visitor 1:55 am “Tuesday at 2 works.”' });
    await expect(link.querySelector('.cd-status-dot')).toBeNull();

    // Their own words, quoted, in meta type and secondary.
    const quote = canvas.getByText('“Tuesday at 2 works.”');
    await expect(quote).toHaveAttribute('data-copy', 'user');
    await expect(quote).toHaveClass('cd-type-meta');
    expectComputed(quote, { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)', marginTop: '2px' });

    // Under the first line, 2 px down from it and at its left edge; the row grows to hold it.
    const top = link.querySelector('.cd-conversation-item__top')?.getBoundingClientRect();
    await expect(Math.round(quote.getBoundingClientRect().top - (top?.bottom ?? 0))).toBe(2);
    await expect(Math.round(quote.getBoundingClientRect().left)).toBe(Math.round(top?.left ?? -1));
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(54);
  },
};

export const QuotedLong: Story = {
  args: {
    name: rivera.conversations.danaLive.name.repeat(8),
    time: '1:55 am',
    status: undefined,
    quote: '<b>Can someone come today?</b> The water is up to the kitchen door and the shutoff under the sink won’t turn.',
  },
  parameters: {
    canvas: 'none',
    canvasNote: 'Nearest board UXC-P802-After (#artboard-a4106a75e939). A longer message, which may look like markup: it shows as written, on one line that ends in an ellipsis.',
  },
  play: async ({ args, canvasElement }) => {
    // Untrusted words are text, never markup.
    const quote = canvasElement.querySelector('.cd-conversation-item__quote');
    await expect(quote?.textContent).toBe(`“${args.quote ?? ''}”`);
    await expect(quote?.querySelector('b')).toBeNull();

    // One line, ellipsized, and the row never scrolls sideways.
    expectComputed(quote!, { whiteSpace: 'nowrap', overflowX: 'hidden', textOverflow: 'ellipsis' });
    await expect(quote!.scrollWidth).toBeGreaterThan(quote!.clientWidth);
    const link = canvasElement.querySelector('a')!;
    await expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth);
    const name = link.querySelector('.cd-conversation-item__name')!;
    await expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    const time = link.querySelector('.cd-conversation-item__time')!;
    await expect(Math.round(time.getBoundingClientRect().right)).toBe(Math.round(quote!.getBoundingClientRect().right));
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(54);
  },
};

export const AgentLine: Story = {
  args: {
    name: rivera.conversations.alexAgent.name,
    time: '11:42 am',
    status: { tone: 'info', text: 'Agent · Visit booked' },
    line: 'Booked Mon, Nov 2, 10:00 am.',
  },
  parameters: {
    canvas: 'none',
    canvasNote: 'Nearest board N-Conv-Run1. What an agent did sits where a visitor’s words would, without quotes: it is the app’s line, not the agent’s.',
  },
  play: async ({ canvas }) => {
    // The line joins the link's name between who and when and the status.
    const link = canvas.getByRole('link', { name: "Alex Kim's assistant 11:42 am Booked Mon, Nov 2, 10:00 am. Agent · Visit booked" });

    // The app's words, unquoted and not marked as someone's own, drawn as the quote is.
    const line = canvas.getByText('Booked Mon, Nov 2, 10:00 am.', { exact: true });
    await expect(line).toHaveClass('cd-conversation-item__quote');
    await expect(line).toHaveClass('cd-type-meta');
    await expect(line).not.toHaveAttribute('data-copy');
    expectComputed(line, { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)', marginTop: '2px', whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontStyle: 'normal' });

    // Under the first line and above the status, as the quote sits; the row grows to hold both.
    const top = link.querySelector('.cd-conversation-item__top')?.getBoundingClientRect();
    await expect(Math.round(line.getBoundingClientRect().top - (top?.bottom ?? 0))).toBe(2);
    const status = canvas.getByText('Agent · Visit booked').parentElement!;
    await expect(status.getBoundingClientRect().top).toBe(line.getBoundingClientRect().bottom);
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(72);
  },
};

export const QuoteOverLine: Story = {
  args: { name: 'Visitor', time: '1:55 am', status: undefined, quote: 'Tuesday at 2 works.', line: 'A request was turned down.' },
  parameters: { canvas: 'none', canvasNote: 'Given both, the person’s own words win: the row has one preview line.' },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('link', { name: 'Visitor 1:55 am “Tuesday at 2 works.”' })).toBeVisible();
    await expect(canvas.queryByText('A request was turned down.')).toBeNull();
    await expect(canvasElement.querySelectorAll('.cd-conversation-item__quote')).toHaveLength(1);
  },
};

export const BlankLine: Story = {
  args: { name: 'Agent', time: '11:42 am', status: undefined, quote: '   ', line: '   ' },
  parameters: { canvas: 'none', canvasNote: 'Blank previews leave the row with its name and time alone.' },
  play: async ({ canvas, canvasElement }) => {
    const link = canvas.getByRole('link', { name: 'Agent 11:42 am' });
    await expect(canvasElement.querySelector('.cd-conversation-item__quote')).toBeNull();
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(48);
  },
};

export const StatusOverLine: Story = {
  args: { name: 'Agent', time: '11:42 am', status: { tone: 'held', text: 'Needs you' }, line: 'Paid $20 up front.', quoteWithStatus: false },
  parameters: { canvas: 'none', canvasNote: 'The two-line layout gives status the preview’s place for an app line too.' },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('link', { name: 'Agent 11:42 am Needs you' })).toBeVisible();
    await expect(canvasElement.querySelector('.cd-conversation-item__quote')).toBeNull();
  },
};

export const StatusOverQuote: Story = {
  args: { name: 'Visitor', time: '10:58 am', status: { tone: 'held', text: 'Needs you' }, quote: 'Can I get 15% off if I pay cash?', quoteWithStatus: false },
  parameters: {
    canvas: 'none',
    canvasNote: 'Nearest board UXC-P802-After (#artboard-a4106a75e939): a held conversation keeps "Needs you" in its place, so status wins over the quote.',
  },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('link', { name: 'Visitor 10:58 am Needs you' })).toBeVisible();
    await expect(canvas.queryByText(/15% off/)).toBeNull();
    await expect(canvasElement.querySelector('.cd-conversation-item__quote')).toBeNull();
  },
};

export const PreviewWithStatus: Story = {
  args: { name: 'Visitor', time: '10:58 am', status: { tone: 'held', text: 'Needs you' }, quote: 'Can I get 15% off if I pay cash?', recorded: true },
  parameters: { canvas: 'none', canvasNote: 'Conversations keeps the visitor preview above status and the Recorded tag.' },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: 'Visitor 10:58 am “Can I get 15% off if I pay cash?” Needs you Recorded' });
    const preview = canvas.getByText('“Can I get 15% off if I pay cash?”');
    const status = canvas.getByText('Needs you').parentElement!;
    expectComputed(preview, { fontSize: '14px', lineHeight: '19px', color: 'rgba(250, 249, 245, 0.64)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
    await expect(status.getBoundingClientRect().top).toBe(preview.getBoundingClientRect().bottom);
    await expect(canvas.getByText('Recorded').parentElement).toBe(status);
    await expect(Math.round(link.getBoundingClientRect().height)).toBe(72);
  },
};

/** A demo visitor's chat: the persona's first name, then its pill right after it, the time still at the right. */
export const DemoVisitor: Story = {
  args: {
    name: 'Riley',
    time: '11:02 pm',
    demoVisitor: true,
    quote: "Yes please. Is anything sooner open? There's water on the floor.",
    status: { tone: 'handled', text: 'Quoted' },
  },
  parameters: {
    canvas: 'none',
    canvasNote: 'The REV-DEMO boards in review (N-Live-REV-DEMO-chat-1512, #artboard-4ae3b66fd4f0): a demo visitor\'s row, its "Demo visitor" pill right after the name on the top line.',
  },
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: /^Riley Demo visitor 11:02 pm/ });
    const name = canvas.getByText('Riley');
    const pill = canvas.getByText('Demo visitor');
    await expect(name.nextElementSibling).toBe(pill);
    await expect(Math.round(pill.getBoundingClientRect().left - name.getBoundingClientRect().right)).toBe(8);
    // The time stays at the row's right.
    const time = canvas.getByText('11:02 pm');
    const top = name.parentElement!;
    await expect(Math.round(top.getBoundingClientRect().right - time.getBoundingClientRect().right)).toBe(0);
    await expect(link).toBeVisible();
  },
};
