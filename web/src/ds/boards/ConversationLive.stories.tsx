import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Composer } from '../components/Composer/Composer.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { TakeOverBar } from '../components/TakeOverBar/TakeOverBar.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptHeader, TranscriptRow } from '../components/TranscriptRow/TranscriptRow.tsx';
import { WritingIndicator } from '../components/WritingIndicator/WritingIndicator.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { ConversationsPage, PUBLIC_LINK, RiveraFrame, TurnRows } from './parts.tsx';
import { SPEC, expectConversationType, expectFooter, expectOwnerFrame, expectReceiptsUnderMessages, expectTabOrder, one } from './spec.ts';

const dana = rivera.conversations.danaLive;
const DANA = rivera.people.dana.name;
const WHISPER_NOTE = 'Dana never sees whispers. Your rules still apply to what Claude does with them.';
const whisperAt = dana.turns.findIndex((turn) => turn.kind === 'whisper');

/** Dana's live chat as Mike watches it: the list beside it, the checks under each message, and his controls. */
function ConversationLive() {
  return (
    <RiveraFrame
      current="conversations"
      fill
      counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } }}
    >
      <ConversationsPage open={DANA}>
        <div className="board-conversation">
          <header className="board-conversation-head">
            <h2 className="board-conversation-head__name cd-type-section" data-copy="user">
              {DANA}
            </h2>
            <Pill>Public</Pill>
            <p className="board-conversation-head__latest cd-type-meta">Latest: Booked for Tuesday</p>
          </header>
          <Transcript label={`Conversation with ${DANA}`}>
            <TranscriptHeader
              left={`Today at 12:04 pm, web chat from ${PUBLIC_LINK}`}
              right="Notes from the checks sit under each message. Select one for the full trace."
            />
            <TurnRows
              turns={dana.turns}
              onOpenTrace={fn()}
              whisperCaption="Your whisper, 12:08 pm. Only Claude sees this."
              notes={{ [whisperAt]: WHISPER_NOTE }}
              checks={['dec-dana-book']}
            />
            <TranscriptRow>
              <WritingIndicator language="en" variant="bubble" who="Dana" />
            </TranscriptRow>
          </Transcript>
          <TakeOverBar mode="ai" visitorName={DANA} ownerName={rivera.business.ownerName} onTakeOver={fn()} onHandBack={fn()} onResume={fn()} />
          <Composer variant="whisper" label="Whisper to Claude" placeholder="Whisper to Claude. Dana won’t see it." onSend={fn()} />
          <ConceptFooter />
        </div>
      </ConversationsPage>
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Conversation, live',
  render: () => <ConversationLive />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Conv-Run1',
    canvasNote: [
      "The conversation is the Turner fixture's live chat with Dana: a drain, a quote, a whisper, open times and a booking, where the board has a water heater, a leak repair quote, a booking with a sooner time, and then a discount held for Mike's answer in the chat.",
      'Its receipts are the kernel’s status lines from the fixture, attached under each message on its side; the board writes some in owner wording.',
      '"Dana is typing" is the signed typing bubble (N-Typing-Bubble-Run1) where the board writes a line.',
      'The list column, the conversation head and its "Latest" line are page layout the web app (plan 04) owns, composed here from ConversationListItem, Pill and the tokens; the page fills the main area (AppShell fill), so the list starts where the sidebar ends.',
      'In the app, from 1024 px the list grows with the window, 24% of it between 280 and 400 px (board REV-CNVW B); this board keeps its own fixed column.',
      'The sidebar is the panel with its seam and the Claude acts for you switch at its foot, as on Today (owner decision 2026-10-29: one sidebar look on every page; the conversation boards are drawn with the one sidebar).',
    ].join(' '),
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Board: Story = {
  play: async ({ canvas, canvasElement, userEvent }) => {
    await expectOwnerFrame(canvasElement, 'Conversations', { fill: true });
    expectComputed(canvas.getByRole('heading', { level: 1, name: 'Conversations' }), SPEC.pageTitle);
    // The open conversation's name, in the section style the board sets it in.
    expectComputed(canvas.getByRole('heading', { level: 2, name: DANA }), { fontSize: '16px', lineHeight: '21px', fontWeight: '520' });

    // The list column at the sidebar's seam, the open conversation marked in it.
    const list = canvas.getByRole('navigation', { name: 'Conversations' });
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expect(list.getBoundingClientRect().left).toBe(column.getBoundingClientRect().right);
    const current = within(list).getByRole('link', { current: true });
    await expect(current).toHaveTextContent(DANA);

    // The conversation: serif replies, visitor bubbles, receipts attached under their messages.
    const log = canvas.getByRole('log', { name: `Conversation with ${DANA}` });
    expectConversationType(log);
    await expect(await expectReceiptsUnderMessages(log)).toBeGreaterThanOrEqual(3);
    await expect(within(log).getByText(WHISPER_NOTE)).toBeVisible();
    await expect(within(log).getByRole('status')).toHaveTextContent('Dana is typing');

    // Mike's controls while Claude answers: Take over, then the whisper composer.
    const takeOver = canvas.getByRole('button', { name: 'Take over' });
    const whisper = canvas.getByRole('textbox', { name: 'Whisper to Claude' });
    expectComputed(one(canvasElement, '.cd-composer__box'), SPEC.composer);
    await expect(whisper.getBoundingClientRect().top).toBeGreaterThan(takeOver.getBoundingClientRect().bottom);
    await expectFooter(canvasElement);

    // focus_order_is_logical: the business, the pages, the list, the receipts, Take over, the composer.
    const nav = within(column).getByRole('navigation', { name: 'Main' });
    const receipts = within(log).getAllByRole('button', { name: /Open the full trace/ });
    await expectTabOrder(userEvent, [
      within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(nav).getAllByRole('link'),
      within(column).getByRole('switch', { name: 'Claude acts for you' }),
      ...within(list).getAllByRole('link'),
      ...receipts,
      takeOver,
      whisper,
    ]);
  },
};
