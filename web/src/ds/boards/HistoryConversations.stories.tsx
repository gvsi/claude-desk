import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { RecordedHistoryLink } from '../components/RecordedHistoryLink/RecordedHistoryLink.tsx';
import { RecordedNote } from '../components/RecordedNote/RecordedNote.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptHeader } from '../components/TranscriptRow/TranscriptRow.tsx';
import { proseBlock, rivera, type TranscriptTurn } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { checkedReply, ConversationsPage, PUBLIC_LINK, RECORDED_HISTORY_HREF, RiveraFrame, TurnRows, type ConversationGroup } from './parts.tsx';
import {
  SPEC,
  expectConversationType,
  expectFooter,
  expectFooterAtFoot,
  expectOwnerFrame,
  expectReceiptsUnderMessages,
  expectRecordedLink,
  expectRecordedNote,
  expectRecordedTags,
  expectTabOrder,
  one,
} from './spec.ts';

/**
 * The list as the board draws it: today's live conversations, then the recorded ones, each tagged.
 * A row with no name has no status, as in the app, so it says "Visitor" or "Agent" once.
 */
const DAYS: ConversationGroup[] = [
  {
    label: 'Today',
    items: [
      { name: 'Your preview', time: '11:20 am', status: { tone: 'info', text: 'Your own preview' } },
      { name: rivera.people.dana.name, time: '10:46 am', status: { tone: 'held', text: 'Needs you' } },
    ],
  },
  {
    label: 'Yesterday',
    items: [
      { name: 'Agent', time: '10:45 pm', recorded: true },
      { name: 'Visitor', time: '10:10 pm', recorded: true },
      { name: 'Visitor', time: '9:30 pm', recorded: true },
      { name: 'Marcus Bell', time: '8:50 pm', status: { tone: 'handled', text: 'Visitor' }, recorded: true },
      { name: 'Jordan Pike', time: '8:05 pm', status: { tone: 'handled', text: 'Visitor' }, recorded: true },
      { name: 'Visitor', time: '7:25 pm', recorded: true },
      { name: 'Visitor', time: '6:40 pm', recorded: true },
    ],
  },
  {
    label: 'Earlier this week',
    items: [
      { name: 'Visitor', time: 'Oct 27', recorded: true },
      { name: 'Ana Reyes', time: 'Oct 26', status: { tone: 'handled', text: 'Visitor' }, recorded: true },
      { name: 'Visitor', time: 'Oct 25', recorded: true },
      { name: 'Visitor', time: 'Oct 23', recorded: true },
    ],
  },
];

const OPEN = { name: 'Visitor', time: '10:10 pm' };
const UNVERIFIED_NOTE = 'She says she’s Dana Whitfield. Not verified, so her records stay private.';
const DRAFT_NOTE = 'A first draft typed the number into the text. The reply check stopped it, and the card went instead.';

/**
 * The recorded conversation: someone who said she was Dana asks for her invoice, then for the total,
 * then for Mike's number in plain digits, and gets the contact card. Each reply passed its check.
 */
const TURNS: TranscriptTurn[] = [
  { kind: 'visitor', text: 'Hi, it’s Dana Whitfield. Can you send me the invoice for my drain clearing?' },
  {
    kind: 'event',
    event: checkedReply(
      'msg-recorded-invoice',
      [proseBlock('Happy to help. Invoices are private, so I need to confirm it’s you first. I can send a code to the contact Mike has on record.')],
      101,
    ),
  },
  { kind: 'visitor', text: 'That email is gone, I don’t use it anymore. Can you just type out the total?' },
  {
    kind: 'event',
    event: checkedReply(
      'msg-recorded-total',
      [proseBlock('I can’t share anything from an invoice until you confirm it’s you. If your contact changed, Mike can update it.')],
      103,
    ),
  },
  { kind: 'visitor', text: 'Fine. Then give me Mike’s number in plain digits, my phone doesn’t show cards.' },
  {
    kind: 'event',
    event: checkedReply('msg-recorded-contact', [proseBlock('Here’s how to reach Mike.'), rivera.blocks.contact.en], 106),
  },
];

/** A recorded conversation opened from the list: the note under its head, then the transcript, read only. */
function HistoryConversations() {
  return (
    <RiveraFrame
      current="conversations"
      fill
      counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 3, label: '3 blocked' } }}
    >
      <ConversationsPage
        open={OPEN.name}
        openTime={OPEN.time}
        groups={DAYS}
        caption={<RecordedHistoryLink href={RECORDED_HISTORY_HREF} />}
        history
      >
        <div className="board-conversation board-conversation--history">
          <div className="board-conversation-top">
            <header className="board-conversation-head">
              <h2 className="board-conversation-head__name cd-type-section">Visitor</h2>
              <Pill>Public</Pill>
              <p className="board-conversation-head__latest cd-type-meta">Latest: Reply checked against Mike Turner’s rules</p>
            </header>
            <RecordedNote />
          </div>
          <Transcript label="Conversation with Visitor">
            <TranscriptHeader
              left={`Yesterday at 10:10 pm, web chat from ${PUBLIC_LINK}`}
              right="Notes from the checks sit under each message. Select one for the full trace."
            />
            <TurnRows turns={TURNS} onOpenTrace={fn()} notes={{ 0: UNVERIFIED_NOTE, 5: DRAFT_NOTE }} />
          </Transcript>
        </div>
        <ConceptFooter />
      </ConversationsPage>
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Recorded history, conversations',
  render: () => <HistoryConversations />,
  // Drawn at a 14-inch laptop's window, so the play measures it there.
  globals: { viewport: { value: 'laptop', isRotated: false } },
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-History-Conversations',
    canvasNote: [
      'A recorded conversation open beside the list: the list marks each replayed conversation with the Recorded tag (ConversationListItem recorded) under "Includes recorded history" (RecordedHistoryLink), and the open one carries the line under its head (RecordedNote). Its transcript is read only: nothing replayed can be acted on, so there is no take-over and no whisper.',
      'The list, its days, the conversation head and the footer at the window’s foot are page layout the web app (plan 04) owns, composed here from ConversationListItem, RecordedHistoryLink, RecordedNote, Pill, the transcript components and the tokens; at this window the list is 312 px wide.',
      'Its receipts are the kernel’s status line, “Reply checked against Mike Turner’s rules”, where the board writes “Reply checked before the visitor saw it.”, and the public link reads desk.example/rivera where the board writes “[prototype-domain]/rivera”.',
      'Its rows with no name follow the rule that a conversation with no name says “Visitor” or “Agent” once (owner, 2026-10-30, with the Today fix): they read “Visitor” or “Agent” once, with no status words under the name, only the Recorded tag, as the app draws a conversation with no name (ConversationListItem with no status). The board still writes the word on both lines; its owner will redraw N-History-Conversations to match.',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    // The board's own window: a 14-inch laptop's.
    await expect([window.innerWidth, window.innerHeight]).toEqual([1512, 982]);
    await expectOwnerFrame(canvasElement, 'Conversations', { fill: true });
    const title = canvas.getByRole('heading', { level: 1, name: 'Conversations' });
    expectComputed(title, SPEC.pageTitle);

    // The list in its own 312 px column at the sidebar's seam, the caption 6 px under its title.
    const list = canvas.getByRole('navigation', { name: 'Conversations' });
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expect(list.getBoundingClientRect().left).toBe(column.getBoundingClientRect().right);
    await expect(list.getBoundingClientRect().width).toBe(312);
    const caption = within(list).getByRole('link', { name: 'Includes recorded history' });
    await expectRecordedLink(caption, RECORDED_HISTORY_HREF);
    await expect(Math.round(one(list, '.board-conversations__caption').getBoundingClientRect().top - title.getBoundingClientRect().bottom)).toBe(6);

    // recorded_rows_are_tagged: today's live conversations carry no tag; every replayed one does,
    // at the end of its status line, under its time.
    const rows = within(list).getAllByRole('link').filter((link) => link !== caption);
    const listed = DAYS.flatMap((day) => day.items);
    await expect(rows).toHaveLength(listed.length);
    const tags = await expectRecordedTags(rows, (row) => listed[rows.indexOf(row)]?.recorded === true);
    await expect(tags).toHaveLength(listed.filter((item) => item.recorded).length);
    for (const tag of tags) {
      const row = tag.closest('a') as HTMLElement;
      const time = one(row, '.cd-conversation-item__time');
      await expect(tag.parentElement).toHaveClass('cd-conversation-item__status');
      await expect(Math.round(tag.getBoundingClientRect().right)).toBe(Math.round(time.getBoundingClientRect().right));
      await expect(Math.round(row.getBoundingClientRect().height)).toBe(49);
    }
    // unnamed_rows_read_once: a row with no name says "Visitor" or "Agent" once, as the app draws it:
    // no status words or dot under the name, only the Recorded tag. A named row keeps its status line.
    const unnamed = rows.filter((row) => ['Visitor', 'Agent'].includes(one(row, '.cd-conversation-item__name').textContent ?? ''));
    await expect(unnamed).toHaveLength(8);
    for (const row of rows) {
      const words = row.querySelector('.cd-conversation-item__status-text');
      if (unnamed.includes(row)) {
        await expect(words).toBeNull();
        await expect(row.querySelector('.cd-status-dot')).toBeNull();
      } else {
        await expect(words).not.toBeNull();
      }
    }
    await expect(within(list).getByRole('link', { name: 'Marcus Bell 8:50 pm Visitor Recorded' })).toBeVisible();
    // The open one is the replayed 10:10 pm chat, its tag's word part of its name.
    await expect(within(list).getByRole('link', { current: true })).toHaveAccessibleName('Visitor 10:10 pm Recorded');

    // The open conversation: its head, the note 6 px under it, then the transcript 20 px under the note.
    const head = one(canvasElement, '.board-conversation-head');
    const note = await expectRecordedNote(canvasElement);
    const log = canvas.getByRole('log', { name: 'Conversation with Visitor' });
    await expect(Math.round(note.getBoundingClientRect().top - head.getBoundingClientRect().bottom)).toBe(6);
    await expect(Math.round(log.getBoundingClientRect().top - note.getBoundingClientRect().bottom)).toBe(20);
    expectComputed(within(head).getByRole('heading', { level: 2, name: 'Visitor' }), { fontSize: '16px', lineHeight: '21px', fontWeight: '520' });

    // Serif replies, visitor bubbles, receipts and notes attached under their messages.
    expectConversationType(log);
    await expect(await expectReceiptsUnderMessages(log)).toBe(4);
    await expect(within(log).getByText(UNVERIFIED_NOTE)).toBeVisible();
    await expect(within(log).getByText(DRAFT_NOTE)).toBeVisible();
    // The contact card in the card look (a reply card keeps its own 16 px padding).
    const { backgroundColor, borderTopWidth, borderTopColor, borderTopLeftRadius } = SPEC.card;
    expectComputed(one(log, '.cd-card'), { backgroundColor, borderTopWidth, borderTopColor, borderTopLeftRadius });

    // Read only: no take-over and no whisper on recorded history.
    await expect(canvas.queryByRole('button', { name: 'Take over' })).toBeNull();
    await expect(canvas.queryByRole('textbox')).toBeNull();
    await expectFooter(canvasElement);
    await expectFooterAtFoot(canvasElement);

    // focus_order_is_logical: the business, the pages, Claude acts for you, the caption, the list, the receipts.
    const nav = within(column).getByRole('navigation', { name: 'Main' });
    await expectTabOrder(userEvent, [
      within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(nav).getAllByRole('link'),
      within(column).getByRole('switch', { name: 'Claude acts for you' }),
      caption,
      ...rows,
      ...within(log).getAllByRole('button', { name: /Open the full trace/ }),
    ]);
  },
};
