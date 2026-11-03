import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';

import { Composer } from '../components/Composer/Composer.tsx';
import { ConceptFooter } from '../components/ConceptFooter/ConceptFooter.tsx';
import { Pill } from '../components/Pill/Pill.tsx';
import { SignedLimitPanel } from '../components/SignedLimitPanel/SignedLimitPanel.tsx';
import { StatusDot } from '../components/StatusDot/StatusDot.tsx';
import { TakeOverBar } from '../components/TakeOverBar/TakeOverBar.tsx';
import { Transcript } from '../components/Transcript/Transcript.tsx';
import { TranscriptHeader } from '../components/TranscriptRow/TranscriptRow.tsx';
import { rivera } from '../fixtures/index.ts';
import { expectComputed } from '../test/expectComputed.ts';
import { ConversationsPage, RiveraFrame, TurnRows } from './parts.tsx';
import { SPEC, expectConversationType, expectFooter, expectOwnerFrame, expectReceiptsUnderMessages, expectTabOrder, one } from './spec.ts';

const alex = rivera.conversations.alexAgent;
const SIGNED_NOTE = 'Signed with the assistant’s own key, checked before anything else.';
const firstRequest = alex.turns.findIndex((turn) => turn.kind === 'agent');

/** The screen's words for the agent's signed limit and what it has used, as the board writes them. */
const LIMIT = { perCharge: '$20', total: '$100', used: '$20', duration: 'One hour', source: 'Signed limit from Alex Kim’s demo wallet' } as const;

/** Alex Kim's assistant's signed requests as Mike reads them: its limit on top, each request on the right. */
function ConversationAgent() {
  return (
    <RiveraFrame
      current="conversations"
      fill
      counts={{ conversations: { n: 2, label: '2 need you' }, safety: { n: 2, label: '2 blocked' } }}
    >
      <ConversationsPage open={alex.name}>
        <div className="board-conversation">
          <header className="board-conversation-head">
            <h2 className="board-conversation-head__name cd-type-section" data-copy="user">
              {alex.name}
            </h2>
            <Pill>Agent</Pill>
            <Pill>
              <StatusDot tone="handled" />
              Signed
            </Pill>
            <p className="board-conversation-head__latest cd-type-meta">Latest: Deposit paid</p>
          </header>
          {/* The signed limit, in the screen's words from the mandate and the charges made on it; nothing here computes it. */}
          <div className="board-limit">
            <SignedLimitPanel {...LIMIT} language="en" />
          </div>
          <Transcript label={`Conversation with ${alex.name}`}>
            <TranscriptHeader
              left={`Today at 11:42 am, signed requests from ${alex.name}`}
              right="Notes from the checks sit under each message. Select one for the full trace."
            />
            <TurnRows turns={alex.turns} onOpenTrace={fn()} agentName={alex.name} notes={{ [firstRequest]: SIGNED_NOTE }} />
          </Transcript>
          <TakeOverBar mode="ai" agent visitorName={alex.name} ownerName={rivera.business.ownerName} onTakeOver={fn()} onHandBack={fn()} onResume={fn()} />
          <Composer variant="whisper" label="Whisper to Claude" placeholder="Whisper to Claude. The agent won’t see it." onSend={fn()} />
          <ConceptFooter />
        </div>
      </ConversationsPage>
    </RiveraFrame>
  );
}

const meta = {
  title: 'Boards/Conversation, agent',
  render: () => <ConversationAgent />,
  parameters: {
    layout: 'fullscreen',
    canvas: 'N-Conv-Agent-Run1',
    canvasNote: [
      "The conversation is the Turner fixture's agent chat: a quote for the deposit, then the charge to the signed limit, where the board adds a request for open times and a booking between them.",
      'Its receipts are the kernel’s status lines from the fixture, attached under each message on its side; the board writes some in owner wording.',
      'The signed limit is SignedLimitPanel, as the board draws it: per charge, in total, what the agent has used and for how long, in the screen’s words from the mandate, with whose wallet signed it at the right.',
      'The list column and the conversation head are composed as on the live conversation board (AppShell fill).',
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
    expectComputed(canvas.getByRole('heading', { level: 2, name: alex.name }), { fontSize: '16px', lineHeight: '21px', fontWeight: '520' });
    const list = canvas.getByRole('navigation', { name: 'Conversations' });
    await expect(within(list).getByRole('link', { current: true })).toHaveTextContent(alex.name);

    // The signed limit sits above the requests, in the card look, padded 12 px 16 px as the board draws it,
    // with what the agent has used among its terms and whose wallet signed it at the right.
    const limit = canvas.getByRole('region', { name: 'Signed limit' });
    expectComputed(limit, { ...SPEC.card, paddingTop: '12px', paddingBottom: '12px', paddingLeft: '16px', paddingRight: '16px' });
    const limitTerms = [...limit.querySelectorAll('dl > div')].map((term) => [term.querySelector('dt')?.textContent, term.querySelector('dd')?.textContent]);
    await expect(limitTerms).toEqual([
      ['Per charge', '$20'],
      ['In total', '$100'],
      ['Used', '$20'],
      ['For', 'One hour'],
    ]);
    await expect(within(limit).getByText(LIMIT.source)).toBeVisible();
    // 10 px under the conversation's head, and no wider than the 640 px column, as on the board.
    const head = one(canvasElement, '.board-conversation-head');
    await expect(Math.round(limit.getBoundingClientRect().top - head.getBoundingClientRect().bottom)).toBe(10);
    await expect(Math.round(limit.getBoundingClientRect().width)).toBe(640);

    // Each signed request is on the right, its receipts under it ending at its edge; Claude's replies on the left.
    const log = canvas.getByRole('log', { name: `Conversation with ${alex.name}` });
    expectConversationType(log);
    await expect(await expectReceiptsUnderMessages(log)).toBeGreaterThanOrEqual(3);
    for (const request of log.querySelectorAll<HTMLElement>('.cd-agent-message__bubble')) {
      await expect(Math.round(request.getBoundingClientRect().right)).toBe(Math.round(log.getBoundingClientRect().left + 640));
    }
    await expect(within(log).getByText(SIGNED_NOTE)).toBeVisible();

    // An agent never receives what a visitor would see, so the bar says only the whisper line.
    await expect(canvas.queryByText(/sees “/)).toBeNull();
    const takeOver = canvas.getByRole('button', { name: 'Take over' });
    const whisper = canvas.getByRole('textbox', { name: 'Whisper to Claude' });
    expectComputed(one(canvasElement, '.cd-composer__box'), SPEC.composer);
    await expectFooter(canvasElement);

    // focus_order_is_logical.
    const column = canvas.getByRole('complementary', { name: 'Claude Desk' });
    await expectTabOrder(userEvent, [
      within(column).getByRole('button', { name: `Switch business, current: ${rivera.business.name}` }),
      ...within(within(column).getByRole('navigation', { name: 'Main' })).getAllByRole('link'),
      ...within(list).getAllByRole('link'),
      ...within(log).getAllByRole('button', { name: /Open the full trace/ }),
      takeOver,
      whisper,
    ]);
  },
};
